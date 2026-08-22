import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from './qualifiedConnectedAccountEstablishedRuntimeOwner';
import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
} from './qualifiedConnectedAccountEstablishedRuntimeOwner';
import {
  decideQualifiedConnectedAccountRevocationSettlement,
  revokeQualifiedConnectedAccount,
} from './revokeQualifiedConnectedAccount';

const service = Object.freeze({
  pluginId: 'happier.voice.openai',
  localId: 'openai',
});
const account = Object.freeze({ service, accountId: 'work' });
const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
const createdDirectories: string[] = [];
const createdRegistries: Array<Readonly<{ dispose(): Promise<void> }>> = [];

afterEach(async () => {
  await Promise.all(createdRegistries.splice(0).map(async (registry) => {
    await registry.dispose();
  }));
  await Promise.all(createdDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

async function createHarness() {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-qualified-revoke-'));
  createdDirectories.push(happyHomeDir);
  const registry = await resolveExecutablePluginRuntimeRegistry({
    happyHomeDir,
    pluginIds: [service.pluginId],
  });
  createdRegistries.push(registry);
  let generationCurrent = true;
  const credentials: Credentials = {
    token: 'happier-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(3),
    },
  };
  const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
    reloadController: {
      async acquireRuntimeRegistry() {
        return {
          registry,
          source: 'active' as const,
          release: vi.fn(async () => undefined),
        };
      },
      isRuntimeRegistryCurrent(candidate: typeof registry) {
        return generationCurrent && candidate === registry;
      },
    },
    credentials,
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    readCredential: vi.fn(async () => ({
      ref: account,
      authenticationModeId: 'api-key',
      revisionSemantics: 'revisioned' as const,
      credentialRevision,
      configurationRevision: null,
      content: sealQualifiedConnectedAccountContentEnvelope({
        kind: 'credential',
        accountMode: 'plain',
        payload: { v: 1, values: { token: 'sk-current' } },
        randomBytes: (length) => new Uint8Array(length),
      }),
      metadata: { scopes: [] },
    })),
    readConfiguration: vi.fn(async () => null),
    configuration: {
      read: vi.fn(async () => null),
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    },
  });
  const deleteCredential = vi.fn(async () => ({ success: true as const }));
  return {
    credentials,
    owner,
    deleteCredential,
    setGenerationCurrent(value: boolean) {
      generationCurrent = value;
    },
  };
}

