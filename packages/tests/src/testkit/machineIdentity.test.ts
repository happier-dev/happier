import { describe, expect, it } from 'vitest';
import {
  computeContentPublicKeyFingerprint,
  MachineInstallationProofV1Schema,
} from '@happier-dev/protocol';

import {
  buildMachineInstallationProof,
  createMachineInstallationIdentityFixture,
  verifyMachineInstallationProof,
} from './machineIdentity';

const fingerprintA = computeContentPublicKeyFingerprint(new Uint8Array([1, 2, 3, 4]));
const fingerprintB = computeContentPublicKeyFingerprint(new Uint8Array([4, 3, 2, 1]));

describe('machine identity testkit', () => {
  it('creates deterministic installation proofs for the same canonical payload', () => {
    const installation = createMachineInstallationIdentityFixture({
      installationId: 'install-test-1',
    });
    const first = buildMachineInstallationProof({
      installationId: installation.installationId,
      machineId: 'machine-new',
      replacesMachineId: 'machine-old',
      replacementReason: 'reauth',
      contentPublicKeyFingerprint: fingerprintA,
      privateKeyBase64: installation.privateKeyBase64,
    });
    const second = buildMachineInstallationProof({
      installationId: installation.installationId,
      machineId: 'machine-new',
      replacesMachineId: 'machine-old',
      replacementReason: 'reauth',
      contentPublicKeyFingerprint: fingerprintA,
      privateKeyBase64: installation.privateKeyBase64,
    });

    expect(second).toEqual(first);
    expect(MachineInstallationProofV1Schema.parse(first)).toEqual(first);
    expect(verifyMachineInstallationProof({
      installationId: installation.installationId,
      machineId: 'machine-new',
      replacesMachineId: 'machine-old',
      replacementReason: 'reauth',
      contentPublicKeyFingerprint: fingerprintA,
      proof: first,
      publicKeyBase64: installation.publicKeyBase64,
    })).toBe(true);
  });

  it('binds installation proofs to replacement target and encryption keyspace', () => {
    const installation = createMachineInstallationIdentityFixture({
      installationId: 'install-test-2',
    });
    const proof = buildMachineInstallationProof({
      installationId: installation.installationId,
      machineId: 'machine-new',
      replacesMachineId: 'machine-old',
      replacementReason: 'reauth',
      contentPublicKeyFingerprint: fingerprintA,
      privateKeyBase64: installation.privateKeyBase64,
    });

    expect(verifyMachineInstallationProof({
      installationId: installation.installationId,
      machineId: 'machine-new',
      replacesMachineId: 'machine-other',
      replacementReason: 'reauth',
      contentPublicKeyFingerprint: fingerprintA,
      proof,
      publicKeyBase64: installation.publicKeyBase64,
    })).toBe(false);
    expect(verifyMachineInstallationProof({
      installationId: installation.installationId,
      machineId: 'machine-new',
      replacesMachineId: 'machine-old',
      replacementReason: 'reauth',
      contentPublicKeyFingerprint: fingerprintB,
      proof,
      publicKeyBase64: installation.publicKeyBase64,
    })).toBe(false);
    expect(verifyMachineInstallationProof({
      installationId: installation.installationId,
      machineId: 'machine-new',
      replacesMachineId: 'machine-old',
      replacementReason: 'manual_repair',
      contentPublicKeyFingerprint: fingerprintA,
      proof,
      publicKeyBase64: installation.publicKeyBase64,
    })).toBe(false);
  });
});
