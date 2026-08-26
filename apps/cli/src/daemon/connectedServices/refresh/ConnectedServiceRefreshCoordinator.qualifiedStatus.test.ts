import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildConnectedServiceCredentialRecord,
  sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';

const openAiService = Object.freeze({
  pluginId: 'happier.voice.openai',
  localId: 'openai',
});
const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
const now = 1_000_000;
const createdDirectories: string[] = [];
const createdRegistries: Array<Readonly<{
  dispose(): Promise<void>;
}>> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(createdRegistries.splice(0).map(async (registry) => {
    await registry.dispose();
  }));
  await Promise.all(createdDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

async function createHarness(input: Readonly<{
  generationCurrent?: boolean;
  pluginEnabled?: boolean;
  credentialAvailable?: boolean;
  v4Support?: 'advertised' | 'absent' | 'indeterminate';
  omitQualifiedRuntime?: boolean;
  legacyCredentialKind?: 'oauth' | 'token';
  acquireLegacyRefreshLease?: boolean;
}>) {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-qualified-status-'));
  createdDirectories.push(happyHomeDir);
  const registry = await resolveExecutablePluginRuntimeRegistry({
    happyHomeDir,
    pluginIds: input.pluginEnabled === false
      ? []
      : [openAiService.pluginId],
    ...(input.pluginEnabled === false
      ? { contributes: createResolvedContributionRegistry({}) }
      : {}),
  });
  createdRegistries.push(registry);
  let generationCurrent = input.generationCurrent ?? true;
  const reloadController = {
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
  };
  const credentials: Credentials = {
    token: 'happier-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(7),
    },
  };
  const credentialContent = sealQualifiedConnectedAccountContentEnvelope({
    kind: 'credential',
    accountMode: 'plain',
    payload: {
      v: 1,
      values: { token: 'sk-qualified-current' },
    },
    randomBytes: (length) => new Uint8Array(length),
  });
  const readQualifiedCredential = vi.fn(async () => (
    input.credentialAvailable === false
      ? null
      : {
          ref: {
            service: openAiService,
            accountId: 'work',
          },
          authenticationModeId: 'api-key',
          revisionSemantics: 'revisioned' as const,
          credentialRevision,
          configurationRevision: null,
          content: credentialContent,
          metadata: { scopes: [] },
        }
  ));
  const establishedRuntimeOwner =
    createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController,
      credentials,
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      readCredential: readQualifiedCredential,
      readConfiguration: vi.fn(async () => null),
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
    });
  const legacyRecord =
    input.legacyCredentialKind === 'oauth'
      ? buildConnectedServiceCredentialRecord({
          now,
          serviceId: 'openai-codex',
          profileId: 'work',
          kind: 'oauth',
          expiresAt: now - 1,
          oauth: {
            accessToken: 'expired-access',
            refreshToken: 'refresh-token',
            idToken: null,
            scope: null,
            tokenType: null,
            providerAccountId: null,
            providerEmail: null,
          },
        })
      : buildConnectedServiceCredentialRecord({
          now,
          serviceId: 'openai',
          profileId: 'work',
          kind: 'token',
          token: {
            token: 'sk-qualified-current',
            providerAccountId: null,
            providerEmail: null,
          },
        });
  const api = {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getConnectedServiceCredentialPlain: vi.fn(async () => ({
      content: { t: 'plain' as const, v: legacyRecord },
      revisionSemantics: 'revisioned' as const,
      credentialRevision,
    })),
    getConnectedServiceCredentialSealed: vi.fn(async () => null),
    acquireConnectedServiceRefreshLease: vi.fn(async () => (
      input.acquireLegacyRefreshLease
        ? {
            acquired: true as const,
            ownerId: 'machine-1',
            leaseUntil: now + 30_000,
            credentialRevision,
          }
        : {
            acquired: false as const,
            ownerId: 'machine-1',
            leaseUntil: now + 30_000,
            credentialRevision,
          }
    )),
  } as unknown as ApiClient;
  const mutateCredentialHealth = vi.fn(async (params: Readonly<{
    token: string;
    patch: unknown;
  }>) => {
    expect(params.token).toBe(credentials.token);
    return {
      success: true as const,
      credentialRevision,
      configurationRevision: null,
    };
  });
  const coordinator = new ConnectedServiceRefreshCoordinator({
    api,
    credentials,
    machineIdProvider: () => 'machine-1',
    activeServerDir: join(happyHomeDir, 'active'),
    baseDir: join(happyHomeDir, 'materialized'),
    refreshWindowMs: 60_000,
    refreshLeaseMs: 30_000,
    now: () => now,
    ...(input.omitQualifiedRuntime
      ? {}
      : {
          qualifiedConnectedAccountRuntime: {
            resolvePeerClass: () => (
                input.v4Support === 'absent'
                    ? 'revisioned_v2_v3'
                    : input.v4Support === 'indeterminate'
                        ? 'indeterminate'
                        : 'advertised_v4'
            ),
            establishedRuntimeOwner,
            mutateCredentialHealth,
            readCredential: vi.fn(async () => null),
            acquireRefreshLease: vi.fn(async () => ({
              acquired: false,
              leaseUntil: 0,
              ownerId: 'unused',
              credentialRevision,
            })),
            mutateCredential: vi.fn(async () => ({
              success: true as const,
              credentialRevision,
              configurationRevision: null,
            })),
          },
        }),
  });

  return {
    api,
    coordinator,
    mutateCredentialHealth,
    readQualifiedCredential,
    setGenerationCurrent(value: boolean) {
      generationCurrent = value;
    },
  };
}

