import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import {
  buildConnectedServiceCredentialRecord,
  openQualifiedConnectedAccountContentEnvelope,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  QualifiedConnectedAccountCredentialMutationV4Schema,
  QualifiedConnectedAccountRefreshLeaseV4Schema,
  sealQualifiedConnectedAccountContentEnvelope,
  QualifiedConnectedAccountProfileV4Schema,
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  type QualifiedConnectedAccountCredentialSnapshotV4,
  type QualifiedConnectedAccountRef,
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceBindingsV2IngressSchema,
} from '@happier-dev/protocol';
import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { createPluginReloadController, type PluginReloadController } from '@/plugins/runtime/reload/controller';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import type { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { createDaemonConnectedAccountPurposeBindingRuntime } from '../purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';

const service = Object.freeze({ pluginId: 'happier.agent.codex', localId: 'openai-codex' });
const account = Object.freeze({ service, accountId: 'work' });
const firstRevision = 'csr_abcdefghijklmnopqrstuv';
const secondRevision = 'csr_bcdefghijklmnopqrstuvw';
const thirdRevision = 'csr_cdefghijklmnopqrstuvwx';
const now = 1_000_000;

export async function createBuiltInQualifiedRefreshHarness(input: Readonly<{
  controller?: PluginReloadController;
  happyHomeDir?: string;
  runtimeRegistry?: ConnectedServiceRuntimeRegistry;
  readGroup?: NonNullable<ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['qualifiedConnectedAccountRuntime']>['readGroup'];
  onQualifiedConnectedAccountCredentialUpdated?: NonNullable<ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['qualifiedConnectedAccountRuntime']>['onCredentialUpdated'];
  createPurposeRuntime?: (resources: Readonly<{
    controller: PluginReloadController;
    happyHomeDir: string;
    establishedRuntimeOwner: ReturnType<typeof createQualifiedConnectedAccountEstablishedRuntimeOwner>;
    credentials: Credentials;
    api: ApiClient;
    readCredential: (input?: Readonly<{ ref: QualifiedConnectedAccountRef }>) => Promise<Readonly<{ credentialRevision: string }>>;
  }>) => ReturnType<typeof createDaemonConnectedAccountPurposeBindingRuntime>;
}> = {}) {
  // Production also constructs the real purpose owner before publishing the registry that
  // consumes it. No already-admitted registry is patched with a replacement internal owner.
  const ownsHome = input.happyHomeDir === undefined;
  const happyHomeDir = input.happyHomeDir ?? await mkdtemp(join(tmpdir(), 'happier-qualified-refresh-'));
  const controller = input.controller ?? createPluginReloadController({ happyHomeDir });
  const credentials: Credentials = {
    token: 'happier-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(8),
    },
  };
  let qualifiedRevision = firstRevision;
  let qualifiedMetadata: QualifiedConnectedAccountCredentialSnapshotV4['metadata'] = {
    providerIdentity: { accountId: 'work' }, displayName: 'work', scopes: ['openid'],
  };
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
      },
    },
    randomBytes: (length) => new Uint8Array(length),
  });
  let legacyRecord = buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: null,
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
  const backupAccount = { service, accountId: 'backup' };
  const backupCredential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
    ref: backupAccount, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
    credentialRevision: firstRevision, configurationRevision: null,
    content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
      payload: { v: 1, values: { accessToken: 'access-backup', refreshToken: 'refresh-backup',
        idToken: 'id-backup', providerAccountId: 'backup' } }, randomBytes: (length) => new Uint8Array(length) }),
    metadata: { providerIdentity: { accountId: 'backup' }, displayName: 'backup', scopes: ['openid'] },
  });
  const backupLegacyRecord = buildConnectedServiceCredentialRecord({
    now, serviceId: 'openai-codex', profileId: 'backup', kind: 'oauth', expiresAt: null,
    oauth: { accessToken: 'access-backup', refreshToken: 'refresh-backup', idToken: 'id-backup',
      providerAccountId: 'backup', providerEmail: null, scope: null, tokenType: 'Bearer' },
  });
  const readCredential = vi.fn(async (input?: Readonly<{ ref: QualifiedConnectedAccountRef }>) => {
    const ref = input?.ref ?? account;
    if (ref.service.pluginId !== service.pluginId || ref.service.localId !== service.localId) {
      throw new Error('Fixture credential service unavailable');
    }
    if (ref.accountId === backupAccount.accountId) {
      if (backupCredential.revisionSemantics !== 'revisioned') throw new Error('Backup fixture credential must be revisioned');
      return backupCredential;
    }
    if (ref.accountId !== account.accountId) throw new Error('Fixture credential account unavailable');
    const credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account,
      authenticationModeId: 'oauth',
      revisionSemantics: 'revisioned',
      credentialRevision: qualifiedRevision,
      configurationRevision: null,
      content: qualifiedContent,
      metadata: qualifiedMetadata,
    });
    if (credential.revisionSemantics !== 'revisioned') throw new Error('Work fixture credential must be revisioned');
    return credential;
  });
  const establishedRuntimeOwner =
    createQualifiedConnectedAccountEstablishedRuntimeOwner({
      reloadController: controller,
      credentials,
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
    getConnectedServiceCredentialPlain: vi.fn(async (input?: Readonly<{ serviceId: string; profileId: string }>) => {
      if (input && (input.serviceId !== 'openai-codex' || !['work', 'backup'].includes(input.profileId))) return null;
      const isBackup = input?.profileId === 'backup';
      return {
        content: { t: 'plain' as const, v: isBackup ? backupLegacyRecord : legacyRecord },
        revisionSemantics: 'revisioned' as const,
        credentialRevision: isBackup ? firstRevision : qualifiedRevision,
      };
    }),
    getConnectedServiceCredentialSealed: vi.fn(async () => null),
    updateConnectedServiceCredentialHealth: vi.fn(async () => undefined),
  } as unknown as ApiClient;
  const acquireRefreshLease = vi.fn(async (input: Readonly<{ token: string; lease: unknown }>) => {
    const lease = QualifiedConnectedAccountRefreshLeaseV4Schema.parse(input.lease);
    return {
      acquired: lease.expectedCredentialRevision === qualifiedRevision,
      leaseUntil: now + 60_000,
      ownerId: lease.ownerId,
      credentialRevision: qualifiedRevision,
    };
  });
  const mutateCredentialHealth = vi.fn(async () => ({
    success: true as const,
    credentialRevision: qualifiedRevision,
    configurationRevision: null,
  }));
  const mutateCredential = vi.fn(async (input: Readonly<{
    token: string;
    mutation: unknown;
  }>) => {
    const mutation =
      QualifiedConnectedAccountCredentialMutationV4Schema.parse(
        input.mutation,
      );
    if (mutation.expectedCredentialRevision !== qualifiedRevision) {
      throw new Error('credential_revision_conflict');
    }
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
    qualifiedRevision = qualifiedRevision === firstRevision ? secondRevision
      : qualifiedRevision === secondRevision ? thirdRevision
        // The server storage boundary mints a fresh opaque revision per CAS.
        : ConnectedServiceCredentialRevisionV1Schema.parse(`csr_${randomBytes(24).toString('base64url')}`);
    legacyRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: opened.values.expiresAtMs === undefined ? null : Number(opened.values.expiresAtMs),
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
      credentialRevision: qualifiedRevision,
      configurationRevision: null,
    };
  });
  const coordinator = new ConnectedServiceRefreshCoordinator({
    api,
    credentials,
    machineIdProvider: () => 'machine-1',
    ownerIdProvider: () => 'machine-1:runtime-1',
    activeServerDir: join(happyHomeDir, 'active'),
    baseDir: join(happyHomeDir, 'materialized'),
    refreshWindowMs: 60_000,
    refreshLeaseMs: 30_000,
    now: () => now,
    runtimeRegistry: input.runtimeRegistry,
    resolveQualifiedPurposeBindingSnapshot: async ({ agentId, connectedServicesBindingsRaw }) => {
      const bindings = ConnectedServiceBindingsV2IngressSchema.safeParse(connectedServicesBindingsRaw);
      return bindings.success ? resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId,
        bindings: bindings.data, contributions: admittedRuntime.registry.contributes }) : null;
    },
    qualifiedConnectedAccountRuntime: {
      resolvePeerClass: () => 'advertised_v4',
      establishedRuntimeOwner,
      readCredential,
      ...(input.readGroup ? { readGroup: input.readGroup } : {}),
      acquireRefreshLease,
      mutateCredential,
      mutateCredentialHealth,
      ...(input.onQualifiedConnectedAccountCredentialUpdated
        ? { onCredentialUpdated: input.onQualifiedConnectedAccountCredentialUpdated } : {}),
    },
  });

  let admittedRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  let purposeRuntime: ReturnType<typeof createDaemonConnectedAccountPurposeBindingRuntime> | undefined;
  try {
    purposeRuntime = input.createPurposeRuntime?.({ controller, happyHomeDir, establishedRuntimeOwner,
      credentials, api, readCredential });
    admittedRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir, controller,
      runtimeOptions: { pluginIds: [service.pluginId], ...(purposeRuntime ? { connectedAccounts: purposeRuntime.owner } : {}),
        // Keep the real HTTP policy, DNS admission and buffering above the genuine socket boundary.
        networkDependencies: {
          resolveNetworkAddresses: async () => ['8.8.8.8'],
          async openPinnedStream(request) {
            const response = await globalThis.fetch(request.url, {
              method: request.method,
              headers: request.headers,
              ...(request.body === undefined ? {} : { body: new Uint8Array(request.body).buffer }),
              signal: request.signal,
            });
            const reader = response.body?.getReader();
            return {
              status: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              contentLength: null,
              async read() {
                const next = await reader?.read();
                return next && !next.done ? next.value : null;
              },
              cancel() { void reader?.cancel(); },
            };
          },
        },
      },
    });
  } catch (error) {
    await controller.shutdown();
    if (ownsHome) await rm(happyHomeDir, { recursive: true, force: true });
    throw error;
  }
  return {
    coordinator, api, admittedRuntime, registry: admittedRuntime.registry, controller, establishedRuntimeOwner, credentials, happyHomeDir, purposeRuntime,
    account, service, firstRevision, secondRevision, thirdRevision, now,
    acquireRefreshLease, mutateCredential, mutateCredentialHealth, readCredential,
    async dispose() {
      try { await admittedRuntime.dispose(); }
      finally { if (ownsHome) await rm(happyHomeDir, { recursive: true, force: true }); }
    },
  };
}

