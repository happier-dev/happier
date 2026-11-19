import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sealQualifiedConnectedAccountContentEnvelope,
  openQualifiedConnectedAccountContentEnvelope,
  type QualifiedConnectedAccountProfileV4,
  type ConnectedServiceCredentialHealthV1,
  QualifiedConnectedAccountCredentialHealthPatchV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
  type QualifiedConnectedAccountCredentialSnapshotV4,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createAdmittedPluginRuntimeFixture, retireAdmittedPluginRuntimeRegistry } from '@/plugins/testkit/admittedRuntime';

import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';

// Genuine HTTP boundary: Node's runtime uses the package's Undici fetch.
vi.mock('undici', async importOriginal => {
  const runtime = await importOriginal<typeof import('undici')>();
  return { ...runtime, fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args) };
});

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(createdRegistries.splice(0).map(async (registry) => {
    await registry.dispose();
  }));
  await Promise.all(createdDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

async function createHarness(input: Readonly<{
  github?: boolean;
  accountMode?: 'plain' | 'e2ee';
  credentialSecretRef?: string;
  clock?: () => number;
  healthProbeIntervalMs?: number;
  onCredentialRead?: () => void;
  onCredentialMutation?: (revision: string) => void;
  profile?: () => Partial<Pick<QualifiedConnectedAccountProfileV4, 'kind' | 'expiresAt' | 'status'>> & Readonly<{ credentialRevision?: string }>;
  noScheduledAccounts?: boolean;
  retireRegistry?: boolean;
  pluginEnabled?: boolean;
  credentialAvailable?: boolean;
  v4Support?: 'advertised' | 'absent' | 'indeterminate';
  omitQualifiedRuntime?: boolean;
  health?: ConnectedServiceCredentialHealthV1;
  credentialSnapshot?: () => QualifiedConnectedAccountCredentialSnapshotV4 | null;
  listedProfiles?: readonly QualifiedConnectedAccountProfileV4[];
  isAccountRuntimeCurrent?: () => Promise<boolean>;
}>) {
  const service = input.github ? { pluginId: 'happier.scm.forge.github', localId: 'github-account' } : openAiService;
  const authenticationModeId = input.github ? 'fine-grained-pat' : 'api-key';
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-qualified-status-'));
  createdDirectories.push(happyHomeDir);
  const admitted = await createAdmittedPluginRuntimeFixture({
    happyHomeDir,
    runtimeOptions: {
      pluginIds: input.pluginEnabled === false ? [] : [service.pluginId],
      ...(input.pluginEnabled === false ? { contributes: createResolvedContributionRegistry({}) } : {}),
    },
  });
  createdRegistries.push(admitted);
  const reloadController = admitted.controller;
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
  let persistedHealth = input.health;
  let persistedRevision = credentialRevision;
  let persistedMetadata: QualifiedConnectedAccountCredentialSnapshotV4['metadata'] = { scopes: [] };
  let writtenCredential: QualifiedConnectedAccountCredentialSnapshotV4['content'] | undefined;
  const readQualifiedCredential = vi.fn(async () => {
    input.onCredentialRead?.();
    if (input.credentialSnapshot) return input.credentialSnapshot();
    const currentRevision = input.profile?.().credentialRevision ?? credentialRevision;
    if (currentRevision !== persistedRevision) persistedHealth = undefined;
    persistedRevision = currentRevision;
    return input.credentialAvailable === false
      ? null
      : {
          ref: {
            service,
            accountId: 'work',
          },
          authenticationModeId,
          revisionSemantics: 'revisioned' as const,
          credentialRevision: persistedRevision,
          configurationRevision: null,
          content: input.github ? sealQualifiedConnectedAccountContentEnvelope({
            kind: 'credential',
            ...(input.accountMode === 'e2ee'
              ? { accountMode: 'e2ee' as const, material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }
              : { accountMode: 'plain' as const }),
            payload: input.credentialSecretRef
              ? { v: 1, values: {}, secretRefs: { token: input.credentialSecretRef } }
              : { v: 1, values: { token: `fixture-${currentRevision}` } },
            randomBytes: length => new Uint8Array(length),
          }) : credentialContent,
          metadata: persistedMetadata,
          ...(persistedHealth ? { health: persistedHealth } : {}),
        };
  });
  const establishedRuntimeOwner =
    createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController,
      credentials,
      getAccountEncryptionMode: vi.fn(async () => input.accountMode ?? 'plain'),
      readCredential: readQualifiedCredential,
      readConfiguration: vi.fn(async () => null),
      configuration: {
        read: vi.fn(async () => null),
        secrets: {
          admit: vi.fn(async () => undefined),
          has: vi.fn(async ref => ref === input.credentialSecretRef),
          read: vi.fn(async ref => ref === input.credentialSecretRef ? 'fixture-saved-github-token' : null),
        },
      },
    });
  const api = {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getConnectedServiceCredentialPlain: vi.fn(),
    getConnectedServiceCredentialSealed: vi.fn(async () => null),
    acquireConnectedServiceRefreshLease: vi.fn(),
  } as unknown as ApiClient;
  const mutateCredentialHealth = vi.fn(async (params: Readonly<{
    token: string;
    patch: unknown;
  }>) => {
    expect(params.token).toBe(credentials.token);
    persistedHealth = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(params.patch).health;
    return {
      success: true as const,
      credentialRevision: persistedRevision,
      configurationRevision: null,
    };
  });
  const listScheduledAccounts = vi.fn(async (): Promise<readonly QualifiedConnectedAccountProfileV4[]> =>
    input.listedProfiles ?? (input.noScheduledAccounts ? [] : [{
      ref: { service, accountId: 'work' },
      status: 'connected',
      authenticationModeId,
      revisionSemantics: 'revisioned',
      credentialRevision,
      configurationReady: false,
      configurationRevision: null,
      kind: 'token',
      expiresAt: null,
      displayName: 'work',
      scopes: [],
      ...input.profile?.(),
    }]));
  const coordinatorParams: ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0] = {
    api,
    credentials,
    machineIdProvider: () => 'machine-1',
    activeServerDir: join(happyHomeDir, 'active'),
    baseDir: join(happyHomeDir, 'materialized'),
    refreshWindowMs: 60_000,
    refreshLeaseMs: 30_000,
    healthProbeIntervalMs: input.healthProbeIntervalMs,
    now: input.clock ?? (() => now),
    isAccountRuntimeCurrent: input.isAccountRuntimeCurrent,
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
            readCredential: readQualifiedCredential,
            listScheduledAccounts,
            acquireRefreshLease: vi.fn(async () => ({
              acquired: false,
              leaseUntil: 0,
              ownerId: 'unused',
              credentialRevision,
            })),
            mutateCredential: vi.fn(async ({ mutation }) => {
              persistedMetadata = mutation.metadata;
              writtenCredential = mutation.content;
              persistedRevision = 'csr_cdefghijklmnopqrstuvwx';
              input.onCredentialMutation?.(persistedRevision);
              return ({
              success: true as const,
              credentialRevision: persistedRevision,
              configurationRevision: null,
            }); }),
          },
        }),
  };
  const createCoordinator = () => new ConnectedServiceRefreshCoordinator(coordinatorParams);
  const coordinator = createCoordinator();

  if (input.retireRegistry) {
    await retireAdmittedPluginRuntimeRegistry({ controller: reloadController, registry: admitted.registry, happyHomeDir });
  }
  return {
    api,
    coordinator,
    createCoordinator,
    mutateCredentialHealth,
    readQualifiedCredential,
    listScheduledAccounts,
    persistedMetadata: () => persistedMetadata,
    writtenCredential: () => writtenCredential,
    setPersistedHealth(health: ConnectedServiceCredentialHealthV1) {
      persistedHealth = health;
    },
  };
}

