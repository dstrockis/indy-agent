'use strict';
const sdk = require('indy-sdk');
const indy = require('../../index.js');

const MESSAGE_TYPES = {
    OFFER: "urn:sovrin:agent:message_type:sovrin.org/credential_offer",
    REQUEST: "urn:sovrin:agent:message_type:sovrin.org/credential_request",
    CREDENTIAL: "urn:sovrin:agent:message_type:sovrin.org/credential"
};
exports.MESSAGE_TYPES = MESSAGE_TYPES;

exports.handlers = require('./handlers');

exports.getAll = async function () {
    return await sdk.proverGetCredentials(await indy.wallet.get(), {});
};

exports.sendOffer = async function (theirDid, credentialDefinitionId, credentialData) {
    if(theirDid === '_self_') {
        return issueCredentialToSelf(credentialDefinitionId, credentialData);
    }
    else {
      let credOffer = await sdk.issuerCreateCredentialOffer(await indy.wallet.get(), credentialDefinitionId);
      try {
        credOffer.data = JSON.parse(credentialData);
      } catch (e) {
        credOffer.data = {};
        console.log(e);
      }
      await indy.store.pendingCredentialOffers.write(credOffer);
      let pairwise = await sdk.getPairwise(await indy.wallet.get(), theirDid);
      let myDid = pairwise.my_did;

      console.log(`Danny: Credential Offer:`)
      console.log(JSON.stringify(credOffer))

      let message = await indy.crypto.buildAuthcryptedMessage(myDid, theirDid, MESSAGE_TYPES.OFFER, credOffer);
      let meta = JSON.parse(pairwise.metadata);
      let theirEndpointDid = meta.theirEndpointDid;
      return indy.crypto.sendAnonCryptedMessage(theirEndpointDid, message);
    }
};

exports.sendRequest = async function (theirDid, encryptedMessage) {
    let myDid = await indy.pairwise.getMyDid(theirDid);
    let credentialOffer = await indy.crypto.authDecrypt(myDid, encryptedMessage);
    let [, credentialDefinition] = await indy.issuer.getCredDef(await indy.pool.get(), await indy.did.getEndpointDid(), credentialOffer.cred_def_id); // FIXME: Was passing in myDid. Why?
    let masterSecretId = await indy.did.getEndpointDidAttribute('master_secret_id');
    let [credRequestJson, credRequestMetadataJson] = await sdk.proverCreateCredentialReq(await indy.wallet.get(), myDid, credentialOffer, credentialDefinition, masterSecretId);
    indy.store.pendingCredentialRequests.write(credRequestJson, credRequestMetadataJson);

    console.log(`Danny: Credential Request:`)
    console.log(JSON.stringify(credRequestJson))

    let message = await indy.crypto.buildAuthcryptedMessage(myDid, theirDid, MESSAGE_TYPES.REQUEST, credRequestJson);
    let theirEndpointDid = await indy.did.getTheirEndpointDid(theirDid);
    return indy.crypto.sendAnonCryptedMessage(theirEndpointDid, message);
};

exports.acceptRequest = async function(theirDid, encryptedMessage) {
    let myDid = await indy.pairwise.getMyDid(theirDid);
    let credentialRequest = await indy.crypto.authDecrypt(myDid, encryptedMessage,);

    let [, credDef] = await indy.issuer.getCredDef(await indy.pool.get(), await indy.did.getEndpointDid(), credentialRequest.cred_def_id);

    let credentialOffer;
    let pendingCredOfferId;
    let pendingCredOffers = indy.store.pendingCredentialOffers.getAll();
    for(let pendingCredOffer of pendingCredOffers) {
        if(pendingCredOffer.offer.cred_def_id === credDef.id) {
            pendingCredOfferId = pendingCredOffer.id;
            credentialOffer = pendingCredOffer.offer;
        }
    }
    let schema = await indy.issuer.getSchema(credentialOffer.schema_id);

    let credentialValues = {};
    for(let attr of schema.attrNames) {
        if(credentialOffer.data[attr]) {
          credentialValues[attr] = {raw: credentialOffer.data[attr], encoded: indy.credentials.encode(credentialOffer.data[attr])};
        }
    }

    console.log(credentialValues);

    let [credential] = await sdk.issuerCreateCredential(await indy.wallet.get(), credentialOffer, credentialRequest, credentialValues, null, -1);

    console.log(`Danny: Credential Issuance:`)
    console.log(JSON.stringify(credential))

    let message = await indy.crypto.buildAuthcryptedMessage(myDid, theirDid, MESSAGE_TYPES.CREDENTIAL, credential);
    let theirEndpointDid = await indy.did.getTheirEndpointDid(theirDid);
    await indy.crypto.sendAnonCryptedMessage(theirEndpointDid, message);
    indy.store.pendingCredentialOffers.delete(pendingCredOfferId);
};

