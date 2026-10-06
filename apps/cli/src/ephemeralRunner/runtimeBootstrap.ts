import { isDeepStrictEqual } from 'node:util';

import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { RunnerRuntimeBootstrapV1Schema } from '@happier-dev/protocol/ephemeralRunner/bootstrap';
import { computeRunnerMachineContentKeyFingerprintV1, verifyRunnerMachineContentKeyBindingV1 } from '@happier-dev/protocol/ephemeralRunner/machineContentKeyBinding';
import type { RunnerMachineContentKeyBindingV1 } from '@happier-dev/protocol/ephemeralRunner/machineContentKeyBinding';

export type VerifiedRunnerRuntimeBootstrap =
  | Readonly<{ mode: 'plain' }>
  | Readonly<{
      mode: 'e2ee';
      sessionDataEncryptionKey: Uint8Array;
      machineContentKey: Uint8Array;
    }>;

export function openVerifiedRunnerRuntimeBootstrap(input: Readonly<{
  bootstrap: unknown;
  expected: Readonly<{
    homeServerIdentityId: string;
    activationId: string;
    creatorAccountId: string;
    sessionId: string;
    machineId: string;
    installationId: string;
    launchManifestCommitment: string;
    reviewedMachineContentKeyBinding: RunnerMachineContentKeyBindingV1 | null;
    /**
     * Creator activation signing public key, derived locally from this
     * Runner's own activation package. It is never taken from a Home-relayed
     * field, and it needs no Account signing authority from the creator.
     */
    activationSigningPublicKeyBase64Url?: string;
  }>;
}>): VerifiedRunnerRuntimeBootstrap {
  const bootstrap = RunnerRuntimeBootstrapV1Schema.safeParse(input.bootstrap);
  if (!bootstrap.success) throw new Error('runner_runtime_bootstrap_invalid');
  const value = bootstrap.data;
  if (
    value.homeServerIdentityId !== input.expected.homeServerIdentityId
    || value.activationId !== input.expected.activationId
    || value.creatorAccountId !== input.expected.creatorAccountId
    || value.sessionId !== input.expected.sessionId
    || value.machineId !== input.expected.machineId
    || value.installationId !== input.expected.installationId
    || value.launchManifestCommitment !== input.expected.launchManifestCommitment
  ) {
    throw new Error('runner_runtime_bootstrap_binding_invalid');
  }
  const bootstrapBinding = value.machineContent.mode === 'e2ee' ? value.machineContent.binding : null;
  if (!isDeepStrictEqual(bootstrapBinding, input.expected.reviewedMachineContentKeyBinding)) {
    throw new Error('runner_runtime_bootstrap_binding_invalid');
  }
  if (value.machineContent.mode === 'plain') return { mode: 'plain' };

  // The schema couples storedContent and machineContent modes inside one union,
  // so an e2ee machine content always arrives with e2ee stored content. Narrow
  // explicitly instead of casting so a future schema divergence fails loudly.
  if (value.storedContent.mode !== 'e2ee') throw new Error('runner_runtime_bootstrap_invalid');
  const storedContent = value.storedContent;

  if (!input.expected.activationSigningPublicKeyBase64Url) {
    throw new Error('runner_runtime_bootstrap_binding_invalid');
  }

  const machineContentKey = decodeBase64(value.machineContent.machineContentKeyBase64Url, 'base64url');
  try {
    const verifiedBinding = verifyRunnerMachineContentKeyBindingV1({
      binding: value.machineContent.binding,
      expectedPayload: {
        v: 1,
        purpose: 'happier.ephemeral-runner.machine-content-key',
        homeServerIdentityId: input.expected.homeServerIdentityId,
        activationId: input.expected.activationId,
        creatorAccountId: input.expected.creatorAccountId,
        machineId: input.expected.machineId,
        installationId: input.expected.installationId,
        machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(machineContentKey),
      },
      expectedAccountSigningPublicKey: input.expected.activationSigningPublicKeyBase64Url,
    });
    if (!verifiedBinding) throw new Error('runner_runtime_bootstrap_binding_invalid');

    return {
      mode: 'e2ee',
      sessionDataEncryptionKey: decodeBase64(storedContent.sessionDataEncryptionKey, 'base64url'),
      machineContentKey,
    };
  } catch (error) {
    machineContentKey.fill(0);
    throw error;
  }
}
