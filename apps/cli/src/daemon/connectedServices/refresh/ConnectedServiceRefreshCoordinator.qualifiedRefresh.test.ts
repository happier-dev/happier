import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildConnectedServiceCredentialRecord,
  openQualifiedConnectedAccountContentEnvelope,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountCredentialHealthPatchV4Schema,
  QualifiedConnectedAccountCredentialMutationV4Schema,
  QualifiedConnectedAccountRefreshLeaseV4Schema,
  QualifiedProviderAccountUsageWriteV4Schema,
  sealQualifiedConnectedAccountContentEnvelope,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountCredentialSnapshotV4,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type {
  ConnectedAccountConfigurationRecord,
} from '@happier-dev/cli-common/connectedAccounts';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';

import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import {
  createConnectedAccountDaemonRuntime,
  type ConnectedAccountDaemonPersistence,
} from '../ConnectedAccountDaemonRuntime';
import {
  ConnectedServiceRefreshCoordinator,
  type QualifiedConnectedAccountRefreshRuntime,
} from './ConnectedServiceRefreshCoordinator';
import { ConnectedServiceQuotasCoordinator } from '../quotas/ConnectedServiceQuotasCoordinator';
import { createBuiltInQualifiedRefreshHarness } from './ConnectedServiceRefreshCoordinator.qualifiedRefresh.testkit';

const service = Object.freeze({
  pluginId: 'happier.agent.codex',
  localId: 'openai-codex',
});
const account = Object.freeze({ service, accountId: 'work' });
const firstRevision = 'csr_abcdefghijklmnopqrstuv';
const secondRevision = 'csr_bcdefghijklmnopqrstuvw';
const thirdRevision = 'csr_cdefghijklmnopqrstuvwx';
const now = 1_000_000;
const createdDirectories: string[] = [];
const createdRegistries: Array<Readonly<{ dispose(): Promise<void> }>> = [];