exports.acceptCredential = async function(theirDid, encryptedMessage) {
    let myDid = await indy.pairwise.getMyDid(theirDid);
    let credential = await await indy.crypto.authDecrypt(myDid, encryptedMessage);

    let credentialRequestMetadata;
    let pendingCredentialRequests = indy.store.pendingCredentialRequests.getAll();
    for(let pendingCredReq of pendingCredentialRequests) {
        if(pendingCredReq.credRequestJson.cred_def_id === credential.cred_def_id) { // FIXME: Check for match
            credentialRequestMetadata = pendingCredReq.credRequestMetadataJson;
        }
    }

    let [, credentialDefinition] = await indy.issuer.getCredDef(await indy.pool.get(), await indy.did.getEndpointDid(), credential.cred_def_id);
    await sdk.proverStoreCredential(await indy.wallet.get(), null, credentialRequestMetadata, credential, credentialDefinition);
    let credentials = await indy.credentials.getAll();

    console.log(`Danny: All Credentials After Storage:`)
    console.log(JSON.stringify(credentials));
};

exports.encode = function(string) {
    console.log(string);
    if(!string) {
        return string;
    }
    let newString = Buffer.from(string.toString(),'utf8').toString();
    let number = "1";
    let length = newString.length;
    for (let i = 0; i < length; i++) {
        let codeValue = newString.charCodeAt(i).toString(10);
        if(codeValue.length < 3) {
            codeValue = "0" + codeValue;
        }
        number += codeValue;
    }
    console.log(number);
    return number;
};

exports.decode = function(number) {
    console.log(number);
    if(!number) return number;
    let string = "";
    number = number.slice(1); // remove leading 1
    let length = number.length;

    for (let i = 0; i < length;) {
        let code = number.slice(i, i += 3);
        string += String.fromCharCode(parseInt(code, 10));
    }
    console.log(string);
    return string;
};

async function issueCredentialToSelf(credentialDefinitionId, credentialData) {
  try {
    let endpointDID = await indy.did.getEndpointDid();
    let wallet = await indy.wallet.get();
    let pool = await indy.pool.get();
    let credentialOffer = await sdk.issuerCreateCredentialOffer(wallet, credentialDefinitionId);
    try {
      credentialOffer.data = JSON.parse(credentialData);
    } catch (e) {
      credentialOffer.data = {};
      console.log(e);
    }
    let [, credentialDefinition] = await indy.issuer.getCredDef(pool, endpointDID, credentialOffer.cred_def_id);
    let masterSecretId = await indy.did.getEndpointDidAttribute('master_secret_id');
    let [credRequestJson, credRequestMetadataJson] = await sdk.proverCreateCredentialReq(wallet, endpointDID, credentialOffer, credentialDefinition, masterSecretId);
    let schema = await indy.issuer.getSchema(credentialOffer.schema_id);

    let credentialValues = {};
    for (let attr of schema.attrNames) {
      if (credentialOffer.data[attr]) {
        credentialValues[attr] = {raw: credentialOffer.data[attr], encoded: indy.credentials.encode(credentialOffer.data[attr])};
      }
    }
    let [credential] = await sdk.issuerCreateCredential(wallet, credentialOffer, credRequestJson, credentialValues);
    await sdk.proverStoreCredential(wallet, null, credRequestMetadataJson, credential, credentialDefinition);
  } catch (e) {
      console.log(e);
  }
}