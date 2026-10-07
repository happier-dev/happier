import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, FeaturesResponseSchema, QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountListResponseV4Schema, QualifiedConnectedAccountRefreshLeaseV4Schema, sealAccountScopedBlobCiphertext, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import type { ApiClient } from '@/api/api';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from './qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createConnectedAccountPurposeBindingOwner } from './purposeBindings/ConnectedAccountPurposeBindingOwner';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';
import { ConnectedServiceRefreshCoordinator, persistConnectedServiceCredentialHealthForMaterializationFailure } from './refresh/ConnectedServiceRefreshCoordinator';
import { readQualifiedConnectedAccountCredentialV4, acquireQualifiedConnectedAccountRefreshLeaseV4, mutateQualifiedConnectedAccountCredentialV4, mutateQualifiedConnectedAccountCredentialHealthV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol';
import { ConnectedServiceAuthGroupSwitchCoordinator, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from './accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { buildQualifiedConnectedAccountAuthGroupSwitchState } from './accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
let lease: PluginRuntimeRegistryLease;
let directory: string;
let providerRejectsRefresh = false;
let groupActiveAccount: { service: typeof service; accountId: string } | null = null;
const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({
  reloadController: pluginReloadController,
  credentials,
  getAccountEncryptionMode: async () => 'e2ee',
  configuration: {
    read: async () => null,
    secrets: { admit: async () => undefined, has: async () => false, read: async () => null },
  },
});
const purposeOwner = createConnectedAccountPurposeBindingOwner({
  store: { read: async () => ({ v: 1, bindings: [] }), update: async (mutate) => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
  selectTarget: async () => { throw new Error('unexpected selection'); },
  resolveTarget: async (target) => {
    const account = target.kind === 'account' ? target.account : groupActiveAccount;
    return account ? { displayName: 'QA fixture', account } : null;
  },
  resolveCredentialRevision: (account, signal) => established.readCredentialRevision({ account, signal }),
  materializeAccount: async ({ account, request, signal, credentialRevisionBasis }) => {
    const invoked = await established.invokeWithReceipt({ account, operation: { kind: 'materialize', request }, signal });
    credentialRevisionBasis?.captureCredentialRevision(invoked.basis.credentialRevision);
    return invoked.result;
  },
  projectTargetAccounts: async () => { throw new Error('unexpected listing'); },
  assertTargetAccountMaterializable: async () => { throw new Error('unexpected listed materialization'); },
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'happier-qualified-spawn-'));
  lease = await pluginReloadController.acquireRuntimeRegistry({
    resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({
      contributes: getResolvedContributionRegistry(),
      pluginIds: ['happier.agent.codex'],
      resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({ kind: 'development', registeredRootId: `qualified-spawn:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1 }),
      connectedAccounts: purposeOwner,
      qualifiedConnectedAccountEstablishedRuntimeOwner: established,
      networkDependencies: {
        resolveNetworkAddresses: async () => ['8.8.8.8'],
        openPinnedStream: async (request) => {
          if (request.url !== 'https://auth.openai.com/oauth/token') throw new Error('Unexpected provider transport');
          const body = new TextEncoder().encode(JSON.stringify(providerRejectsRefresh
            ? { error: 'invalid_grant' }
            : { access_token: 'refreshed-access', refresh_token: 'refreshed-refresh', id_token: 'fixture-id', expires_in: 3600 }));
          let delivered = false;
          return { status: providerRejectsRefresh ? 400 : 200, headers: {}, contentLength: body.length, read: async () => { if (delivered) return null; delivered = true; return body; }, cancel() {} };
        },
      },
    }),
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await lease?.release();
  await pluginReloadController.shutdown({ timeoutMs: 5_000 });
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('qualified first-party spawn credential authority', () => {
  it('does not write scalar health when materialization has no qualified snapshot basis', async () => {
    const scalarWrite = vi.fn(async () => undefined);
    // Retained caller shape must not regain scalar mutation authority.
    const input = {
      api: { updateConnectedServiceCredentialHealth: scalarWrite },
      binding: { serviceId: 'openai-codex', profileId: 'unproven' }, now: 10,
      diagnostic: { code: 'disk_failure', providerId: 'codex', serviceId: 'happier.agent.codex/openai-codex', severity: 'blocking' as const, reason: 'disk_failure' },
    } as const;
    await persistConnectedServiceCredentialHealthForMaterializationFailure(input);
    expect(scalarWrite).not.toHaveBeenCalled();
  });
  it('persists qualified materialization failure health at its revision without a scalar write', async () => {
    const account = { service, accountId: 'device-health' };
    let patch: unknown;
    const http = vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe('/v4/connect/qualified/credential/health');
      patch = body;
      return { status: 200, data: { success: true, credentialRevision: revision, configurationRevision: null } };
    });
    await persistConnectedServiceCredentialHealthForMaterializationFailure({
      binding: { serviceId: 'openai-codex', profileId: account.accountId },
      qualifiedCredential: { token: credentials.token, ref: account, expectedCredentialRevision: revision, expectedConfigurationRevision: null },
      diagnostic: { code: 'disk_failure', providerId: 'codex', serviceId: 'happier.agent.codex/openai-codex', severity: 'blocking', reason: 'disk_failure' },
      now: 10,
    });
    expect(patch).toMatchObject({ ref: account, expectedCredentialRevision: revision, health: { status: 'refresh_failed_retryable', reconnectRequired: false } });
    http.mockRestore();
  });
  it.each([
    { authenticationModeId: 'device', refresh: false, groupRecovery: false, cachedFeatures: true },
    { authenticationModeId: 'device', refresh: false, groupRecovery: false, cachedFeatures: false },
    { authenticationModeId: 'oauth', refresh: false, groupRecovery: false, cachedFeatures: true },
    { authenticationModeId: 'device', refresh: true, groupRecovery: false, cachedFeatures: true },
    { authenticationModeId: 'device', refresh: true, groupRecovery: true, cachedFeatures: true },
  ])('materializes V4 $authenticationModeId with refresh=$refresh groupRecovery=$groupRecovery cachedFeatures=$cachedFeatures without a legacy credential read', async ({ authenticationModeId, refresh, groupRecovery, cachedFeatures }) => {
    providerRejectsRefresh = groupRecovery;
    const account = { service, accountId: `${authenticationModeId}-${refresh}-${groupRecovery}-${cachedFeatures}` };
    const backup = { service, accountId: `${account.accountId}-backup` };
    groupActiveAccount = groupRecovery ? account : null;
    const content = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential', accountMode: 'e2ee', material: credentials.encryption,
      payload: { v: 1, values: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id', providerAccountId: 'fixture-account', expiresAtMs: String(Date.now() + 3_600_000) } },
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });
    let currentRevision = revision;
    let expiresAt = Date.now() + (refresh ? 120_000 : 3_600_000);
    let snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId, revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null, content, metadata: { scopes: [] } });
    let primaryNeedsReauth = false;
    let activeAccountId = account.accountId;
    let group = QualifiedConnectedAccountGroupV4Schema.parse({
      v: 1, ref: { service, groupId: 'recovery' }, incarnation: 'recovery-1', displayName: 'Recovery',
      policy: { v: 1, autoSwitch: true }, activeConnectedAccountId: activeAccountId,
      generation: 1, runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1,
      members: [account, backup].map((ref, index) => ({ v: 1, connectedAccountId: ref.accountId, priority: index + 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 })),
    });
    const listAccounts = async () => QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [
      { ref: account, authenticationModeId, status: primaryNeedsReauth ? 'needs_reauth' : 'connected', kind: 'oauth', expiresAt, revisionSemantics: 'revisioned', credentialRevision: currentRevision, configurationReady: true, configurationRevision: null, scopes: [] },
      ...(groupRecovery ? [{ ref: backup, authenticationModeId, status: 'connected', kind: 'oauth', expiresAt: Date.now() + 3_600_000, revisionSemantics: 'revisioned', credentialRevision: revision, configurationReady: true, configurationRevision: null, scopes: [] }] : []),
    ] });
    const loadState = async () => ({
      ...buildQualifiedConnectedAccountAuthGroupSwitchState({ group, profiles: (await listAccounts()).accounts }),
      serviceId: 'happier.agent.codex/openai-codex',
    });
    const switchCoordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<string>(),
      nowMs: Date.now, quotaFreshnessMs: 60_000, loadState,
      // This is the persistent group CAS boundary, not a mocked selector.
      commitSwitch: async (input) => {
        expect(input.expectedGeneration).toBe(group.generation);
        activeAccountId = input.toProfileId;
        groupActiveAccount = activeAccountId === backup.accountId ? backup : account;
        group = { ...group, activeConnectedAccountId: activeAccountId, generation: group.generation + 1 };
        return loadState();
      },
      applyGeneration: async () => ({ ok: true }),
    });
    // HTTP is the genuine system boundary. Persistence, envelope opening, plugin
    // invocation, purpose authority, and launch-file materialization remain real.
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v4/connect/qualified/credential') return { status: 200, data: activeAccountId === backup.accountId ? { ...snapshot, ref: backup } : snapshot };
      throw new Error(`Unexpected HTTP read: ${path}`);
    });
    const healthPatches: unknown[] = [];
    const healthWrites = vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe('/v4/connect/qualified/credential/health');
      healthPatches.push(body);
      primaryNeedsReauth = true;
      return { status: 200, data: { success: true, credentialRevision: currentRevision, configurationRevision: null } };
    });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v4/connect/qualified/credential/refresh-lease') {
        const request = QualifiedConnectedAccountRefreshLeaseV4Schema.parse(body);
        expect(request.expectedCredentialRevision).toBe(currentRevision);
        return { status: 200, data: { acquired: true, leaseUntil: Date.now() + request.ttlMs, ownerId: request.ownerId, credentialRevision: currentRevision } };
      }
      if (path === '/v4/connect/qualified/credential') {
        const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(body);
        expect(mutation.ref).toEqual(account);
        expect(mutation.authenticationModeId).toBe(authenticationModeId);
        expect(mutation.expectedCredentialRevision).toBe(currentRevision);
        currentRevision = currentRevision === revision ? 'csr_aaaaaaaaaaaaaaaaaaaaaa' : 'csr_bbbbbbbbbbbbbbbbbbbbbb';
        expiresAt = Date.now() + 3_600_000;
        snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ...snapshot, content: mutation.content, metadata: mutation.metadata, credentialRevision: currentRevision });
        return { status: 200, data: { success: true, credentialRevision: currentRevision, configurationRevision: null } };
      }
      throw new Error(`Unexpected HTTP write: ${path}`);
    });
    const forbiddenLegacyRead = vi.fn(async () => { throw new Error('V2 unsupported credential format'); });
    const refreshCoordinator = new ConnectedServiceRefreshCoordinator({
      credentials, api: { getAccountEncryptionMode: async () => 'e2ee' } as ApiClient, machineIdProvider: () => 'test-machine',
      activeServerDir: directory, baseDir: directory, refreshWindowMs: 300_000,
      refreshLeaseMs: 60_000, now: Date.now,
      resolveQualifiedPurposeBindingSnapshot: async ({ agentId, connectedServicesBindingsRaw }) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId, bindings: ConnectedServiceBindingsV2IngressSchema.parse(connectedServicesBindingsRaw), contributions: lease.registry.contributes,
      }),
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4', establishedRuntimeOwner: established,
        readCredential: readQualifiedConnectedAccountCredentialV4,
        acquireRefreshLease: acquireQualifiedConnectedAccountRefreshLeaseV4,
        mutateCredential: mutateQualifiedConnectedAccountCredentialV4,
        mutateCredentialHealth: mutateQualifiedConnectedAccountCredentialHealthV4,
      },
    });
    const result = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex', connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': groupRecovery
        ? { source: 'connected', selection: 'group', groupId: group.ref.groupId, profileId: account.accountId }
        : { source: 'connected', selection: 'profile', profileId: account.accountId } } },
      materializationKey: account.accountId, activeServerDir: directory, baseDir: directory,
      processEnv: { HOME: directory }, credentials,
      api: { getServerFeaturesSnapshot: async () => cachedFeatures ? ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: { connectedServices: { enabled: true } }, capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } }) }) : undefined, getConnectedServiceCredentialSealed: forbiddenLegacyRead, getConnectedServiceCredentialPlain: forbiddenLegacyRead, getAccountEncryptionMode: async () => 'e2ee' } as unknown as ApiClient,
      qualifiedConnectedAccountApi: { listAccounts, readGroup: async () => groupRecovery ? group : null },
      ...(groupRecovery ? { authGroupSwitchCoordinator: switchCoordinator } : {}),
      resolveQualifiedPurposeBindingSnapshot: (bindings) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'codex', bindings, contributions: lease.registry.contributes }),
      activateQualifiedPurposeBindings: (snapshot) => purposeOwner.activateSessionPurposeBindings({ sessionId: `qualified-${account.accountId}`, purposes: snapshot.purposes, bindings: snapshot.bindings }),
      credentialRefreshService: refreshCoordinator,
    });
    expect(result).not.toBeNull();
    expect(result!.targetMaterializedRoot).toBe(result!.env.CODEX_HOME);
    const auth = JSON.parse(await readFile(join(result!.targetMaterializedRoot!, 'auth.json'), 'utf8'));
    expect(auth.tokens.access_token).toBe(refresh && !groupRecovery ? 'refreshed-access' : 'fixture-access');
    const selections = JSON.parse(result!.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON!);
    expect(selections[0].credentialRevision).toBe(currentRevision);
    if (refresh && !groupRecovery) {
      const bridge = refreshCoordinator.refreshOpenAiCodexChatGptTokensForBridge({
        refreshAttemptId: `health-${account.accountId}`, selection: { kind: 'profile', serviceId: 'openai-codex', profileId: account.accountId },
        expectedCredentialRevision: currentRevision, chatgptPlanType: null, forceRefresh: true,
      });
      await bridge;
      expect(healthPatches).toContainEqual(expect.objectContaining({
        ref: account, expectedCredentialRevision: currentRevision,
        expectedConfigurationRevision: null,
        health: expect.objectContaining({ status: 'connected', reconnectRequired: false }),
      }));
    }
    if (groupRecovery) {
      expect(selections[0].activeProfileId).toBe(backup.accountId);
      expect(group.generation).toBe(2);
    }
    expect(forbiddenLegacyRead).not.toHaveBeenCalled();
    await result?.cleanupOnExit?.();
    http.mockRestore();
    writes.mockRestore();
    healthWrites.mockRestore();
    vi.restoreAllMocks();
    providerRejectsRefresh = false;
    groupActiveAccount = null;
  });

  it('materializes retained released 0.2 credential data through the qualified reader', async () => {
    const record = buildConnectedServiceCredentialRecord({ now: 10, serviceId: 'openai-codex', profileId: 'legacy', kind: 'oauth', expiresAt: null, oauth: { accessToken: 'legacy-access', refreshToken: 'legacy-refresh', idToken: 'legacy-id', scope: null, tokenType: null, providerAccountId: 'legacy-account', providerEmail: null } });
    const ciphertext = sealAccountScopedBlobCiphertext({ kind: 'connected_service_credential', material: credentials.encryption, payload: record, randomBytes: (length) => new Uint8Array(length).fill(4) });
    const legacyRead = vi.fn(async () => { throw new Error('Unexpected legacy credential projection'); });
    const account = { service, accountId: 'legacy' };
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      expect(new URL(String(url)).pathname).toBe('/v4/connect/qualified/credential');
      return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: account, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
        credentialRevision: revision, configurationRevision: null,
        content: { t: 'encrypted', c: ciphertext }, metadata: { scopes: [] },
      }) };
    });
    const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
      ref: account, authenticationModeId: 'oauth', status: 'connected',
      revisionSemantics: 'revisioned', credentialRevision: revision,
      configurationReady: true, configurationRevision: null, scopes: [],
    }] });
    const result = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex', connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'legacy' } } },
      materializationKey: 'legacy', activeServerDir: directory, baseDir: directory, processEnv: { HOME: directory }, credentials,
      api: { getAccountEncryptionMode: async () => 'e2ee', getConnectedServiceCredentialSealed: legacyRead } as unknown as ApiClient,
      qualifiedConnectedAccountApi: { listAccounts: async () => accounts, readGroup: async () => null },
      resolveQualifiedPurposeBindingSnapshot: (bindings) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'codex', bindings, contributions: lease.registry.contributes }),
      activateQualifiedPurposeBindings: (snapshot) => purposeOwner.activateSessionPurposeBindings({ sessionId: 'retained-legacy', purposes: snapshot.purposes, bindings: snapshot.bindings }),
    });
    expect(result).not.toBeNull();
    const auth = JSON.parse(await readFile(join(result!.env.CODEX_HOME!, 'auth.json'), 'utf8'));
    expect(auth.tokens.access_token).toBe('legacy-access');
    expect(legacyRead).not.toHaveBeenCalled();
    await result?.cleanupOnExit?.();
    http.mockRestore();
  });
});
