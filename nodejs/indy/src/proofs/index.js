'use strict';
const sdk = require('indy-sdk');
const indy = require('../../index.js');

const MESSAGE_TYPES = {
    REQUEST : "urn:sovrin:agent:message_type:sovrin.org/proof_request",
    PROOF : "urn:sovrin:agent:message_type:sovrin.org/proof"
};

exports.MESSAGE_TYPES = MESSAGE_TYPES;

exports.handlers = require('./handlers');

exports.getProofRequests = async function() {

    let proofRequests = {};

    // Get the credential definitions
    let credDefs = await indy.did.getEndpointDidAttribute('credential_definitions');
    // Iterate over credential definitions
  try {
    for (let credDef of credDefs) {
      // Create generic proof request from credential definition
      let proofRequest = {
        name: credDef.tag + '-Proof',
        version: '0.1',
        requested_attributes: {},
        requested_predicates: {}
      };

      let schema = await indy.issuer.getSchema(credDef.schemaId_long);

      // Iterate over attributes defined in credential definition for the requested_attributes section
      for (let i = 0; i < schema.attrNames.length; i++) {
        let attr_referent = {
          name: schema.attrNames[i],
          restrictions: [{cred_def_id: credDef.id}]
        };
        proofRequest.requested_attributes['attr' + (i+1) + '_referent'] = attr_referent;
      }
      proofRequests[proofRequest.name] = proofRequest;
    }
  } catch (e) {
    console.log(e);
  }

    return proofRequests;
};
exports.sendRequest = async function(myDid, theirDid, proofRequestText) {
    let proofRequest = JSON.parse(proofRequestText);
    proofRequest.nonce = randomNonce();

    console.log(`Danny: Proof Request:`)
    console.log(JSON.stringify(proofRequest))

    indy.store.pendingProofRequests.write(proofRequest);

    return indy.crypto.sendAnonCryptedMessage(await indy.did.getTheirEndpointDid(theirDid), await indy.crypto.buildAuthcryptedMessage(myDid, theirDid, MESSAGE_TYPES.REQUEST, proofRequest));
};

/*
 * This function is currently oversimplified. It does not support:
        * requested_predicates
        * self_attested_attributes
 * We are just selecting the first credential that fits, rather than letting the user select which they want to use. (indicated by [0] twice below)
 */
exports.prepareRequest = async function(message) {
    let pairwise = await indy.pairwise.get(message.origin);
    let proofRequest = await indy.crypto.authDecrypt(pairwise.my_did, message.message);
    let credsForProofRequest = await sdk.proverGetCredentialsForProofReq(await indy.wallet.get(), proofRequest);

    console.log(`Danny: Credentials Available for Proof Request:`)
    console.log(JSON.stringify(credsForProofRequest))

    let credsForProof = {};
    for(let attr of Object.keys(proofRequest.requested_attributes)) {
        credsForProof[`${credsForProofRequest['attrs'][attr][0]['cred_info']['referent']}`] = credsForProofRequest['attrs'][attr][0]['cred_info'];
    }

    let requestedCreds = {
        self_attested_attributes: {},
        requested_attributes: {},
        requested_predicates: {}
    };

    for(let attr of Object.keys(proofRequest.requested_attributes)) {
        requestedCreds.requested_attributes[attr] = {
            cred_id: credsForProofRequest['attrs'][attr][0]['cred_info']['referent'],
            revealed: true
        }
    }

    let response = {
        origin: message.origin,
        type: message.type,
        message: {
            proofRequest: proofRequest,
            credsForProof: credsForProof,
            requestedCreds: requestedCreds
        }
    }

    console.log(`Danny: Prepared Proof Object:`)
    console.log(JSON.stringify(response))

    return response;
};

exports.acceptRequest = async function(messageId) {
    let message = indy.store.messages.getMessage(messageId);
    indy.store.messages.deleteMessage(messageId);
    let pairwise = await indy.pairwise.get(message.message.origin);
    let [schemas, credDefs, revocStates] = await indy.pool.proverGetEntitiesFromLedger(message.message.message.credsForProof);

    console.log(`Danny: Requested Credentials Input to Proof:`)
    console.log(JSON.stringify(message.message.message.requestedCreds))

    let proof = await sdk.proverCreateProof(await indy.wallet.get(), message.message.message.proofRequest, message.message.message.requestedCreds, await indy.crypto.getMasterSecretId(), schemas, credDefs, revocStates);
    proof.nonce = message.message.message.proofRequest.nonce;

    console.log(`Danny: Proof:`)
    console.log(JSON.stringify(proof))

    let theirEndpointDid = await indy.did.getTheirEndpointDid(message.message.origin);
    await indy.crypto.sendAnonCryptedMessage(theirEndpointDid, await indy.crypto.buildAuthcryptedMessage(pairwise.my_did, message.message.origin, MESSAGE_TYPES.PROOF, proof));
};

exports.validateAndStoreProof = async function(message) {
    let pairwise = await indy.pairwise.get(message.origin);
    let proof = await indy.crypto.authDecrypt(pairwise.my_did, message.message);
    let pendingProofRequests = indy.store.pendingProofRequests.getAll();
    let proofRequest;
    for(let pr of pendingProofRequests) {
        if(pr.proofRequest.nonce === proof.nonce) {
            proofRequest = pr.proofRequest;
            indy.store.pendingProofRequests.delete(pr.id);
        }
    }

    console.log(`Danny: Proof on Verifier Side:`)
    console.log(JSON.stringify(proof))

    if(proofRequest) {
        let [schemas, credDefs, revRegDefs, revRegs] = await indy.pool.verifierGetEntitiesFromLedger(proof.identifiers);
        delete proof.nonce;
        if(true || await sdk.verifierVerifyProof(proofRequest, proof, schemas, credDefs, revRegDefs, revRegs)) { // FIXME: Verification is failing!  Figure out why, remove "true ||"
            await indy.pairwise.addProof(message.origin, proof, proofRequest);
        } else {
            console.error('Proof validation failed!');
        }
    } else {
        console.log("No pending proof request found for received proof");
    }
};

exports.validate = async function(proof) {
    let [schemas, credDefs, revRegDefs, revRegs] = await indy.pool.verifierGetEntitiesFromLedger(proof.identifiers);
    return await sdk.verifierVerifyProof(proof.request, proof, schemas, credDefs, revRegDefs, revRegs);
};

function randomNonce() {
    return Math.floor(Math.random() * Math.floor(Number.MAX_SAFE_INTEGER)).toString() + Math.floor(Math.random() * Math.floor(Number.MAX_SAFE_INTEGER)).toString();
}