describe('ConnectedServiceRefreshCoordinator qualified status integration', () => {
  it('runs a real current plugin status leaf from the existing scheduled trigger and settles exact-revision health', async () => {
    const harness = await createHarness({});
    harness.coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      materializationKey: 'session-1',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          openai: { source: 'connected', profileId: 'work' },
        },
      },
    });

    await harness.coordinator.tickOnce();

    expect(harness.mutateCredentialHealth).toHaveBeenCalledOnce();
    expect(harness.mutateCredentialHealth).toHaveBeenCalledWith({
      token: 'happier-token',
      patch: {
        ref: {
          service: openAiService,
          accountId: 'work',
        },
        expectedCredentialRevision: credentialRevision,
        expectedConfigurationRevision: null,
        health: {
          v: 1,
          status: 'connected',
          reconnectRequired: false,
        },
      },
    });
    expect(harness.readQualifiedCredential).toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it('does not publish health or report a refreshed credential when the forced trigger sees a stale plugin generation', async () => {
    const harness = await createHarness({ generationCurrent: false });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(harness.readQualifiedCredential).toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it('does not publish health when the exact qualified account snapshot is missing', async () => {
    const harness = await createHarness({ credentialAvailable: false });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(harness.readQualifiedCredential).toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it('keeps the account dormant and publishes no health when the owning plugin is disabled', async () => {
    const harness = await createHarness({ pluginEnabled: false });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(harness.readQualifiedCredential).toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
  });

  it('retains the released built-in legacy path when atomic V4 capability is known absent', async () => {
    const providerFetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant' }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    ));
    vi.stubGlobal('fetch', providerFetch);
    const harness = await createHarness({
      v4Support: 'absent',
      legacyCredentialKind: 'oauth',
      acquireLegacyRefreshLease: true,
    });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(harness.readQualifiedCredential).not.toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(harness.api.getConnectedServiceCredentialPlain).toHaveBeenCalled();
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it('fails closed instead of refreshing through the legacy route when negotiation authority is missing', async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);
    const harness = await createHarness({
      omitQualifiedRuntime: true,
      legacyCredentialKind: 'oauth',
    });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(harness.readQualifiedCredential).not.toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(harness.api.getConnectedServiceCredentialPlain).toHaveBeenCalledOnce();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('fails closed instead of refreshing through the legacy route when V4 capability is indeterminate', async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);
    const harness = await createHarness({
      v4Support: 'indeterminate',
      legacyCredentialKind: 'oauth',
    });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(harness.readQualifiedCredential).not.toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(harness.api.getConnectedServiceCredentialPlain).toHaveBeenCalledOnce();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