async function createTrustedLocalLinkInstall(input: Readonly<{
  pluginId: string;
  sourceRootPath: string;
}>) {
  return {
    mode: 'link' as const,
    manifestVersion: '1.0.0',
    installedPath: null,
    trust: createPluginTrustRecord({
      pluginId: input.pluginId,
      distribution:
        await createLocalPathPluginDistributionIdentity(input.sourceRootPath),
      approvedAtMs: 1,
    }),
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(createdRegistries.splice(0).map(async (registry) => {
    await registry.dispose();
  }));
  await Promise.all(createdDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe('ConnectedServiceRefreshCoordinator qualified refresh integration', () => {
  it('parks a healthy bound V4 OAuth account without expiry instead of polling its credential', async () => {
    const harness = await createBuiltInQualifiedRefreshHarness();
    createdRegistries.push(harness);
    harness.coordinator.registerSpawnTarget({ pid: 123, agentId: 'codex',
      materializationKey: 'deadline-bound', connectedServicesBindingsRaw: { v: 1,
        bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } } } });
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    const initialReads = harness.readCredential.mock.calls.length;
    expect(initialReads).toBeGreaterThan(0);
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    expect(harness.readCredential).toHaveBeenCalledTimes(initialReads);
  });

  it('rejects a failed revision that becomes stale while the qualified status probe awaits', async () => {
    const credentials: Credentials = {
      token: 'happier-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(8),
      },
    };
    const legacyRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: now + 1,
      oauth: {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        idToken: null,
        providerAccountId: 'work',
        providerEmail: null,
        scope: null,
        tokenType: 'Bearer',
      },
    });
    const qualifiedContent = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      payload: {
        v: 1,
        values: {
          accessToken: 'access-newer',
          refreshToken: 'refresh-newer',
          providerAccountId: 'work',
        },
      },
      randomBytes: (length) => new Uint8Array(length),
    });
    let authoritativeRevision = firstRevision;
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: legacyRecord },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: authoritativeRevision,
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    } as unknown as ApiClient;
    const invokeWithReceipt = vi.fn(async () => {
      authoritativeRevision = secondRevision;
      return {
        result: {
          status: 'connected' as const,
          displayName: 'work',
          scopes: [],
        },
        basis: {
          credentialRevision: secondRevision,
          credentialConfigurationRevision: null,
          runtimeConfigurationRevision: 'runtime-2',
          generation: 'generation-2',
          immutableGenerationId: 'immutable-2',
          isCurrent: () => true,
          prepareCredentialReplacement: vi.fn(),
        },
      };
    });
    // The system-boundary fake is narrowed through unknown because the real owner method is
    // operation-indexed; only the status operation is reachable in this stale-revision case.
    const establishedRuntimeOwner = {
      invokeWithReceipt,
    } as unknown as QualifiedConnectedAccountRefreshRuntime['establishedRuntimeOwner'];
    const readCredential = vi.fn(async () => (
      QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: account,
        authenticationModeId: 'device',
        revisionSemantics: 'revisioned',
        credentialRevision: authoritativeRevision,
        configurationRevision: null,
        content: qualifiedContent,
        metadata: {
          providerIdentity: { accountId: 'work' },
          displayName: 'work',
          scopes: [],
        },
      })
    ));
    const mutateCredentialHealth = vi.fn(async () => ({
      credentialRevision: authoritativeRevision,
      configurationRevision: null,
    }));
    const acquireRefreshLease = vi.fn(async () => {
      throw new Error('stale revision must not acquire a refresh lease');
    });
    const mutateCredential = vi.fn(async () => {
      throw new Error('stale revision must not mutate a credential');
    });
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:runtime-1',
      activeServerDir: '/tmp/happier-active',
      baseDir: '/tmp/happier-base',
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        establishedRuntimeOwner,
        readCredential,
        acquireRefreshLease,
        mutateCredential,
        mutateCredentialHealth,
      },
    });

    await expect(coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
      expectedCredentialRevision: firstRevision,
    })).rejects.toThrow('connected_service_credential_revision_mismatch');

    expect(mutateCredentialHealth).not.toHaveBeenCalled();
    expect(acquireRefreshLease).not.toHaveBeenCalled();
    expect(mutateCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['happier.agent.codex', 'openai-codex', 'quota', 200],
    ['happier.agent.codex', 'openai-codex', 'scheduled_metadata_retry', 503],
    ['happier.agent.codex', 'openai-codex', 'scheduled_bound_metadata_retry', 503],
    ['happier.agent.codex', 'openai-codex', 'scheduled_lease_failure', 200],
    ['happier.agent.codex', 'openai-codex', 'scheduled_bound_lease_failure', 200],
    ['happier.agent.codex', 'openai-codex', 'scheduled_credential_read_failure', 200],
    ['happier.agent.codex', 'openai-codex', 'scheduled_revoked_lease_failure', 200],
    ['happier.agent.claude', 'claude-subscription', 'scheduled', 200],
    ['happier.agent.claude', 'claude-subscription', 'enrich_known_private', 200],
    ['happier.agent.claude', 'claude-subscription', 'enrich_unknown_public', 200],
    ['happier.agent.claude', 'claude-subscription', 'scheduled', 400],
    ['happier.agent.claude', 'claude-subscription', 'overlap_quota', 200],
    ['happier.agent.claude', 'claude-subscription', 'overlap_request_auth', 200],
    ['happier.agent.claude', 'claude-subscription', 'overlap_spawn', 200],
    ['happier.agent.claude', 'claude-subscription', 'overlap_configuration', 200],
    ['happier.agent.claude', 'claude-subscription', 'spawn_null_expiry', 200],
    ['happier.agent.claude', 'claude-subscription', 'spawn_null_expiry', 400],
    ['happier.agent.claude', 'claude-subscription', 'spawn_null_expiry', 503],
    ['happier.agent.claude', 'claude-subscription', 'spawn_window_retryable', 200],
    ['happier.agent.claude', 'claude-subscription', 'spawn_health_write_failure', 200],
    ['happier.agent.claude', 'claude-subscription', 'spawn_health_write_failure', 400],
    ['happier.agent.claude', 'claude-subscription', 'scheduled_rejected_retry', 400],
    ['happier.agent.claude', 'claude-subscription', 'quota_rejected_retry', 400],
    ['happier.agent.codex', 'openai-codex', 'revoked_refresh', 200],
    ['happier.agent.codex', 'openai-codex', 'coordinator_read_revoked', 200],
    ['happier.agent.codex', 'openai-codex', 'cached_bridge_revoked', 200],
    ['happier.agent.codex', 'openai-codex', 'owner_read_revoked', 200],
    ['happier.agent.codex', 'openai-codex', 'owner_invoke_revoked', 200],
  ] as const)('settles expired %s / %s via %s after provider HTTP %i', async (pluginId, serviceId, entryPoint, providerStatus) => {
    const service = Object.freeze({ pluginId, localId: serviceId });
    const account = Object.freeze({ service, accountId: 'work' });
    const contextEnrichment = entryPoint === 'enrich_known_private' || entryPoint === 'enrich_unknown_public';
    const overlapping = entryPoint.startsWith('overlap_');
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let providerEntered!: () => void;
    const providerStarted = new Promise<void>((resolve) => { providerEntered = resolve; });
    let foregroundCredentialRead!: () => void;
    const foregroundRead = new Promise<void>((resolve) => { foregroundCredentialRead = resolve; });
    let foregroundStarted = false;
    let clock = now;
    let profileStatus: QualifiedConnectedAccountProfileV4['status'] = entryPoint.endsWith('metadata_retry')
      || entryPoint.startsWith('scheduled_') && entryPoint.endsWith('_failure')
      ? 'connected' : 'refresh_failed_retryable';
    let accountRuntimeCurrent = true;
    const effectAdmissions: boolean[] = [];
    const tokenExchangeRequests = () => vi.mocked(fetch).mock.calls.filter(([request, init]) => {
      const url = request instanceof Request ? request.url : String(request);
      const method = init?.method ?? (request instanceof Request ? request.method : 'GET');
      return method === 'POST' && new URL(url).pathname.endsWith('/oauth/token');
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (contextEnrichment) {
        return new Response(JSON.stringify({ account: { uuid: 'work' }, organization: { uuid: 'organization-known' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      providerEntered();
      if (overlapping) await providerGate;
      if (entryPoint === 'revoked_refresh') accountRuntimeCurrent = false;
      return new Response(JSON.stringify(providerStatus === 400 ? { error: 'invalid_grant' } : {
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        id_token: 'id-new',
        expires_in: 3600,
        account: { uuid: 'work' },
      }), {
        status: providerStatus,
        headers: { 'content-type': 'application/json' },
      });
    }));
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-qualified-refresh-coordinator-'));
    createdDirectories.push(happyHomeDir);
    const admitted = await createAdmittedPluginRuntimeFixture({
      happyHomeDir,
      runtimeOptions: {
        pluginIds: [service.pluginId],
        networkDependencies: {
          resolveNetworkAddresses: async () => ['8.8.8.8'],
          openPinnedStream: async (request) => {
            const response = await fetch(request.url, {
              method: request.method,
              headers: request.headers,
              ...(request.body === undefined ? {} : { body: new Uint8Array(request.body).buffer }),
              signal: request.signal,
            });
            const body = new Uint8Array(await response.arrayBuffer());
            let delivered = false;
            return {
              status: response.status, headers: {}, contentLength: body.length,
              read: async () => {
                if (delivered) return null;
                delivered = true;
                return body;
              },
              cancel() {},
            };
          },
        },
      },
    });
    const registry = admitted.registry;
    createdRegistries.push(admitted);
    const credentials: Credentials = {
      token: 'happier-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(8),
      },
    };
    let qualifiedRevision = firstRevision;
    let qualifiedContent = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      payload: {
        v: 1,
        values: {
          accessToken: 'access-old',
          refreshToken: 'refresh-old',
          idToken: 'id-old',
          providerAccountId: 'work',
          expiresAtMs: contextEnrichment ? '4102444800000' : String(entryPoint === 'spawn_window_retryable' ? now + 1 : now - 1),
          ...(contextEnrichment ? { organizationUuid: 'organization-known' } : {}),
        },
      },
      randomBytes: (length) => new Uint8Array(length),
    });
    let legacyRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId,
      profileId: 'work',
      kind: 'oauth',
      expiresAt: entryPoint === 'spawn_window_retryable' ? now + 1 : now - 1,
      oauth: {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        idToken: 'id-old',
        providerAccountId: 'work',
        providerEmail: null,
        scope: null,
        tokenType: 'Bearer',
      },
    });
    let qualifiedMetadata: QualifiedConnectedAccountCredentialSnapshotV4['metadata'] = {
      providerIdentity: entryPoint === 'enrich_unknown_public'
        ? { accountId: null, organizationId: null, email: null } : { accountId: 'work' },
      displayName: 'work', scopes: ['openid'],
    };
    const initialHealth: QualifiedConnectedAccountCredentialSnapshotV4['health'] = contextEnrichment
      ? { v: 1, status: 'refresh_failed_retryable', reconnectRequired: false,
          providerErrorCode: 'network_error', lastRefreshFailureAt: now - 1 }
      : undefined;
    let qualifiedHealth = initialHealth;
    const readCredential = vi.fn(async () => {
      if (entryPoint === 'owner_read_revoked' || entryPoint === 'owner_invoke_revoked'
        || entryPoint === 'coordinator_read_revoked') accountRuntimeCurrent = false;
      return {
        ref: account,
        authenticationModeId: serviceId === 'openai-codex' ? 'device' : 'oauth',
        revisionSemantics: 'revisioned' as const,
        credentialRevision: qualifiedRevision,
        configurationRevision: null,
        content: qualifiedContent,
        metadata: qualifiedMetadata,
        ...(qualifiedHealth ? { health: qualifiedHealth } : {}),
      };
    });
    const establishedRuntimeOwner =
      createQualifiedConnectedAccountEstablishedRuntimeOwner({
        reloadController: admitted.controller,
        credentials,
        ...(entryPoint === 'owner_read_revoked' || entryPoint === 'owner_invoke_revoked'
          ? { isAccountRuntimeCurrent: async () => accountRuntimeCurrent }
          : {}),
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        readCredential,
        readConfiguration: vi.fn(async () => null),
        configuration: {
          read: vi.fn(async () => null),
          secrets: {
            admit: vi.fn(async () => undefined),
            has: vi.fn(async () => false),
            read: vi.fn(async () => null),
          },
        },
      });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: legacyRecord },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: qualifiedRevision,
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
      updateConnectedServiceCredentialHealth: vi.fn(async () => undefined),
    } as unknown as ApiClient;
    const acquireRefreshLease = vi.fn(async () => {
      if (entryPoint === 'scheduled_revoked_lease_failure') accountRuntimeCurrent = false;
      if (entryPoint.endsWith('lease_failure')) throw new Error('refresh_lease_transport_unavailable');
      effectAdmissions.push(accountRuntimeCurrent);
      return {
        acquired: true,
        leaseUntil: now + 60_000,
        ownerId: 'machine-1:runtime-1',
        credentialRevision: qualifiedRevision,
      };
    });
    const mutateCredentialHealth = vi.fn(async (_input: Readonly<{
      token: string;
      patch: unknown;
    }>) => {
      if (entryPoint === 'spawn_health_write_failure') throw new Error('database_transaction_conflict_exhausted');
      effectAdmissions.push(accountRuntimeCurrent);
      const patch = _input.patch;
      if (patch && typeof patch === 'object' && 'health' in patch) {
        const health = patch.health;
        qualifiedHealth = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(patch).health;
        if (health && typeof health === 'object' && 'status' in health
          && (health.status === 'connected' || health.status === 'needs_reauth' || health.status === 'refresh_failed_retryable')) {
          profileStatus = health.status;
        }
      }
      return {
        success: true as const,
        credentialRevision: qualifiedRevision,
        configurationRevision: null,
      };
    });
    const mutateCredential = vi.fn(async (input: Readonly<{
      token: string;
      mutation: unknown;
    }>) => {
      effectAdmissions.push(accountRuntimeCurrent);
      const mutation =
        QualifiedConnectedAccountCredentialMutationV4Schema.parse(
          input.mutation,
        );
      const plaintext = openQualifiedConnectedAccountContentEnvelope({
        kind: 'credential',
        accountMode: 'plain',
        envelope: mutation.content,
      });
      const opened =
        parseQualifiedConnectedAccountCredentialPlaintextV1({
          ref: mutation.ref,
          authenticationModeId: mutation.authenticationModeId,
          plaintext,
          metadata: mutation.metadata,
        });
      qualifiedContent = mutation.content;
      qualifiedMetadata = mutation.metadata;
      qualifiedRevision = secondRevision;
      // Credential CAS preserves committed health; its separate settlement
      // decides whether a refresh recovered, as the server repository does.
      legacyRecord = buildConnectedServiceCredentialRecord({
        now,
        serviceId,
        profileId: 'work',
        kind: 'oauth',
        expiresAt: Number(opened.values.expiresAtMs),
        oauth: {
          accessToken: opened.values.accessToken!,
          refreshToken: opened.values.refreshToken!,
          idToken: opened.values.idToken!,
          providerAccountId: opened.values.providerAccountId!,
          providerEmail: null,
          scope: null,
          tokenType: 'Bearer',
        },
      });
      return {
        success: true as const,
        credentialRevision: secondRevision,
        configurationRevision: null,
      };
    });
    const requestedInventoryServices: unknown[] = [];
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:runtime-1',
      activeServerDir: join(happyHomeDir, 'active'),
      baseDir: join(happyHomeDir, 'materialized'),
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => clock,
      isAccountRuntimeCurrent: async () => accountRuntimeCurrent,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        establishedRuntimeOwner,
        readCredential: async () => {
          if (entryPoint.endsWith('credential_read_failure')) throw new Error('credential_transport_unavailable');
          const snapshot = await readCredential();
          if (foregroundStarted) foregroundCredentialRead();
          return snapshot;
        },
        listScheduledAccounts: async (service): Promise<readonly QualifiedConnectedAccountProfileV4[]> => {
          requestedInventoryServices.push(service);
          return [{
          ref: account,
          status: profileStatus,
          authenticationModeId: 'oauth',
          revisionSemantics: 'revisioned',
          credentialRevision: qualifiedRevision,
          configurationReady: false,
          configurationRevision: null,
          kind: null,
          expiresAt: null,
          displayName: 'work',
          scopes: ['openid'],
        }]; },
        acquireRefreshLease,
        mutateCredential,
        mutateCredentialHealth,
      },
    });

    if (entryPoint.startsWith('scheduled_') && entryPoint.endsWith('_failure')) {
      if (entryPoint.startsWith('scheduled_bound_')) coordinator.registerSpawnTarget({
        pid: 123, agentId: 'codex', materializationKey: 'interrupted-refresh',
        connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        } },
      });
      // The real plugin observed expiry, but the Home transport fails before
      // any provider exchange. That observation must still reach the row.
      await coordinator.tickOnce().catch(() => undefined);
      expect(tokenExchangeRequests()).toHaveLength(0);
      if (entryPoint === 'scheduled_revoked_lease_failure') {
        expect(mutateCredentialHealth).not.toHaveBeenCalled();
        expect(effectAdmissions).not.toContain(false);
        return;
      }
      expect(mutateCredentialHealth).toHaveBeenCalledOnce();
      expect(profileStatus).toBe('refresh_failed_retryable');
      return;
    }

    if (entryPoint.endsWith('metadata_retry')) {
      const bound = entryPoint === 'scheduled_bound_metadata_retry';
      if (bound) coordinator.registerSpawnTarget({
        pid: 123, agentId: 'codex', materializationKey: 'metadata-retry',
        connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {
          'openai-codex': { source: 'connected', profileId: 'work' },
        } },
      });
      const failedRefresh = async () => {
        if (bound) await expect(coordinator.tickOnce()).rejects.toMatchObject({
          errors: [expect.objectContaining({ message: expect.stringContaining('Connected services refresh failed') })],
        });
        else expect(await coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 60_000 });
      };
      await failedRefresh();
      expect(profileStatus).toBe('refresh_failed_retryable');
      expect(tokenExchangeRequests()).toHaveLength(1);
      expect(mutateCredentialHealth).toHaveBeenCalledOnce();
      clock += 1;
      // The failed refresh's own health write changes listing metadata, not
      // credential authority, and cannot shorten the existing recovery delay.
      expect(await coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 59_999 });
      expect(tokenExchangeRequests()).toHaveLength(1);
      profileStatus = 'connected';
      expect(await coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 59_999 });
      expect(tokenExchangeRequests()).toHaveLength(1);
      clock += 59_999;
      await failedRefresh();
      expect(tokenExchangeRequests()).toHaveLength(2);
      expect(mutateCredentialHealth).toHaveBeenCalledTimes(2);
      // Reconnection replaces the admitted credential rather than inheriting
      // the old credential's health failure suppression.
      qualifiedRevision = secondRevision;
      profileStatus = 'connected';
      qualifiedHealth = undefined;
      await failedRefresh();
      expect(tokenExchangeRequests()).toHaveLength(3);
      return;
    }

    if (contextEnrichment) {
      const before = parseQualifiedConnectedAccountCredentialPlaintextV1({
        ref: account, authenticationModeId: 'oauth', metadata: qualifiedMetadata,
        plaintext: openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', envelope: qualifiedContent }),
      });
      expect(qualifiedMetadata.providerIdentity).toEqual(entryPoint === 'enrich_unknown_public'
        ? { accountId: null, organizationId: null, email: null } : { accountId: 'work' });
      await expect(coordinator.enrichQualifiedConnectedAccountCredentialContext({
        account, expectedCredentialRevision: firstRevision,
      })).resolves.toEqual({ status: 'enriched', credentialRevision: secondRevision });
      const current = await readCredential();
      const after = parseQualifiedConnectedAccountCredentialPlaintextV1({
        ref: account, authenticationModeId: 'oauth', metadata: current.metadata,
        plaintext: openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', envelope: current.content }),
      });
      expect(after.values).toEqual(before.values);
      expect(current.health).toEqual(initialHealth);
      expect(current.metadata.providerIdentity).toEqual({ accountId: 'work', organizationId: 'organization-known' });
      expect(mutateCredential).toHaveBeenCalledOnce();
      expect(acquireRefreshLease).toHaveBeenCalledOnce();
      expect(tokenExchangeRequests()).toHaveLength(0);
      expect(vi.mocked(fetch).mock.calls.map(([, init]) => init?.method)).toEqual(['GET']);
      expect(mutateCredentialHealth).not.toHaveBeenCalled();
      expect(profileStatus).toBe('refresh_failed_retryable');
      return;
    }

    if (entryPoint === 'scheduled_rejected_retry' || entryPoint === 'quota_rejected_retry') {
      await coordinator.tickOnce();
      expect(profileStatus).toBe('needs_reauth');
      expect(tokenExchangeRequests()).toHaveLength(1);
      clock += 60_001;
      if (entryPoint === 'scheduled_rejected_retry') {
        expect(await coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
      } else {
        await expect(coordinator.refreshConnectedServiceCredentialForQuota({
          serviceId, profileId: 'work', force: true,
        })).resolves.toBeNull();
      }
      expect(tokenExchangeRequests()).toHaveLength(1);
      expect(profileStatus).toBe('needs_reauth');
      // A new admitted credential clears the persisted latch; no daemon-local
      // reconnect flag may prevent refreshing that replacement revision.
      qualifiedRevision = secondRevision;
      profileStatus = 'connected';
      qualifiedHealth = undefined;
      clock += 60_001;
      await coordinator.tickOnce();
      expect(tokenExchangeRequests()).toHaveLength(2);
      return;
    }
    if (entryPoint === 'spawn_null_expiry' || entryPoint === 'spawn_health_write_failure' || entryPoint === 'spawn_window_retryable') {
      await expect(coordinator.refreshQualifiedConnectedAccountCredentialForSpawnPreflight({
        profile: {
          ref: account, status: 'refresh_failed_retryable', authenticationModeId: 'oauth',
          revisionSemantics: 'revisioned', credentialRevision: firstRevision,
          configurationReady: false, configurationRevision: null,
          kind: null, expiresAt: entryPoint === 'spawn_window_retryable' ? now + 1 : null, displayName: 'work', scopes: ['openid'],
        },
      })).resolves.toEqual({ status: providerStatus === 400 ? 'reconnect_required'
        : providerStatus === 503 ? 'refresh_failed' : 'ready' });
      expect(requestedInventoryServices).toHaveLength(0);
      expect(readCredential).toHaveBeenCalled();
      expect(tokenExchangeRequests()).toHaveLength(1);
      if (providerStatus === 200) {
        expect(qualifiedRevision).toBe(secondRevision);
        if (entryPoint === 'spawn_null_expiry') {
          expect(profileStatus).toBe('connected');
          expect(mutateCredentialHealth.mock.calls.at(-1)?.[0].patch).toMatchObject({
            expectedCredentialRevision: secondRevision,
            health: { status: 'connected', reconnectRequired: false },
          });
        }
      } else if (entryPoint !== 'spawn_health_write_failure') {
        expect(mutateCredential).not.toHaveBeenCalled();
        expect(mutateCredentialHealth.mock.calls.at(-1)?.[0].patch).toMatchObject({
          health: { status: providerStatus === 400 ? 'needs_reauth' : 'refresh_failed_retryable',
            reconnectRequired: providerStatus === 400 },
        });
      }
      return;
    }
    if (overlapping) {
      const statusReceipt = await establishedRuntimeOwner.invokeWithReceipt({ account, operation: { kind: 'status' } });
      const scheduled = coordinator.tickOnce();
      await providerStarted;
      foregroundStarted = true;
      const foreground = entryPoint === 'overlap_quota'
        ? coordinator.refreshConnectedServiceCredentialForQuota({ serviceId, profileId: 'work', force: true })
        : entryPoint === 'overlap_configuration'
        ? coordinator.applyQualifiedConnectedAccountConfigurationConsequence({
            account, authenticationModeId: 'oauth', configurationScope: 'service', behavior: 'refresh',
            runtimeConfigurationRevision: statusReceipt.basis.runtimeConfigurationRevision,
          })
        : entryPoint === 'overlap_spawn'
        ? coordinator.refreshQualifiedConnectedAccountCredentialForSpawnPreflight({
            profile: { ref: account, status: 'connected', authenticationModeId: 'oauth',
              revisionSemantics: 'revisioned', credentialRevision: firstRevision,
              configurationReady: false, configurationRevision: null,
              kind: 'oauth', expiresAt: now - 1, displayName: 'work', scopes: ['openid'] },
          })
        : coordinator.refreshQualifiedConnectedAccountCredentialForRequestAuth({
            account, expectedCredentialRevision: firstRevision,
          });
      await foregroundRead;
      // All internal awaits below this HTTP read are already resolved; the
      // provider boundary is the only pending operation. Let both paths enter it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseProvider();
      await expect(scheduled).resolves.toBeDefined();
      if (entryPoint === 'overlap_quota') {
        await expect(foreground).resolves.toMatchObject({ kind: 'oauth', oauth: { accessToken: 'access-new' } });
      } else if (entryPoint === 'overlap_configuration') {
        await expect(foreground).resolves.toBeUndefined();
      } else if (entryPoint === 'overlap_spawn') {
        await expect(foreground).resolves.toEqual({ status: 'ready' });
      } else {
        await expect(foreground).resolves.toBe(true);
      }
      expect(tokenExchangeRequests()).toHaveLength(1);
      expect(mutateCredential).toHaveBeenCalledOnce();
      expect(qualifiedRevision).toBe(secondRevision);
      return;
    }

    if (entryPoint === 'owner_read_revoked') {
      await expect(establishedRuntimeOwner.readCredentialRevision({ account }))
        .rejects.toThrow('connected_account_runtime_not_current');
      expect(qualifiedRevision).toBe(firstRevision);
      return;
    }
    if (entryPoint === 'owner_invoke_revoked') {
      await expect(establishedRuntimeOwner.invokeWithReceipt({ account, operation: { kind: 'status' } }))
        .rejects.toThrow('connected_account_runtime_not_current');
      expect(fetch).not.toHaveBeenCalled();
      return;
    }
    if (entryPoint === 'cached_bridge_revoked') {
      const request = {
        selection: { kind: 'profile' as const, serviceId: 'openai-codex' as const, profileId: 'work' },
        refreshAttemptId: 'requester-attempt',
        expectedCredentialRevision: firstRevision,
        chatgptPlanType: null,
        forceRefresh: true,
      };
      await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge(request))
        .resolves.toMatchObject({ accessToken: 'access-new' });
      accountRuntimeCurrent = false;
      await expect(coordinator.refreshOpenAiCodexChatGptTokensForBridge(request))
        .rejects.toThrow('connected_account_runtime_not_current');
      expect(mutateCredential).toHaveBeenCalledOnce();
      return;
    }
    if (entryPoint === 'revoked_refresh' || entryPoint === 'coordinator_read_revoked') {
      await coordinator.refreshConnectedServiceCredentialForQuota({
        serviceId,
        profileId: 'work',
        force: true,
      }).catch(() => null);
      expect(accountRuntimeCurrent).toBe(false);
      expect(qualifiedRevision).toBe(firstRevision);
      expect(legacyRecord.oauth).toMatchObject({
        accessToken: 'access-old', refreshToken: 'refresh-old',
      });
      expect(mutateCredential).not.toHaveBeenCalled();
      expect(effectAdmissions).not.toContain(false);
      return;
    }
    if (entryPoint === 'scheduled') {
      try {
        await coordinator.tickOnce();
      } catch (error) {
        // Keep the real activation refusal visible when the aggregate refresh
        // error would otherwise hide the unavailable installed contribution.
        throw new Error(JSON.stringify(registry.pluginDiagnosticsByPluginId[service.pluginId] ?? []), { cause: error });
      }
      if (providerStatus === 400) {
        expect(legacyRecord.oauth).toMatchObject({ accessToken: 'access-old', refreshToken: 'refresh-old' });
        expect(mutateCredential).not.toHaveBeenCalled();
        expect(mutateCredentialHealth.mock.calls.at(-1)?.[0].patch).toMatchObject({
          health: { status: 'needs_reauth', reconnectRequired: true, providerErrorCode: 'claude_subscription_oauth_rejected' },
        });
        return;
      }
      expect(legacyRecord.oauth).toMatchObject({ accessToken: 'access-new', refreshToken: 'refresh-new' });
    } else {
      await expect(coordinator.refreshConnectedServiceCredentialForQuota({
        serviceId,
        profileId: 'work',
        force: true,
      })).resolves.toMatchObject({
        kind: 'oauth',
        oauth: {
          accessToken: 'access-new',
          refreshToken: 'refresh-new',
          idToken: 'id-new',
        },
      });
    }

    expect(mutateCredentialHealth).toHaveBeenCalledOnce();
    expect(mutateCredentialHealth.mock.calls[0]?.[0].patch).toMatchObject({
      health: { status: 'connected', reconnectRequired: false },
    });
    expect(acquireRefreshLease).toHaveBeenCalled();
    expect(mutateCredential).toHaveBeenCalledOnce();
    expect(mutateCredential.mock.calls[0]![0]).toMatchObject({
      token: 'happier-token',
      mutation: {
        ref: account,
        expectedCredentialRevision: firstRevision,
        expectedConfigurationRevision: null,
        refreshLeaseOwnerId: 'machine-1:runtime-1',
      },
    });
  });

  it('schedules a novel qualified service through the real coordinator and current plugin runtime without a legacy enum id', async () => {
    const happyHomeDir = await mkdtemp(
      join(tmpdir(), 'happier-novel-qualified-refresh-home-'),
    );
    const pluginRoot = await mkdtemp(
      join(tmpdir(), 'happier-novel-qualified-refresh-plugin-'),
    );
    createdDirectories.push(happyHomeDir, pluginRoot);
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(
      join(pluginRoot, '.happier-plugin', 'plugin.json'),
      JSON.stringify({
        schemaVersion: 2,
        id: 'acme.novel.refresh',
        version: '1.0.0',
        displayName: 'Novel refresh',
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        contributes: {
          connectedAccountDescriptors: [{
            id: 'novel-service',
            title: 'Novel service',
            authentication: {
              defaultModeId: 'manual',
              modes: [{
                id: 'manual',
                kind: 'manual',
                outcomeReconciliation: 'none',
                configuration: {
                  scope: 'service',
                  changeBehavior: 'refresh',
                  fields: [{
                    id: 'endpoint',
                    title: 'Endpoint',
                    schema: { type: 'string', minLength: 1 },
                    required: true,
                  }],
                },
                fields: [{
                  id: 'token',
                  title: 'Token',
                  schema: { type: 'string' },
                  secret: true,
                }],
              }],
            },
          }],
        },
      }),
      'utf8',
    );
    await writeFile(
      join(pluginRoot, 'daemon.mjs'),
      `export function activate(api) {
        api.connectedAccounts.register('novel-service', {
          authentication: {
            modes: {
              manual: {
                kind: 'manual',
                async complete() {
                  return {
                    status: 'connected',
                    accountId: 'novel-account',
                    displayName: 'Novel account',
                    scopes: [],
                  };
                },
              },
            },
          },
          async status(context) {
            if (await context.credentials.get('token') === 'rejected-test-token') return {
              status: 'reconnectRequired', diagnostic: { code: 'novel_rejected', message: 'Reconnect this account.' },
            };
            return { status: 'connected', displayName: 'Novel account', scopes: [] };
          },
          async enrichCredentialContext(context) {
            const token = await context.credentials.get('token');
            if (token === 'context-unknown' || token === 'context-rejected') return {
              status: token === 'context-unknown' ? 'outcomeUnknown' : 'reconnectRequired',
              diagnostic: { code: token === 'context-unknown' ? 'novel_context_unknown' : 'novel_context_rejected',
                message: 'private-provider-message' },
            };
            if (await context.credentials.get('providerContext')) return { status: 'connected' };
            await context.stagedCredentials.set('providerContext', 'organization-1');
            return { status: 'connected', providerIdentity: {
              accountId: 'novel-provider-account', organizationId: 'organization-1',
            } };
          },
          async refresh(context) {
            await context.stagedCredentials.set('token', 'novel-token-refreshed');
            return { status: 'connected', displayName: 'Novel account', scopes: [] };
          },
          async quota() {
            return {
              observedAtMs: 1000000,
              limits: [{
                id: 'requests',
                used: 40,
                remaining: 60,
                resetsAtMs: 1060000,
              }, {
                id: 'optional-diagnostic',
              }],
            };
          },
          async revoke() {
            return { status: 'remoteUnsupported' };
          },
          async materialize() {
            return { kind: 'environment', env: {} };
          },
        });
      }`,
      'utf8',
    );
    await writeCommittedLocalPathPluginFixture({
      happyHomeDir,
      pluginId: 'acme.novel.refresh',
      sourceRootPath: pluginRoot,
      plugin: {
        source: {
          kind: 'path',
          locator: pluginRoot,
          trustPolicy: 'local_trusted',
          installPolicy: 'link',
          resolvedPath: pluginRoot,
          manifestPath: join(
            pluginRoot,
            '.happier-plugin',
            'plugin.json',
          ),
        },
        compatibility: { status: 'unknown', diagnostics: [] },
        install: await createTrustedLocalLinkInstall({
          pluginId: 'acme.novel.refresh',
          sourceRootPath: pluginRoot,
        }),
        state: { enabled: true },
      },
    });
    const registry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir,
      resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
        kind: 'development', registeredRootId: `qualified-coordinator:${pluginId}`,
        canonicalRoot: rootPath, observedRevision: 1,
      }),
    });
    createdRegistries.push(registry);
    const novelService = Object.freeze({
      pluginId: 'acme.novel.refresh',
      localId: 'novel-service',
    });
    const novelAccount = Object.freeze({
      service: novelService,
      accountId: 'novel-account',
    });
    const credentials: Credentials = {
      token: 'happier-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(9),
      },
    };
    let revision = firstRevision;
    let serviceConfiguration: ConnectedAccountConfigurationRecord = {
      revision: 'configuration-1',
      values: { endpoint: 'https://old.example.test' },
      secretRefs: {},
    };
    let content = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential',
      accountMode: 'plain',
      payload: { v: 1, values: { token: 'novel-token-old' } },
      randomBytes: (length) => new Uint8Array(length),
    });
    let metadata: QualifiedConnectedAccountCredentialSnapshotV4['metadata'] = {
      displayName: 'Novel account', scopes: [],
    };
    const readCredential = vi.fn(async () => ({
      ref: novelAccount,
      authenticationModeId: 'manual',
      revisionSemantics: 'revisioned' as const,
      credentialRevision: revision,
      configurationRevision: null,
      content,
      metadata,
    }));
    const establishedRuntimeOwner =
      createQualifiedConnectedAccountEstablishedRuntimeOwner({
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
            return candidate === registry;
          },
        },
        credentials,
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        readCredential,
        readConfiguration: vi.fn(async () => null),
        configuration: {
          read: vi.fn(async () => serviceConfiguration),
          secrets: {
            admit: vi.fn(async () => undefined),
            has: vi.fn(async () => false),
            read: vi.fn(async () => null),
          },
        },
      });
    const mutateCredential = vi.fn(async (input: Readonly<{
      token: string;
      mutation: unknown;
    }>) => {
      const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(
        input.mutation,
      );
      content = mutation.content;
      metadata = mutation.metadata;
      revision = revision === firstRevision
        ? secondRevision
        : thirdRevision;
      return {
        success: true as const,
        credentialRevision: revision,
        configurationRevision: null,
      };
    });
    const onCredentialUpdated = vi.fn();
    const acquireRefreshLease = vi.fn(async (input: Readonly<{
      token: string;
      lease: unknown;
    }>) => {
      const lease = QualifiedConnectedAccountRefreshLeaseV4Schema.parse(
        input.lease,
      );
      return {
        acquired: true,
        leaseUntil: now + 60_000,
        ownerId: lease.ownerId,
        credentialRevision: lease.expectedCredentialRevision,
      };
    });
    const mutateCredentialHealth = vi.fn(async () => ({
      success: true as const,
      credentialRevision: revision,
      configurationRevision: null,
    }));
    const coordinator = new ConnectedServiceRefreshCoordinator({
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      } as unknown as ApiClient,
      credentials,
      machineIdProvider: () => 'machine-1',
      ownerIdProvider: () => 'machine-1:runtime-1',
      activeServerDir: join(happyHomeDir, 'active'),
      baseDir: join(happyHomeDir, 'materialized'),
      refreshWindowMs: 60_000,
      refreshLeaseMs: 30_000,
      now: () => now,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        establishedRuntimeOwner,
        readCredential,
        listScheduledAccounts: vi.fn(async (): Promise<
          readonly QualifiedConnectedAccountProfileV4[]
        > => [{
          ref: novelAccount,
          status: 'connected',
          authenticationModeId: 'manual',
          revisionSemantics: 'revisioned',
          credentialRevision: firstRevision,
          configurationReady: true,
          configurationRevision: null,
          kind: 'oauth',
          expiresAt: now + 1,
          displayName: 'Novel account',
          scopes: [],
        }]),
        acquireRefreshLease,
        mutateCredential,
        mutateCredentialHealth,
        onCredentialUpdated,
      },
    });

    await expect(coordinator.tickOnce()).resolves.toEqual({ nextAutomaticRunAfterMs: null });

    expect(mutateCredential).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        ref: novelAccount,
        expectedCredentialRevision: firstRevision,
        expectedConfigurationRevision: null,
      }),
    }));
    expect(onCredentialUpdated).toHaveBeenCalledWith(novelAccount);

    const persistence: ConnectedAccountDaemonPersistence = {
      profiles: {
        list: vi.fn(async () => [{
          ref: novelAccount,
          status: 'connected' as const,
          authenticationModeId: 'manual',
          revisionSemantics: 'revisioned' as const,
          credentialRevision: revision,
          configurationReady: true,
          configurationRevision: null,
          kind: 'oauth' as const,
          expiresAt: now + 60_000,
          displayName: 'Novel account',
          scopes: [],
        }]),
      },
      configuration: {
        read: vi.fn(async () => serviceConfiguration),
        replaceForControl: vi.fn(async (input) => {
          if (input.expectedRevision !== serviceConfiguration.revision) {
            return {
              status: 'conflict' as const,
              code: 'connected_account_configuration_changed',
            };
          }
          serviceConfiguration = {
            revision: 'configuration-2',
            values: input.values,
            secretRefs: input.currentSecretRefs,
          };
          return {
            status: 'committed' as const,
            record: serviceConfiguration,
          };
        }),
        replace: vi.fn(async (input) => {
          if (input.expectedRevision !== serviceConfiguration.revision) {
            return {
              status: 'conflict' as const,
              code: 'connected_account_configuration_changed',
            };
          }
          serviceConfiguration = {
            revision: 'configuration-2',
            ...input.replacement,
          };
          return {
            status: 'committed' as const,
            record: serviceConfiguration,
          };
        }),
        destroyAttempt: vi.fn(),
        secrets: {
          admit: vi.fn(async () => undefined),
          has: vi.fn(async () => false),
          read: vi.fn(async () => null),
        },
      },
      attempts: {
        accounts: {
          readExact: vi.fn(async () => ({
            account: novelAccount,
            authenticationModeId: 'manual',
            credentialRevision: revision,
            configurationRevision: null,
          })),
        },
        oauth: { create: vi.fn() },
        settlement: { settle: vi.fn() },
      },
    };
    const lease = () => ({
      registry,
      source: 'active' as const,
      release: vi.fn(async () => undefined),
    });
    const reloadController = {
      acquireRuntimeRegistry: vi.fn(async () => lease()),
      tryAcquireRuntimeRegistry: vi.fn(() => lease()),
      isRuntimeRegistryCurrent: vi.fn(
        (candidate: typeof registry) => candidate === registry,
      ),
    } as unknown as PluginReloadController;
    const controlRuntime = createConnectedAccountDaemonRuntime({
      reloadController,
      persistence,
      configurationConsequences: {
        assertAvailable: async () => undefined,
        async apply(input) {
          await coordinator
            .applyQualifiedConnectedAccountConfigurationConsequence(input);
        },
      },
      revocation: {
        token: credentials.token,
        establishedRuntimeOwner,
        resolveV4Support: () => 'advertised',
        resolveRemovalReviewSupport: () => 'absent',
        deleteCredential: vi.fn(async () => ({ success: true as const })),
      },
    });

    await expect(controlRuntime.control({
      operation: 'replaceConfiguration',
      target: {
        kind: 'service',
        service: novelService,
        modeId: 'manual',
      },
      expectedRevision: 'configuration-1',
      values: { endpoint: 'https://new.example.test' },
      secretValues: {},
    })).resolves.toMatchObject({
      status: 'configurationCommitted',
      configuration: {
        revision: 'configuration-2',
        values: { endpoint: 'https://new.example.test' },
      },
    });

    expect(mutateCredential).toHaveBeenCalledTimes(2);
    expect(mutateCredential).toHaveBeenLastCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        ref: novelAccount,
        expectedCredentialRevision: secondRevision,
        expectedConfigurationRevision: null,
      }),
    }));
    expect(acquireRefreshLease).toHaveBeenLastCalledWith(expect.objectContaining({
      lease: expect.objectContaining({
        expectedCredentialRevision: secondRevision,
        ownerId: 'machine-1:runtime-1',
      }),
    }));
    expect(onCredentialUpdated).toHaveBeenCalledTimes(2);

    await expect(
      coordinator.applyQualifiedConnectedAccountConfigurationConsequence({
        account: novelAccount,
        authenticationModeId: 'manual',
        configurationScope: 'service',
        behavior: 'reconnect',
        runtimeConfigurationRevision: 'configuration-2',
      }),
    ).resolves.toBeUndefined();
    expect(mutateCredentialHealth).toHaveBeenLastCalledWith({
      token: 'happier-token',
      patch: {
        ref: novelAccount,
        expectedCredentialRevision: thirdRevision,
        expectedConfigurationRevision: null,
        health: {
          v: 1,
          status: 'needs_reauth',
          reconnectRequired: true,
          providerErrorCode:
            'connected_account_configuration_changed',
        },
      },
    });
    expect(onCredentialUpdated).toHaveBeenCalledTimes(3);

    acquireRefreshLease.mockResolvedValueOnce({
      acquired: false,
      leaseUntil: now + 60_000,
      ownerId: 'another-refresh-owner',
      credentialRevision: thirdRevision,
    });
    await expect(
      coordinator.applyQualifiedConnectedAccountConfigurationConsequence({
        account: novelAccount,
        authenticationModeId: 'manual',
        configurationScope: 'service',
        behavior: 'refresh',
        runtimeConfigurationRevision: 'configuration-2',
      }),
    ).rejects.toMatchObject({
      code: 'connected_account_configuration_consequence_unavailable',
    });
    expect(mutateCredential).toHaveBeenCalledTimes(2);
    expect(onCredentialUpdated).toHaveBeenCalledTimes(3);

    const writeProviderAccountUsage = vi.fn(async (input: Readonly<{
      token: string;
      write: unknown;
    }>) => {
      QualifiedProviderAccountUsageWriteV4Schema.parse(input.write);
      return { success: true as const };
    });
    const quotaCoordinator = new ConnectedServiceQuotasCoordinator({
      api: {
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      } as unknown as ConstructorParameters<
        typeof ConnectedServiceQuotasCoordinator
      >[0]['api'],
      credentials,
      quotaFetchers: [],
      now: () => now,
      randomBytes: (length) => new Uint8Array(length),
      discoveryEnabled: false,
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4',
        establishedRuntimeOwner,
        listScheduledAccounts: vi.fn(async (): Promise<
          readonly QualifiedConnectedAccountProfileV4[]
        > => [{
          ref: novelAccount,
          status: 'connected',
          authenticationModeId: 'manual',
          revisionSemantics: 'revisioned',
          credentialRevision: thirdRevision,
          configurationReady: true,
          configurationRevision: null,
          kind: 'oauth',
          expiresAt: now + 60_000,
          displayName: 'Novel account',
          scopes: [],
        }]),
        readQuota: vi.fn(async () => null),
        writeProviderAccountUsage,
      },
    });

    await quotaCoordinator.tickOnce();

    expect(writeProviderAccountUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'happier-token',
        write: expect.objectContaining({
          source: {
            ref: novelAccount,
            bindingKind: 'account',
          },
          expectedCredentialRevision: thirdRevision,
          expectedConfigurationRevision: null,
          payloadMode: 'plain_json_v1',
          status: 'ok',
          snapshot: expect.objectContaining({
            observedAtMs: now,
            meters: expect.arrayContaining([expect.objectContaining({
              meterId: 'requests',
              used: 40,
              remaining: 60,
              limit: 100,
            })]),
          }),
        }),
      }),
    );

    const currentProfile: QualifiedConnectedAccountProfileV4 = {
      ref: novelAccount, status: 'refresh_failed_retryable', authenticationModeId: 'manual',
      revisionSemantics: 'revisioned', credentialRevision: revision, configurationReady: true,
      configurationRevision: null, expiresAt: now + 3_600_000, scopes: [],
    };
    const revisionBeforeFreshReplacement = revision;
    await expect(coordinator.refreshQualifiedConnectedAccountCredentialForSpawnPreflight({
      profile: { ...currentProfile, status: 'connected', expiresAt: now + 1 }, allowEarlyRefresh: false,
    })).resolves.toEqual({ status: 'ready' });
    expect(revision).toBe(revisionBeforeFreshReplacement);
    mutateCredentialHealth.mockClear();
    await expect(coordinator.refreshQualifiedConnectedAccountCredentialForSpawnPreflight({ profile: currentProfile }))
      .resolves.toEqual({ status: 'ready' });
    expect(mutateCredentialHealth).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({
      health: { v: 1, status: 'connected', reconnectRequired: false },
    }) }));

    content = sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
      payload: { v: 1, values: { token: 'rejected-test-token' } }, randomBytes: length => new Uint8Array(length) });
    revision = 'csr_defghijklmnopqrstuvwxy';
    mutateCredentialHealth.mockRejectedValueOnce(new Error('database_transaction_conflict_exhausted'));
    await expect(coordinator.refreshQualifiedConnectedAccountCredentialForSpawnPreflight({ profile: { ...currentProfile, credentialRevision: revision } }))
      .resolves.toEqual({ status: 'reconnect_required' });

    // Metadata settlement keeps the rejected token and its existing auth health.
    const tokenBeforeContext = parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: novelAccount, authenticationModeId: 'manual', metadata: { scopes: [] },
      plaintext: openQualifiedConnectedAccountContentEnvelope({
        kind: 'credential', accountMode: 'plain', envelope: content,
      }),
    });
    mutateCredential.mockClear();
    mutateCredentialHealth.mockClear();
    onCredentialUpdated.mockClear();
    await expect(coordinator.enrichQualifiedConnectedAccountCredentialContext({
      account: novelAccount, expectedCredentialRevision: revision,
    })).resolves.toEqual({ status: 'enriched', credentialRevision: thirdRevision });
    const enriched = parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: novelAccount, authenticationModeId: 'manual', metadata: { scopes: [] },
      plaintext: openQualifiedConnectedAccountContentEnvelope({
        kind: 'credential', accountMode: 'plain', envelope: content,
      }),
    });
    expect(enriched).toEqual({ ...tokenBeforeContext, values: {
      ...tokenBeforeContext.values, providerContext: 'organization-1',
    } });
    expect(mutateCredential).toHaveBeenCalledOnce();
    expect(metadata.providerIdentity).toEqual({
      accountId: 'novel-provider-account', organizationId: 'organization-1',
    });
    expect((await readCredential()).metadata.providerIdentity).toEqual(metadata.providerIdentity);
    expect(mutateCredentialHealth).not.toHaveBeenCalled();
    expect(onCredentialUpdated).toHaveBeenCalledExactlyOnceWith(novelAccount, { reason: 'provider_context' });
    mutateCredential.mockClear();
    onCredentialUpdated.mockClear();
    await expect(coordinator.enrichQualifiedConnectedAccountCredentialContext({
      account: novelAccount, expectedCredentialRevision: revision,
    })).resolves.toEqual({ status: 'unchanged', credentialRevision: thirdRevision });
    expect(mutateCredential).not.toHaveBeenCalled();
    expect(mutateCredentialHealth).not.toHaveBeenCalled();
    expect(onCredentialUpdated).not.toHaveBeenCalled();

    // A context demand joining a token exchange re-enters enrichment against
    // the new revision, rather than mistaking rotation for complete context.
    content = sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
      payload: { v: 1, values: { token: 'novel-token-old' } }, randomBytes: length => new Uint8Array(length) });
    revision = firstRevision;
    let releaseTokenCas!: () => void;
    let tokenCasEntered!: () => void;
    const tokenCasGate = new Promise<void>(resolve => { releaseTokenCas = resolve; });
    const tokenCasStarted = new Promise<void>(resolve => { tokenCasEntered = resolve; });
    mutateCredential.mockImplementationOnce(async (input) => {
      tokenCasEntered();
      await tokenCasGate;
      const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(input.mutation);
      content = mutation.content;
      metadata = mutation.metadata;
      revision = secondRevision;
      return { success: true, credentialRevision: revision, configurationRevision: null };
    });
    const rotating = coordinator.refreshQualifiedConnectedAccountCredentialForRequestAuth({
      account: novelAccount, expectedCredentialRevision: firstRevision,
    });
    await tokenCasStarted;
    const enriching = coordinator.enrichQualifiedConnectedAccountCredentialContext({
      account: novelAccount, expectedCredentialRevision: firstRevision,
    });
    releaseTokenCas();
    await expect(rotating).resolves.toBe(true);
    await expect(enriching).resolves.toEqual({ status: 'enriched', credentialRevision: thirdRevision });
    expect(parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: novelAccount, authenticationModeId: 'manual', metadata: { scopes: [] },
      plaintext: openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', envelope: content }),
    }).values).toEqual({ token: 'novel-token-refreshed', providerContext: 'organization-1' });

    // A token-refresh caller cannot accept a metadata-only revision as rotation.
    content = sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
      payload: { v: 1, values: { token: 'novel-token-old' } }, randomBytes: length => new Uint8Array(length) });
    revision = firstRevision;
    let releaseContextCas!: () => void;
    let contextCasEntered!: () => void;
    const contextCasGate = new Promise<void>(resolve => { releaseContextCas = resolve; });
    const contextCasStarted = new Promise<void>(resolve => { contextCasEntered = resolve; });
    mutateCredential.mockClear();
    mutateCredentialHealth.mockClear();
    mutateCredential.mockImplementationOnce(async (input) => {
      contextCasEntered();
      await contextCasGate;
      const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(input.mutation);
      content = mutation.content;
      metadata = mutation.metadata;
      revision = secondRevision;
      return { success: true, credentialRevision: revision, configurationRevision: null };
    });
    const contextFirst = coordinator.enrichQualifiedConnectedAccountCredentialContext({
      account: novelAccount, expectedCredentialRevision: firstRevision,
    });
    await contextCasStarted;
    const refreshAfterContext = coordinator.refreshQualifiedConnectedAccountCredentialForRequestAuth({
      account: novelAccount, expectedCredentialRevision: firstRevision,
    });
    releaseContextCas();
    await expect(contextFirst).resolves.toEqual({ status: 'enriched', credentialRevision: secondRevision });
    await expect(refreshAfterContext).resolves.toBe(false);
    expect(mutateCredential).toHaveBeenCalledOnce();
    expect(mutateCredentialHealth).not.toHaveBeenCalled();
    expect(parseQualifiedConnectedAccountCredentialPlaintextV1({
      ref: novelAccount, authenticationModeId: 'manual', metadata: { scopes: [] },
      plaintext: openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', envelope: content }),
    }).values).toEqual({ token: 'novel-token-old', providerContext: 'organization-1' });

    const warn = vi.spyOn(logger, 'warn');
    try {
      for (const [token, status, diagnosticCode] of [
        ['context-unknown', 'outcome_unknown', 'novel_context_unknown'],
        ['context-rejected', 'not_connected', 'novel_context_rejected'],
      ] as const) {
        content = sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
          payload: { v: 1, values: { token } }, randomBytes: length => new Uint8Array(length) });
        mutateCredential.mockClear();
        mutateCredentialHealth.mockClear();
        onCredentialUpdated.mockClear();
        warn.mockClear();
        await expect(coordinator.enrichQualifiedConnectedAccountCredentialContext({
          account: novelAccount, expectedCredentialRevision: revision,
        })).resolves.toEqual({ status: 'unavailable' });
        expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
          service: novelService, status, diagnosticCode,
        }));
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private-provider-message');
        expect(mutateCredential).not.toHaveBeenCalled();
        expect(mutateCredentialHealth).not.toHaveBeenCalled();
        expect(onCredentialUpdated).not.toHaveBeenCalled();
      }
    } finally {
      warn.mockRestore();
    }
  });
});