describe('ConnectedServiceRefreshCoordinator qualified status integration', () => {
  it('backfills identity without inlining an E2EE Saved Secret credential', async () => {
    let revision = credentialRevision;
    const secretRef = 'happier:shared-secret:v1:github-identity-test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 12345, login: 'octocat' }), { status: 200 })));
    const harness = await createHarness({ github: true, accountMode: 'e2ee', credentialSecretRef: secretRef,
      onCredentialMutation: next => { revision = next; }, profile: () => ({ credentialRevision: revision }),
    });
    await harness.coordinator.tickOnce();
    expect(harness.persistedMetadata().providerIdentity).toEqual({ accountId: '12345' });
    const content = harness.writtenCredential();
    if (!content) throw new Error('Identity backfill did not write credential content');
    expect(content?.t).toBe('encrypted');
    expect(openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) }, envelope: content,
    })).toEqual({ v: 1, values: {}, secretRefs: { token: secretRef } });
  });

  it('persists the subject from scheduled GitHub health when the static credential is bound', async () => {
    let revision = credentialRevision;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 12345, login: 'octocat' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const harness = await createHarness({ github: true,
      onCredentialMutation: next => { revision = next; },
      profile: () => ({ credentialRevision: revision }),
    });
    harness.coordinator.registerSpawnTarget({ pid: 123, agentId: 'codex', materializationKey: 'github-session',
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: { github: { source: 'connected', profileId: 'work' } } },
    });
    await harness.coordinator.tickOnce();
    expect(harness.persistedMetadata().providerIdentity).toEqual({ accountId: '12345' });
    await harness.coordinator.tickOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('persists an unknown reason when a plugin requires reconnection without a typed reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Bad credentials"}', { status: 401 })));
    const harness = await createHarness({ github: true });
    await harness.coordinator.tickOnce();

    const { health } = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(
      harness.mutateCredentialHealth.mock.lastCall?.[0].patch,
    );
    expect(health.status).toBe('needs_reauth');
    expect(health.lastRefreshFailureKind).toBe('unknown');
    expect(health.providerHttpStatus).toBeUndefined();
  });

  it.each([200, 403])('checks a changed GitHub credential once and makes zero idle /user requests after %s', async status => {
    let clock = now;
    let revision = credentialRevision;
    let profileStatus: QualifiedConnectedAccountProfileV4['status'] = 'connected';
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response(JSON.stringify(status === 200 ? { id: 12345, login: 'octocat' } : { message: 'API rate limit exceeded' }), {
        status, headers: status === 403 ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 3_600_000) / 1000) } : {},
      });
    }));
    const harness = await createHarness({ github: true, clock: () => clock,
      onCredentialMutation: next => { revision = next; },
      profile: () => ({ credentialRevision: revision, status: profileStatus, kind: null }) });
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    expect(requests).toEqual(['https://api.github.com/user']);
    expect(harness.persistedMetadata().providerIdentity).toEqual(status === 200 ? { accountId: '12345' } : undefined);
    profileStatus = status === 200 ? 'connected' : 'refresh_failed_retryable';
    // Health publication and unrelated scheduler wakes are not credential demand.
    for (let minute = 0; minute < 10; minute++) {
      clock += 60_000;
      expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    }
    expect(requests).toHaveLength(1);
    revision = 'csr_bcdefghijklmnopqrstuvw';
    // The server snapshot and profile advance together at the credential boundary.
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    expect(requests).toHaveLength(2);
  });

  it('returns the admitted profile and revision without a metadata relist when refresh is unnecessary', async () => {
    const harness = await createHarness({});
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({
      ref: { service: openAiService, accountId: 'work' }, status: 'connected',
      authenticationModeId: 'api-key', revisionSemantics: 'revisioned', credentialRevision,
      configurationReady: false, configurationRevision: null, expiresAt: now + 3_600_000, scopes: [],
    });
    expect(await harness.coordinator.refreshQualifiedConnectedAccountCredentialForSpawnPreflight({ profile }))
      .toEqual({ status: 'ready', profile });
    expect(harness.listScheduledAccounts).not.toHaveBeenCalled();
    expect(harness.readQualifiedCredential).not.toHaveBeenCalled();
  });

  it('returns the acknowledged credential revision when spawn health backfills a legacy GitHub subject', async () => {
    let revision = credentialRevision;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 12345, login: 'octocat' }), { status: 200 })));
    const harness = await createHarness({ github: true,
      onCredentialMutation: next => { revision = next; },
      profile: () => ({ credentialRevision: revision }),
    });
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({
      ref: { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'work' }, status: 'connected',
      authenticationModeId: 'fine-grained-pat', revisionSemantics: 'revisioned', credentialRevision,
      configurationReady: false, configurationRevision: null, expiresAt: null, scopes: [],
    });
    const result = await harness.coordinator.refreshQualifiedConnectedAccountCredentialForSpawnPreflight({ profile });
    expect(revision).not.toBe(credentialRevision);
    expect(result).toMatchObject({ status: 'ready', profile: { credentialRevision: revision } });
  });

  it.each(['reconnect', 'reconnect-flag', 'reconnect-status', 'healthy', 'replaced', 'unrevisioned', 'missing', 'other-account'] as const)(
    'reads exact fresh reconnect health without listing the service cohort (%s)', async (scenario) => {
      const profile = QualifiedConnectedAccountProfileV4Schema.parse({
        ref: { service: openAiService, accountId: 'work' }, status: 'connected',
        authenticationModeId: 'api-key', revisionSemantics: 'revisioned', credentialRevision,
        configurationReady: false, configurationRevision: null, expiresAt: null, scopes: [],
      });
      const needsReauth = scenario !== 'healthy';
      const reconnect = scenario === 'reconnect' || scenario === 'reconnect-flag' || scenario === 'reconnect-status';
      const snapshot = scenario === 'missing' ? null : QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: scenario === 'other-account' ? { service: openAiService, accountId: 'other' } : profile.ref,
        authenticationModeId: 'api-key',
        revisionSemantics: scenario === 'unrevisioned' ? 'legacy_unfenced' : 'revisioned',
        credentialRevision: scenario === 'unrevisioned' ? null
          : scenario === 'replaced' ? 'csr_bcdefghijklmnopqrstuvw' : credentialRevision,
        configurationRevision: null,
        content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
          payload: { v: 1, values: { token: 'sk-qualified-current' } }, randomBytes: length => new Uint8Array(length) }),
        metadata: { scopes: [] },
        health: { v: 1, status: needsReauth && scenario !== 'reconnect-flag' ? 'needs_reauth' : 'connected',
          reconnectRequired: needsReauth && scenario !== 'reconnect-status' },
      });
      let current = snapshot;
      const harness = await createHarness({
        credentialSnapshot: () => current,
        // The cohort deliberately places the requested account after 1,000 unrelated accounts.
        listedProfiles: [...Array.from({ length: 1_000 }, (_, index) => ({
          ...profile, ref: { service: openAiService, accountId: `unrelated-${index}` }, status: 'needs_reauth' as const,
        })), { ...profile, status: reconnect ? 'needs_reauth' : 'connected' }],
      });
      const expected = reconnect ? 'reconnect_required' : scenario === 'healthy' ? 'ready' : 'refresh_failed';
      expect(await harness.coordinator.refreshQualifiedConnectedAccountCredentialForSpawnPreflight({ profile }))
        .toMatchObject({ status: expected });
      expect(harness.listScheduledAccounts).not.toHaveBeenCalled();
      if (reconnect) {
        expect(harness.readQualifiedCredential).toHaveBeenCalledOnce();
        expect(harness.readQualifiedCredential).toHaveBeenCalledWith(expect.objectContaining({ token: 'happier-token', ref: profile.ref }));
        // A second check must see the newly committed health immediately.
        current = snapshot && { ...snapshot, health: { v: 1, status: 'connected', reconnectRequired: false } };
        expect(await harness.coordinator.refreshQualifiedConnectedAccountCredentialForSpawnPreflight({ profile }))
          .toMatchObject({ status: 'ready', profile: { ref: profile.ref, credentialRevision } });
        expect(harness.listScheduledAccounts).not.toHaveBeenCalled();
      }
    },
  );

  it('rejects reconnect results when Account authority is revoked during the exact read', async () => {
    let current = true;
    const harness = await createHarness({
      health: { v: 1, status: 'needs_reauth', reconnectRequired: true },
      isAccountRuntimeCurrent: async () => current,
      onCredentialRead: () => { current = false; },
    });
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({
      ref: { service: openAiService, accountId: 'work' }, status: 'connected',
      authenticationModeId: 'api-key', revisionSemantics: 'revisioned', credentialRevision,
      configurationReady: false, configurationRevision: null, expiresAt: null, scopes: [],
    });
    expect(await harness.coordinator.refreshQualifiedConnectedAccountCredentialForSpawnPreflight({ profile }))
      .toEqual({ status: 'refresh_failed' });
    expect(harness.readQualifiedCredential).toHaveBeenCalledOnce();
    expect(harness.listScheduledAccounts).not.toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
  });

  it('observes a changed health fact at the next status admission and publishes recovery', async () => {
    let clock = now;
    const diagnostic = vi.spyOn(logger, 'debug');
    const harness = await createHarness({
      clock: () => clock,
      health: { v: 1, status: 'connected', reconnectRequired: false },
    });
    await harness.coordinator.tickOnce();
    expect(harness.readQualifiedCredential).toHaveBeenCalledOnce();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    // Finite status work consumes its admitted snapshot. A later admission
    // acquires the persisted health again, including intervening failures.
    harness.setPersistedHealth({ v: 1, status: 'refresh_failed_retryable', reconnectRequired: false,
      providerErrorCode: 'materialization_failed' });
    clock += 300_000;
    await harness.createCoordinator().tickOnce();
    expect(harness.readQualifiedCredential).toHaveBeenCalledTimes(2);
    expect(harness.mutateCredentialHealth).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      patch: expect.objectContaining({ health: { v: 1, status: 'connected', reconnectRequired: false } }),
    }));
    expect(diagnostic.mock.calls.filter(([event]) => event === '[ConnectedServiceRefreshCoordinator] credential health write'))
      .toEqual([['[ConnectedServiceRefreshCoordinator] credential health write', expect.objectContaining({
        beforeStatus: 'refresh_failed_retryable', afterStatus: 'connected', substantiveChanged: true,
      })]]);
  });
  it('does not repeat health PATCHes across coordinator recovery at two settled status intervals', async () => {
    let clock = now;
    const harness = await createHarness({ clock: () => clock, profile: () => ({ kind: 'oauth', expiresAt: null }) });
    await harness.coordinator.tickOnce();
    expect(harness.mutateCredentialHealth).toHaveBeenCalledOnce();
    for (let interval = 0; interval < 2; interval++) {
      clock += 300_000;
      await harness.createCoordinator().tickOnce();
    }
    expect(harness.mutateCredentialHealth).toHaveBeenCalledOnce();
  });

  it.each([false, true])('writes only changed status facts and records payload-free diagnostics (timestamp-only=%s)', async timestampOnly => {
    const diagnostic = vi.spyOn(logger, 'debug');
    const harness = await createHarness(timestampOnly ? { health: {
      v: 1, status: 'connected', reconnectRequired: false, lastRefreshAttemptAt: 1,
      lastRefreshSuccessAt: 1, lastRuntimeAuthFailureAt: 1,
    } } : {});
    await harness.coordinator.tickOnce();
    expect(harness.mutateCredentialHealth).toHaveBeenCalledTimes(timestampOnly ? 0 : 1);
    expect(diagnostic.mock.calls.filter(([event]) => event === '[ConnectedServiceRefreshCoordinator] credential health write'))
      .toEqual(timestampOnly ? [] : [['[ConnectedServiceRefreshCoordinator] credential health write', {
        path: 'status', serviceKind: 'openai', beforeStatus: timestampOnly ? 'connected' : null, afterStatus: 'connected',
        account: { service: openAiService, accountId: 'work' }, credentialRevision, configurationRevision: null,
        substantiveChanged: !timestampOnly,
      }]]);
  });
  it('publishes recovery from a committed retryable health failure and then keeps it settled', async () => {
    const harness = await createHarness({ health: { v: 1, status: 'refresh_failed_retryable', reconnectRequired: false,
      providerErrorCode: 'network_error', lastRefreshFailureAt: now - 1 } });
    await harness.coordinator.tickOnce();
    expect(harness.mutateCredentialHealth).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ patch: expect.objectContaining({
      health: { v: 1, status: 'connected', reconnectRequired: false },
    }) }));
    await harness.createCoordinator().tickOnce();
    expect(harness.mutateCredentialHealth).toHaveBeenCalledOnce();
  });
  it('parks healthy non-expiring credentials across unrelated wakes and rechecks a replaced revision', async () => {
    let clock = now;
    let revision = credentialRevision;
    const harness = await createHarness({ clock: () => clock,
      profile: () => ({ credentialRevision: revision }),
      // Advance the real clock boundary while the credential HTTP response is in flight.
      onCredentialRead: () => { clock = Math.max(clock, now + 40_000); } });
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    const reads = harness.readQualifiedCredential.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    for (let wake = 0; wake < 3; wake++) {
      harness.coordinator.registerSpawnTarget({ pid: 120 + wake, agentId: 'codex',
        materializationKey: `inventory-wake-${wake}`, connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} } });
      expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    }
    clock += 300_000;
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    expect(harness.readQualifiedCredential).toHaveBeenCalledTimes(reads);
    revision = 'csr_bcdefghijklmnopqrstuvw';
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    expect(harness.readQualifiedCredential.mock.calls.length).toBeGreaterThan(reads);
    expect(harness.mutateCredentialHealth).toHaveBeenCalledTimes(2);
  });

  it('schedules the real OAuth refresh window rather than a health polling interval', async () => {
    const empty = await createHarness({ noScheduledAccounts: true });
    expect(await empty.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: null });
    let clock = now;
    const harness = await createHarness({ clock: () => clock,
      profile: () => ({ kind: 'oauth', expiresAt: now + 360_000 }) });
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 300_000 });
    clock += 299_999;
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 1 });
    expect(harness.mutateCredentialHealth).toHaveBeenCalledOnce();
  });

  it('returns the existing OAuth recovery deadline when a null-expiry account is unavailable', async () => {
    const harness = await createHarness({ credentialAvailable: false, profile: () => ({ kind: 'oauth' }) });
    await expect(harness.coordinator.tickOnce()).rejects.toBeInstanceOf(AggregateError);
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 30_000 });
  });

  it('uses the acquisition cadence for every failed OAuth observation without an escalating ladder', async () => {
    let clock = now;
    const harness = await createHarness({ clock: () => clock, credentialAvailable: false, healthProbeIntervalMs: 17_000, profile: () => ({ kind: 'oauth' }) });
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(harness.coordinator.tickOnce()).rejects.toBeInstanceOf(AggregateError);
      expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 17_000 });
      clock += 17_000;
    }
  });

  it('retains the existing recovery interval after a slow failed credential observation', async () => {
    let clock = now;
    const harness = await createHarness({ clock: () => clock, credentialAvailable: false, profile: () => ({ kind: 'oauth' }),
      onCredentialRead: () => { clock = Math.max(clock, now + 90_000); } });
    await expect(harness.coordinator.tickOnce()).rejects.toBeInstanceOf(AggregateError);
    const reads = harness.readQualifiedCredential.mock.calls.length;
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 30_000 });
    expect(harness.readQualifiedCredential).toHaveBeenCalledTimes(reads);
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
  });
  it('rearms a replaced credential without inheriting the old revision recovery deadline', async () => {
    let revision = credentialRevision;
    const harness = await createHarness({ credentialAvailable: false,
      profile: () => ({ credentialRevision: revision, kind: 'oauth' }) });
    await expect(harness.coordinator.tickOnce()).rejects.toBeInstanceOf(AggregateError);
    const reads = harness.readQualifiedCredential.mock.calls.length;
    expect(await harness.coordinator.tickOnce()).toEqual({ nextAutomaticRunAfterMs: 30_000 });
    expect(harness.readQualifiedCredential).toHaveBeenCalledTimes(reads);
    revision = 'csr_bcdefghijklmnopqrstuvw';
    await expect(harness.coordinator.tickOnce()).rejects.toBeInstanceOf(AggregateError);
    expect(harness.readQualifiedCredential.mock.calls.length).toBeGreaterThan(reads);
  });
  it('runs a real current plugin status leaf from the existing scheduled trigger and settles exact-revision health', async () => {
    const harness = await createHarness({});
    harness.coordinator.registerSpawnTarget({
      pid: 123,
      agentId: 'codex',
      materializationKey: 'session-1',
      // The Voice Account is scheduled from the Home's account listing, not
      // projected as a Codex native subscription binding.
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} },
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

  it('does not publish health or report a refreshed credential after the owning plugin registry is retired', async () => {
    const harness = await createHarness({ retireRegistry: true });

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

  it.each(['absent', 'indeterminate'] as const)('refuses refresh without credential or provider effects when V4 capability is %s', async (v4Support) => {
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);
    const harness = await createHarness({ v4Support });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).rejects.toMatchObject({ code: 'connected_account_capability_indeterminate' });

    expect(harness.readQualifiedCredential).not.toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(harness.api.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('uses the qualified HTTP reader when no runtime is injected and never reads the scalar route', async () => {
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);
    // HTTP is the Home boundary; default credential resolution and mode parsing stay real.
    const credentialRead = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/v4/connect/qualified/credential');
      expect(parsed.searchParams.has('ref')).toBe(true);
      return { status: 404, data: { error: 'not_found' } };
    });
    const harness = await createHarness({ omitQualifiedRuntime: true });

    await expect(harness.coordinator.refreshConnectedServiceCredentialForQuota({
      serviceId: 'openai-codex',
      profileId: 'work',
      force: true,
    })).resolves.toBeNull();

    expect(harness.readQualifiedCredential).not.toHaveBeenCalled();
    expect(harness.mutateCredentialHealth).not.toHaveBeenCalled();
    expect(credentialRead).toHaveBeenCalledOnce();
    expect(harness.api.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(harness.api.acquireConnectedServiceRefreshLease).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

});