describe('revokeQualifiedConnectedAccount', () => {
  it('fails closed before the remote revoke leaf when atomic V4 support is absent', async () => {
    const harness = await createHarness();

    await expect(revokeQualifiedConnectedAccount({
      account,
      cleanupGroupReferences: true,
      token: harness.credentials.token,
      resolveV4Support: () => 'absent',
      establishedRuntimeOwner: harness.owner,
      deleteCredential: harness.deleteCredential,
    })).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });

    expect(harness.deleteCredential).not.toHaveBeenCalled();
  });

  it('runs the current plugin revoke leaf and settles local deletion through exact K credential CAS', async () => {
    const harness = await createHarness();

    await expect(revokeQualifiedConnectedAccount({
      account,
      cleanupGroupReferences: true,
      token: harness.credentials.token,
      resolveV4Support: () => 'advertised',
      establishedRuntimeOwner: harness.owner,
      deleteCredential: harness.deleteCredential,
    })).resolves.toEqual({
      status: 'deleted',
      remoteStatus: 'remoteUnsupported',
    });

    expect(harness.deleteCredential).toHaveBeenCalledOnce();
    expect(harness.deleteCredential).toHaveBeenCalledWith({
      token: 'happier-token',
      deletion: {
        ref: account,
        expectedCredentialRevision: credentialRevision,
        cleanupGroupReferences: true,
      },
    });
  });

  it('settles as revoked when the plugin generation rolls after the deletion commits', async () => {
    const harness = await createHarness();
    let generationCurrent = true;
    const deleteCredential = vi.fn(async () => {
      generationCurrent = false;
      return { success: true as const };
    });
    const establishedRuntimeOwner = {
      invokeWithReceipt: vi.fn(async () => ({
        result: { status: 'remoteRevoked' as const },
        basis: {
          credentialRevision,
          credentialConfigurationRevision: null,
          runtimeConfigurationRevision: 'unconfigured',
          generation: 'generation-1',
          immutableGenerationId: 'artifact-1',
          isCurrent: () => generationCurrent,
          prepareCredentialReplacement: () => {
            throw new Error('not used by revoke');
          },
        },
      })),
    } as unknown as Pick<
      QualifiedConnectedAccountEstablishedRuntimeOwner,
      'invokeWithReceipt'
    >;

    await expect(revokeQualifiedConnectedAccount({
      account,
      cleanupGroupReferences: false,
      token: harness.credentials.token,
      resolveV4Support: () => 'advertised',
      establishedRuntimeOwner,
      deleteCredential,
    })).resolves.toEqual({
      status: 'deleted',
      remoteStatus: 'remoteRevoked',
    });

    expect(deleteCredential).toHaveBeenCalledOnce();
  });

  it('does not delete after the plugin generation becomes stale', async () => {
    const harness = await createHarness();
    harness.setGenerationCurrent(false);

    await expect(revokeQualifiedConnectedAccount({
      account,
      cleanupGroupReferences: false,
      token: harness.credentials.token,
      resolveV4Support: () => 'advertised',
      establishedRuntimeOwner: harness.owner,
      deleteCredential: harness.deleteCredential,
    })).rejects.toThrow('no longer current');

    expect(harness.deleteCredential).not.toHaveBeenCalled();
  });

  it('rechecks V4 admission at plugin issuance after an advertised peer downgrades', async () => {
    const harness = await createHarness();
    let support: 'advertised' | 'absent' = 'advertised';
    let enterInvocation!: () => void;
    const invocationEntered = new Promise<void>((resolve) => {
      enterInvocation = resolve;
    });
    let releaseInvocation!: () => void;
    const invocationGate = new Promise<void>((resolve) => {
      releaseInvocation = resolve;
    });
    const establishedRuntimeOwner = {
      invokeWithReceipt: vi.fn(async (
        input: Readonly<{
          assertEffectfulOperationAllowed?: () => void;
        }>,
      ) => {
        enterInvocation();
        await invocationGate;
        input.assertEffectfulOperationAllowed?.();
        return {
          result: { status: 'remoteUnsupported' as const },
          basis: {
            credentialRevision,
            credentialConfigurationRevision: null,
            runtimeConfigurationRevision: 'unconfigured',
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            isCurrent: () => true,
            prepareCredentialReplacement: () => {
              throw new Error('not used by revoke');
            },
          },
        };
      }),
    } as unknown as Pick<
      QualifiedConnectedAccountEstablishedRuntimeOwner,
      'invokeWithReceipt'
    >;

    const pending = revokeQualifiedConnectedAccount({
      account,
      cleanupGroupReferences: false,
      token: harness.credentials.token,
      resolveV4Support: () => support,
      establishedRuntimeOwner,
      deleteCredential: harness.deleteCredential,
    });
    await invocationEntered;
    support = 'absent';
    releaseInvocation();

    await expect(pending).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });
    expect(harness.deleteCredential).not.toHaveBeenCalled();
  });

  it('retains the local credential when V4 admission disappears after remote settlement', async () => {
    const harness = await createHarness();
    let support: 'advertised' | 'absent' = 'advertised';
    const establishedRuntimeOwner = {
      invokeWithReceipt: vi.fn(async () => {
        support = 'absent';
        return {
          result: { status: 'remoteUnsupported' as const },
          basis: {
            credentialRevision,
            credentialConfigurationRevision: null,
            runtimeConfigurationRevision: 'unconfigured',
            generation: 'generation-1',
            immutableGenerationId: 'artifact-1',
            isCurrent: () => true,
            prepareCredentialReplacement: () => {
              throw new Error('not used by revoke');
            },
          },
        };
      }),
    } as unknown as Pick<
      QualifiedConnectedAccountEstablishedRuntimeOwner,
      'invokeWithReceipt'
    >;

    await expect(revokeQualifiedConnectedAccount({
      account,
      cleanupGroupReferences: false,
      token: harness.credentials.token,
      resolveV4Support: () => support,
      establishedRuntimeOwner,
      deleteCredential: harness.deleteCredential,
    })).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });
    expect(harness.deleteCredential).not.toHaveBeenCalled();
  });

  it('keeps outcome-unknown revocation separate from guarded local deletion', () => {
    expect(decideQualifiedConnectedAccountRevocationSettlement({
      status: 'outcomeUnknown',
      diagnostic: {
        code: 'remote_outcome_unknown',
        severity: 'error',
        message: 'Remote revocation could not be settled.',
      },
    })).toEqual({ status: 'outcome_unknown' });
  });
});
