import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { PreparedPluginDevelopmentActivationGraph } from '@/plugins/authoring/sourceModule';
import { listQualifiedConnectedAccountsV4, QualifiedConnectedAccountCredentialConflictError, type deleteQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';

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
  const entryPath = await realpath(fileURLToPath(new URL('../../../../../packages/plugins/openai/src/manifest.ts', import.meta.url)));
  const rootPath = dirname(dirname(entryPath));
  const contributes = await resolveMergedContributionRegistry({ happyHomeDir });
  // Source tests have no packaged-runtime custody. Admit the real first-party
  // author graph through the same development-source seam as the daemon.
  const graph = {
    module: await import('@happier-dev/plugins-openai/manifest'), candidateScope: {}, rootPath, entryPath,
    sourceAuthority: { kind: 'development', registeredRootId: 'revoke-openai-source', canonicalRoot: rootPath, observedRevision: 0 },
  } satisfies PreparedPluginDevelopmentActivationGraph;
  const registry = await resolveExecutablePluginRuntimeRegistry({
    happyHomeDir,
    pluginIds: [service.pluginId],
    contributes: { ...contributes, activationTargets: contributes.activationTargets.map(target => target.pluginId === service.pluginId
      ? { ...target, devDaemonEntryPath: entryPath } : target) },
    preparedDevelopmentActivationGraphsByPluginId: new Map([[service.pluginId, graph]]),
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
  const readConfiguration = vi.fn(async () => null);
  const readCredential = vi.fn(async () => ({
    ref: account,
    authenticationModeId: 'api-key',
    revisionSemantics: 'revisioned' as const,
    credentialRevision,
    configurationRevision: null,
    content: sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential', accountMode: 'plain', payload: { v: 1, values: { token: 'sk-current' } },
      randomBytes: length => new Uint8Array(length),
    }),
    metadata: { scopes: [] },
  }));
  const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({
    reloadController: {
      async acquireRuntimeRegistry() {
        return {
          registry,
          source: 'active' as const,
          durableRevision: registry.durableRevision ?? -1,
          release: vi.fn(async () => undefined),
        };
      },
      isRuntimeRegistryCurrent(candidate: typeof registry) {
        return generationCurrent && candidate === registry;
      },
    },
    credentials,
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    readCredential,
    readConfiguration,
    configuration: {
      read: vi.fn(async () => null),
      secrets: {
        admit: vi.fn(async () => undefined),
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
    readConfiguration,
    readCredential,
    setGenerationCurrent(value: boolean) {
      generationCurrent = value;
    },
  };
}

describe('revokeQualifiedConnectedAccount', () => {
  it('refuses replacement of the presented credential revision while revocation waits for approval', async () => {
    const harness = await createHarness();
    // The public profile HTTP read is the boundary. Its production parser
    // supplies the same presented revision consumed by Settings/describeService.
    const profileTransport = vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: { service, accounts: [{
      ref: account, status: 'connected', authenticationModeId: 'api-key', configurationReady: true,
      configurationRevision: null, scopes: [], revisionSemantics: 'revisioned', credentialRevision,
    }] } });
    let presented: Awaited<ReturnType<typeof listQualifiedConnectedAccountsV4>>['accounts'][number] | undefined;
    try {
      presented = (await listQualifiedConnectedAccountsV4({ token: harness.credentials.token, service })).accounts[0];
    } finally {
      profileTransport.mockRestore();
    }
    if (!presented || presented.revisionSemantics !== 'revisioned') throw new Error('Presented credential revision is unavailable');
    const previous = await harness.readCredential();
    harness.readCredential.mockResolvedValue({ ...previous, credentialRevision: 'csr_zyxwvutsrqponmlkjihgfe' });
    // Approval authorizes the presented K, not whichever replacement the daemon
    // finds when consent arrives. All established-runtime logic remains real.
    const reviewedRevoke = {
      account: presented.ref, expectedCredentialRevision: presented.credentialRevision,
      cleanupGroupReferences: false, token: harness.credentials.token,
      resolveV4Support: () => 'advertised' as const,
      resolveRemovalReviewSupport: () => 'advertised' as const,
      establishedRuntimeOwner: harness.owner, deleteCredential: harness.deleteCredential,
    };
    await expect(revokeQualifiedConnectedAccount(reviewedRevoke)).rejects.toMatchObject({ code: 'connect_credential_mutation_superseded' });
    expect(harness.readConfiguration).not.toHaveBeenCalled();
    expect(harness.deleteCredential).not.toHaveBeenCalled();
  });
  it('reviews native custody before any ordinary provider revoke', async () => {
    const harness = await createHarness();
    const reviewError = Object.assign(new Error('Resource review required'), { code: 'managed_resources_review_required' });
    const deleteCredential = vi.fn(async () => { throw reviewError; });
    await expect(revokeQualifiedConnectedAccount({
      account, cleanupGroupReferences: true, token: harness.credentials.token,
      resolveV4Support: () => 'advertised', resolveRemovalReviewSupport: () => 'advertised',
      establishedRuntimeOwner: harness.owner, deleteCredential,
    })).rejects.toBe(reviewError);
    // Configuration is a real server read beneath the established-runtime owner.
    // Revision-only preflight never opens a provider invocation's configuration.
    expect(harness.readConfiguration).not.toHaveBeenCalled();
    expect(deleteCredential).toHaveBeenCalledWith(expect.objectContaining({ deletion: expect.objectContaining({
      expectedCredentialRevision: credentialRevision, reviewOnly: true,
    }) }));
  });
  it('revokes the exact local credential in an emergency without admitting a provider invocation', async () => {
    const harness = await createHarness();
    harness.readConfiguration.mockRejectedValueOnce(new Error('Provider runtime unavailable'));

    await expect(revokeQualifiedConnectedAccount({
      account, cleanupGroupReferences: false, token: harness.credentials.token,
      resolveV4Support: () => 'advertised', resolveRemovalReviewSupport: () => 'advertised',
      emergencyRevoke: true, establishedRuntimeOwner: harness.owner, deleteCredential: harness.deleteCredential,
    })).resolves.toEqual({ status: 'deleted', remoteStatus: 'remoteNotAttempted' });

    expect(harness.readConfiguration).not.toHaveBeenCalled();
    expect(harness.deleteCredential).toHaveBeenCalledWith({
      token: harness.credentials.token,
      deletion: { ref: account, expectedCredentialRevision: credentialRevision, cleanupGroupReferences: false, emergencyRevoke: true },
    });
  });
  it('retains newly reported native custody when exact credential CAS follows asynchronous preparation', async () => {
    const harness = await createHarness();
    let retainedResourceAppeared = false;
    let localCredentialPresent = true;
    const readCurrentCredential = harness.readCredential.getMockImplementation();
    if (!readCurrentCredential) throw new Error('Credential network boundary is unavailable');
    // The initial credential-only read precedes review. A real server read in
    // established-runtime preparation then observes unchanged K but new custody.
    harness.readCredential.mockImplementationOnce(readCurrentCredential).mockImplementationOnce(async () => {
      retainedResourceAppeared = true;
      return await readCurrentCredential();
    });
    const resources = [{ managedId: 'native-after-preparation', homeId: 'home-1', custodianAccountId: 'owner-1', intentRevision: 0,
      controller: { machineId: 'controller-1', installationId: 'installation-1' }, provider: { pluginId: 'acme.compute', localId: 'cloud' },
      allocation: 'may-exist' as const, recovery: { reference: 'new-native-resource', reason: 'manual_recovery' } }];
    const reviewError = new QualifiedConnectedAccountCredentialConflictError('managed_resources_review_required', resources);
    const deleteCredential = vi.fn(async (input: Parameters<typeof deleteQualifiedConnectedAccountCredentialV4>[0]) => {
      if (retainedResourceAppeared) throw reviewError;
      if (input.deletion.reviewOnly) return { status: 'ready' as const };
      localCredentialPresent = false;
      return { success: true as const };
    });
    await expect(revokeQualifiedConnectedAccount({ account, cleanupGroupReferences: true, token: harness.credentials.token,
      resolveV4Support: () => 'advertised', resolveRemovalReviewSupport: () => 'advertised',
      establishedRuntimeOwner: harness.owner, deleteCredential,
    })).rejects.toBe(reviewError);
    expect(reviewError.resources).toEqual(resources);
    expect(localCredentialPresent).toBe(true);
  });
  it('fails closed before the remote revoke leaf when atomic V4 support is absent', async () => {
    const harness = await createHarness();

    await expect(revokeQualifiedConnectedAccount({
      account,
      cleanupGroupReferences: true,
      token: harness.credentials.token,
      resolveV4Support: () => 'absent',
      resolveRemovalReviewSupport: () => 'absent',
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
      resolveRemovalReviewSupport: () => 'absent',
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
      'invokeWithReceipt' | 'readCredentialRevision'
    >;

    await expect(revokeQualifiedConnectedAccount({
      account,
      cleanupGroupReferences: false,
      token: harness.credentials.token,
      resolveV4Support: () => 'advertised',
      resolveRemovalReviewSupport: () => 'absent',
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
      resolveRemovalReviewSupport: () => 'absent',
      establishedRuntimeOwner: harness.owner,
      deleteCredential: harness.deleteCredential,
    })).rejects.toThrow();

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
      'invokeWithReceipt' | 'readCredentialRevision'
    >;

    const pending = revokeQualifiedConnectedAccount({
      account,
      cleanupGroupReferences: false,
      token: harness.credentials.token,
      resolveV4Support: () => support,
      resolveRemovalReviewSupport: () => 'absent',
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
      'invokeWithReceipt' | 'readCredentialRevision'
    >;

    await expect(revokeQualifiedConnectedAccount({
      account,
      cleanupGroupReferences: false,
      token: harness.credentials.token,
      resolveV4Support: () => support,
      resolveRemovalReviewSupport: () => 'absent',
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
