import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { verifyMachineInstallationProof } from '../identity/installationIdentity.js';
import { createManagedPolicyProofV1, createManagedPolicyCensusProofV1, decodeManagedPolicyProofV1, encodeManagedPolicyProofV1, managedPolicyDigestV1 } from './managedPolicyV1.js';

describe('managed host policy installation proof', () => {
  it('binds the automatic census to the actual Home and controller installation', () => {
    const keys = tweetnacl.sign.keyPair();
    const payload = { version: 1 as const, machineId: 'controller', installationId: 'installation', accountId: 'custodian', managedPolicyCensus: { homeId: 'home' } };
    const proof = createManagedPolicyCensusProofV1({ homeId: 'home', controller: { machineId: 'controller', installationId: 'installation' }, custodianAccountId: 'custodian', privateKey: keys.secretKey });
    expect(verifyMachineInstallationProof({ payload, proof, publicKey: keys.publicKey })).toBe(true);
    expect(verifyMachineInstallationProof({ payload: { ...payload, managedPolicyCensus: { homeId: 'other-home' } }, proof, publicKey: keys.publicKey })).toBe(false);
  });
  it('binds exact native identity, accepted origin and HTTP bytes without a public Action envelope', () => {
    const keys = tweetnacl.sign.keyPair();
    const correlation = { homeId: 'home', managedId: 'retained', expectedIntentRevision: 2,
      requestId: 'policy-request', controller: { machineId: 'controller', installationId: 'installation' } };
    const resource = { contributionRef: { pluginId: 'fixture.compute', localId: 'compute' }, schemaVersion: 1, value: { id: 'native' } };
    const purpose = { kind: 'accepted-input-start' as const, target: { homeId: 'home', managedId: 'retained',
      expectedIntentRevision: 2, enrolledMachineId: 'guest', controller: correlation.controller,
      origin: { kind: 'workflow-assignment' as const, runId: 'run', revision: 3, assignment: { machineId: 'guest' } }, reason: 'admitted-work' as const } };
    const body = { ...correlation, purpose };
    const carrier = createManagedPolicyProofV1({ correlation, purpose, resource, custodianAccountId: 'custodian',
      path: '/v1/machines/managed/controller/admit-policy', body, privateKey: keys.secretKey });
    expect(decodeManagedPolicyProofV1(encodeManagedPolicyProofV1(carrier))).toEqual(carrier);
    expect(verifyMachineInstallationProof({ payload: carrier.payload, proof: carrier.proof, publicKey: keys.publicKey })).toBe(true);
    for (const changes of [{ resourceDigest: managedPolicyDigestV1('resource', { ...resource, value: { id: 'other' } }) },
      { bodyDigest: managedPolicyDigestV1('body', { ...body, expectedIntentRevision: 3 }) },
      { purposeDigest: managedPolicyDigestV1('purpose', { ...purpose, target: { ...purpose.target, origin: { ...purpose.target.origin, runId: 'other' } } }) },
      { path: '/v1/machines/managed/controller/submit-intent' }]) {
      expect(verifyMachineInstallationProof({ payload: { ...carrier.payload, managedPolicy: { ...carrier.payload.managedPolicy!, ...changes } },
        proof: carrier.proof, publicKey: keys.publicKey })).toBe(false);
    }
  });
  it('binds canceled creation cleanup to the same exact controller, resource and HTTP proof', () => {
    const keys = tweetnacl.sign.keyPair();
    const correlation = { homeId: 'home', managedId: 'canceled-purchase', expectedIntentRevision: 1,
      requestId: 'cleanup-request', controller: { machineId: 'controller', installationId: 'installation' } };
    const resource = { contributionRef: { pluginId: 'fixture.compute', localId: 'compute' }, schemaVersion: 1, value: { id: 'paid-native' } };
    const purpose = { kind: 'creation-cleanup' as const };
    const body = { ...correlation, purpose };
    const carrier = createManagedPolicyProofV1({ correlation, purpose, resource, custodianAccountId: 'custodian',
      path: '/v1/machines/managed/controller/admit-policy', body, privateKey: keys.secretKey });
    expect(decodeManagedPolicyProofV1(encodeManagedPolicyProofV1(carrier))).toEqual(carrier);
    expect(verifyMachineInstallationProof({ payload: carrier.payload, proof: carrier.proof, publicKey: keys.publicKey })).toBe(true);
    expect(verifyMachineInstallationProof({ payload: { ...carrier.payload, managedPolicy: { ...carrier.payload.managedPolicy!,
      purpose: 'retention' } }, proof: carrier.proof, publicKey: keys.publicKey })).toBe(false);
    expect(verifyMachineInstallationProof({ payload: { ...carrier.payload, managedPolicy: { ...carrier.payload.managedPolicy!,
      resourceDigest: managedPolicyDigestV1('resource', { ...resource, value: { id: 'another-native' } }) } },
      proof: carrier.proof, publicKey: keys.publicKey })).toBe(false);
  });
  it('binds exact pending native attachments for canceled cleanup without a fabricated Machine resource', () => {
    const keys = tweetnacl.sign.keyPair();
    const correlation = { homeId: 'home', managedId: 'partial-purchase', expectedIntentRevision: 1,
      requestId: 'partial-cleanup', controller: { machineId: 'controller', installationId: 'installation' } };
    const nativeOperation = { contributionRef: { pluginId: 'fixture.compute', localId: 'compute' }, schemaVersion: 1,
      value: { appId: 'owned-app', volumeId: 'owned-volume' } };
    const purpose = { kind: 'creation-cleanup' as const };
    const carrier = createManagedPolicyProofV1({ correlation, purpose, nativeOperation, custodianAccountId: 'custodian',
      path: '/v1/machines/managed/controller/admit-policy', body: { ...correlation, purpose }, privateKey: keys.secretKey });
    expect(decodeManagedPolicyProofV1(encodeManagedPolicyProofV1(carrier))).toEqual(carrier);
    expect(verifyMachineInstallationProof({ payload: carrier.payload, proof: carrier.proof, publicKey: keys.publicKey })).toBe(true);
    expect(verifyMachineInstallationProof({ payload: { ...carrier.payload, managedPolicy: { ...carrier.payload.managedPolicy!,
      resourceDigest: managedPolicyDigestV1('resource', { ...nativeOperation, value: { appId: 'other-app' } }) } },
      proof: carrier.proof, publicKey: keys.publicKey })).toBe(false);
  });
});
