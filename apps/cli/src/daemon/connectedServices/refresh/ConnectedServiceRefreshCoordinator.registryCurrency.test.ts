import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  type ConnectedServiceChildSelection,
} from '../connectedServiceChildEnvironment';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';

const sourceRevision = ConnectedServiceCredentialRevisionV1Schema.parse('csr_aaaaaaaaaaaaaaaaaaaaaa');
const refreshedRevision = ConnectedServiceCredentialRevisionV1Schema.parse('csr_bbbbbbbbbbbbbbbbbbbbbb');

function selectionEnv(selections: ReadonlyArray<ConnectedServiceChildSelection>): Readonly<Record<string, string>> {
  return {
    [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify(selections),
  };
}

function activeRevision(
  registry: ConnectedServiceRuntimeRegistry,
  key: Readonly<{ kind: 'session'; pid: number } | { kind: 'execution_run'; runKey: string }>,
  serviceId: 'openai-codex' | 'gemini',
): string | null | undefined {
  const registration = registry.listTargetRegistrations().find((candidate) => (
    candidate.key.kind === key.kind
    && (
      candidate.key.kind === 'session'
        ? candidate.key.pid === (key.kind === 'session' ? key.pid : -1)
        : candidate.key.runKey === (key.kind === 'execution_run' ? key.runKey : '')
    )
  ));
  return registration?.target.activeBindings.find((binding) => binding.serviceId === serviceId)?.credentialRevision;
}

describe('ConnectedServiceRefreshCoordinator runtime-registry currency', () => {
  it('advances only runtime bindings confirmed by the live application owner', async () => {
    const now = 1_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    };
    let credentialRevision = sourceRevision;
    let record: ConnectedServiceCredentialRecordV1 = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1,
      oauth: {
        accessToken: 'source-access',
        refreshToken: 'source-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'account-work',
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({
        acquired: false,
        leaseUntil: now + 10,
        ownerId: 'other-daemon',
        credentialRevision: sourceRevision,
      })),
      updateConnectedServiceCredentialHealth: vi.fn(async () => ({ success: true as const })),
    } as unknown as ApiClient;
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    const adoptCredentialRevision = vi.spyOn(runtimeRegistry, 'adoptCredentialRevisionForProfile');
    const matchingProfileSelection = {
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'work',
      credentialRevision: sourceRevision,
    } as const;
    const otherProfileSelection = {
      ...matchingProfileSelection,
      profileId: 'other',
    } as const;
    const otherServiceSelection = {
      kind: 'profile',
      serviceId: 'gemini',
      profileId: 'work',
      credentialRevision: sourceRevision,
    } as const;

    runtimeRegistry.registerTarget({
      pid: 101,
      agentId: 'codex',
      sessionId: 'matching-session',
      materializationKey: 'matching-session',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      connectedServiceSelectionsEnv: selectionEnv([matchingProfileSelection]),
    });
    runtimeRegistry.registerRunTarget({
      runKey: 'execution_run:matching',
      pid: 101,
      agentId: 'codex',
      sessionId: 'matching-session',
      materializationKey: 'execution_run:matching',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      connectedServiceSelectionsEnv: selectionEnv([matchingProfileSelection]),
    });
    runtimeRegistry.registerTarget({
      pid: 202,
      sessionId: 'other-profile-session',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'other' },
        },
      },
      connectedServiceSelectionsEnv: selectionEnv([otherProfileSelection]),
    });
    runtimeRegistry.registerRunTarget({
      runKey: 'execution_run:other-service',
      pid: 303,
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          gemini: { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      connectedServiceSelectionsEnv: selectionEnv([otherServiceSelection]),
    });

    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'current-daemon',
      activeServerDir: '/tmp/happier-registry-currency-server',
      baseDir: '/tmp/happier-registry-currency',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      leaseContentionWaitMaxMs: 100,
      sleepMs: async () => {
        credentialRevision = refreshedRevision;
        record = buildConnectedServiceCredentialRecord({
          now,
          serviceId: 'openai-codex',
          profileId: 'work',
          kind: 'oauth',
          expiresAt: now + 3_600_000,
          oauth: {
            accessToken: 'refreshed-access',
            refreshToken: 'refreshed-refresh',
            idToken: null,
            scope: null,
            tokenType: null,
            providerAccountId: 'account-work',
            providerEmail: null,
          },
        });
      },
      now: () => now,
      runtimeRegistry,
      onAuthUpdated: async ({ affectedTargets }) => ({
        appliedRuntimeIdentityKeys: new Set(
          affectedTargets
            .filter((target) => target.materializationKey === 'matching-session')
            .map((target) => target.runtimeIdentityKey),
        ),
      }),
    });

    await expect(coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toMatchObject({
      status: 'refreshed',
      credentialRevision: refreshedRevision,
    });

    expect(adoptCredentialRevision).toHaveBeenCalledOnce();
    expect(activeRevision(runtimeRegistry, { kind: 'session', pid: 101 }, 'openai-codex')).toBe(refreshedRevision);
    expect(activeRevision(
      runtimeRegistry,
      { kind: 'execution_run', runKey: 'execution_run:matching' },
      'openai-codex',
    )).toBe(sourceRevision);
    expect(activeRevision(runtimeRegistry, { kind: 'session', pid: 202 }, 'openai-codex')).toBe(sourceRevision);
    expect(activeRevision(
      runtimeRegistry,
      { kind: 'execution_run', runKey: 'execution_run:other-service' },
      'gemini',
    )).toBe(sourceRevision);
  });

  it('keeps the previous session and execution-run revisions when refreshed credential distribution fails', async () => {
    const now = 2_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    };
    let credentialRevision = sourceRevision;
    let record: ConnectedServiceCredentialRecordV1 = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1,
      oauth: {
        accessToken: 'source-access',
        refreshToken: 'source-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'account-work',
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({
        acquired: false,
        leaseUntil: now + 10,
        ownerId: 'other-daemon',
        credentialRevision: sourceRevision,
      })),
      updateConnectedServiceCredentialHealth: vi.fn(async () => ({ success: true as const })),
    } as unknown as ApiClient;
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    const matchingProfileSelection = {
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'work',
      credentialRevision: sourceRevision,
    } as const;
    runtimeRegistry.registerTarget({
      pid: 404,
      agentId: 'codex',
      sessionId: 'distribution-failure-session',
      materializationKey: 'distribution-failure-session',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      connectedServiceSelectionsEnv: selectionEnv([matchingProfileSelection]),
    });
    runtimeRegistry.registerRunTarget({
      runKey: 'execution_run:distribution-failure',
      pid: 404,
      agentId: 'codex',
      sessionId: 'distribution-failure-session',
      materializationKey: 'distribution-failure-run',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      connectedServiceSelectionsEnv: selectionEnv([matchingProfileSelection]),
    });
    const onAuthUpdated = vi.fn(async () => {
      throw new Error('represented target rejected refreshed credential distribution');
    });
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'current-daemon',
      activeServerDir: '/tmp/happier-registry-currency-failure-server',
      baseDir: '/tmp/happier-registry-currency-failure',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      leaseContentionWaitMaxMs: 100,
      sleepMs: async () => {
        credentialRevision = refreshedRevision;
        record = buildConnectedServiceCredentialRecord({
          now,
          serviceId: 'openai-codex',
          profileId: 'work',
          kind: 'oauth',
          expiresAt: now + 3_600_000,
          oauth: {
            accessToken: 'refreshed-access',
            refreshToken: 'refreshed-refresh',
            idToken: null,
            scope: null,
            tokenType: null,
            providerAccountId: 'account-work',
            providerEmail: null,
          },
        });
      },
      now: () => now,
      runtimeRegistry,
      onAuthUpdated,
    });

    await expect(coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).rejects.toThrow('represented target rejected refreshed credential distribution');

    expect(onAuthUpdated).toHaveBeenCalledOnce();
    expect(activeRevision(runtimeRegistry, { kind: 'session', pid: 404 }, 'openai-codex')).toBe(sourceRevision);
    expect(activeRevision(
      runtimeRegistry,
      { kind: 'execution_run', runKey: 'execution_run:distribution-failure' },
      'openai-codex',
    )).toBe(sourceRevision);
  });

  it('reports refresh failure when a registered group target cannot read canonical group state', async () => {
    const now = 3_000_000;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    let credentialRevision = sourceRevision;
    let record: ConnectedServiceCredentialRecordV1 = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now - 1,
      oauth: {
        accessToken: 'source-access',
        refreshToken: 'source-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'account-work',
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      getConnectedServiceAuthGroup: vi.fn(async () => null),
      acquireConnectedServiceRefreshLease: vi.fn(async () => ({
        acquired: false,
        leaseUntil: now + 10,
        ownerId: 'other-daemon',
        credentialRevision: sourceRevision,
      })),
      updateConnectedServiceCredentialHealth: vi.fn(async () => ({ success: true as const })),
    } as unknown as ApiClient;
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    const adoptCredentialRevision = vi.spyOn(runtimeRegistry, 'adoptCredentialRevisionForProfile');
    runtimeRegistry.registerTarget({
      pid: 505,
      agentId: 'codex',
      sessionId: 'canonical-group-unavailable-session',
      materializationKey: 'canonical-group-unavailable-session',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'pool',
            profileId: 'work',
          },
        },
      },
      connectedServiceSelectionsEnv: selectionEnv([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'pool',
        activeProfileId: 'work',
        fallbackProfileId: 'backup',
        generation: 7,
        credentialRevision: sourceRevision,
      }]),
    });
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'current-daemon',
      activeServerDir: '/tmp/happier-registry-currency-group-unavailable-server',
      baseDir: '/tmp/happier-registry-currency-group-unavailable',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      leaseContentionWaitMaxMs: 100,
      sleepMs: async () => {
        credentialRevision = refreshedRevision;
        record = buildConnectedServiceCredentialRecord({
          now,
          serviceId: 'openai-codex',
          profileId: 'work',
          kind: 'oauth',
          expiresAt: now + 3_600_000,
          oauth: {
            accessToken: 'refreshed-access',
            refreshToken: 'refreshed-refresh',
            idToken: null,
            scope: null,
            tokenType: null,
            providerAccountId: 'account-work',
            providerEmail: null,
          },
        });
      },
      now: () => now,
      runtimeRegistry,
    });

    await expect(coordinator.refreshConnectedServiceCredentialForSpawnPreflight({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toMatchObject({
      status: 'refresh_failed',
      diagnostic: {
        providerErrorCode: 'canonical_group_state_unavailable',
      },
    });

    expect(adoptCredentialRevision).not.toHaveBeenCalled();
    expect(activeRevision(runtimeRegistry, { kind: 'session', pid: 505 }, 'openai-codex')).toBe(sourceRevision);
  });

  it('addresses credential updates only to sessions, never to an execution run hosted by a session of another agent', async () => {
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    const bindingsRaw = {
      v: 1,
      bindingsByServiceId: { antigravity: { source: 'connected', selection: 'profile', profileId: 'work' } },
    } as const;
    const selection = { kind: 'profile', serviceId: 'antigravity', profileId: 'work', credentialRevision: sourceRevision } as const;
    runtimeRegistry.registerTarget({
      pid: 401, agentId: 'agy', sessionId: 'agy-session', materializationKey: 'agy-session',
      connectedServicesBindingsRaw: bindingsRaw, connectedServiceSelectionsEnv: selectionEnv([selection]),
    });
    // An agy run inside a Claude session keeps the parent's session id and runner pid.
    runtimeRegistry.registerRunTarget({
      runKey: 'execution_run:agy-in-claude', pid: 501, agentId: 'agy', sessionId: 'claude-session',
      materializationKey: 'execution_run:agy-in-claude',
      connectedServicesBindingsRaw: bindingsRaw, connectedServiceSelectionsEnv: selectionEnv([selection]),
    });
    const onAuthUpdated = vi.fn(async () => ({ appliedRuntimeIdentityKeys: new Set<string>() }));
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api: {} as ApiClient,
      credentials: { token: 'happy-token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      machineIdProvider: () => 'current-daemon',
      activeServerDir: '/tmp/happier-registry-currency-server',
      baseDir: '/tmp/happier-registry-currency',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => 3_000_000,
      runtimeRegistry,
      onAuthUpdated,
    });

    await coordinator.handleExternalCredentialUpdate({
      serviceId: 'antigravity', profileId: 'work', credentialBoundary: { status: 'absent' }, executionAuthority: 'passive_projection',
    });

    expect(onAuthUpdated).toHaveBeenCalledOnce();
    const [[event]] = onAuthUpdated.mock.calls as unknown as [[{ affectedTargets: ReadonlyArray<{ sessionId?: string | null }> }]];
    expect(event.affectedTargets.map((target) => target.sessionId)).toEqual(['agy-session']);
  });
});