/** Real selection, purpose resolution and file materialization over the same HTTP/storage fixture. */
export async function createBuiltInQualifiedNativeRefreshHarness(
  resources: Pick<NonNullable<Parameters<typeof createBuiltInQualifiedRefreshHarness>[0]>, 'controller' | 'happyHomeDir' | 'runtimeRegistry' | 'onQualifiedConnectedAccountCredentialUpdated'> = {},
) {
  let group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1,
    ref: { service, groupId: 'pool' }, incarnation: 'pool-lifetime', displayName: 'Pool',
    policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, activeConnectedAccountId: 'work', generation: 7,
    runtimeStateRevision: 0, state: {}, createdAt: 0, updatedAt: 0,
    members: ['work', 'backup'].map((connectedAccountId) => ({ v: 1, connectedAccountId,
      priority: 100, enabled: true, state: {}, createdAt: 0, updatedAt: 0 })) });
  let readCurrentCredential!: (input?: Readonly<{ ref: QualifiedConnectedAccountRef }>) => Promise<Readonly<{ credentialRevision: string }>>;
  const listAccounts = async () => {
    const credential = await readCurrentCredential();
    const backup = await readCurrentCredential({ ref: { service, accountId: 'backup' } });
    return { service, accounts: ['work', 'backup'].map((accountId) =>
      QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId },
        status: 'connected', authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
        credentialRevision: accountId === 'work' ? credential.credentialRevision : backup.credentialRevision, configurationReady: true,
        configurationRevision: null, kind: 'oauth', expiresAt: null, scopes: [],
        providerIdentity: { accountId } })) };
  };
  // The real foreground claim compares its exact lease against the Account's
  // durable selected purpose; an empty store is not a selected Account launch.
  let stored = QualifiedConnectedAccountPurposeBindingsV1Schema.parse({ v: 1, bindings: [{
    purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
    target: { kind: 'account', account: { service, accountId: 'work' } },
  }] });
  const listeners = new Set<() => void>();
  let api!: ApiClient;
  const harness = await createBuiltInQualifiedRefreshHarness({ ...resources,
    readGroup: async ({ service: requestedService, groupId }) => (
      requestedService.pluginId === service.pluginId
      && requestedService.localId === service.localId
      && groupId === group.ref.groupId ? group : null
    ),
    createPurposeRuntime(prepared) {
      readCurrentCredential = prepared.readCredential;
      api = Object.assign(prepared.api, {
        listConnectedServiceProfiles: async () => ({ serviceId: 'openai-codex' as const,
          profiles: [{ profileId: 'work', status: 'connected' as const, kind: 'oauth' as const },
            { profileId: 'backup', status: 'connected' as const, kind: 'oauth' as const }] }),
      });
      return createDaemonConnectedAccountPurposeBindingRuntime({
        establishedRuntimeOwner: prepared.establishedRuntimeOwner, reloadController: prepared.controller,
        resolveQualifiedConnectedAccountV4Support: () => 'advertised',
        qualifiedApi: { listAccounts, listGroups: async () => ({ groups: [group] }), readGroup: async () => group },
        store: { read: async () => stored, update: async (mutate) => {
          stored = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(mutate(stored));
          for (const listener of listeners) listener();
          return stored;
        }, subscribe(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; } },
      });
    },
  });
  const purposeRuntime = harness.purposeRuntime;
  if (!purposeRuntime) { await harness.dispose(); throw new Error('Real native purpose runtime unavailable'); }
  return { ...harness, api, purposeRuntime,
    qualifiedApi: { listAccounts, readGroup: async () => group },
    switchGroupAccount(accountId: 'work' | 'backup') {
      group = QualifiedConnectedAccountGroupV4Schema.parse({ ...group,
        activeConnectedAccountId: accountId, generation: group.generation + 1,
        runtimeStateRevision: group.runtimeStateRevision + 1 });
      purposeRuntime.invalidate();
    },
  };
}
