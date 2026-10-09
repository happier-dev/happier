import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { ACCOUNT_SECURITY_PATH_V1, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { buildConnectedServiceCredentialRecord, QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountCredentialMutationV4Schema,
  QualifiedConnectedAccountProfileV4Schema, FeaturesResponseSchema, openQualifiedConnectedAccountContentEnvelope,
  QualifiedConnectedAccountRefSchema, parseQualifiedConnectedAccountCredentialPlaintextV1, type ConnectedServiceBindingsV2 } from '@happier-dev/protocol';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { QualifiedConnectedAccountCredentialHealthPatchV4Schema, QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema,
  QualifiedConnectedAccountRefreshLeaseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createConnectedServiceRuntimeAuthNativeHome } from '../runtimeAuth/createRuntimeAuthNativeHome';
import { createSessionConnectedServiceAuthHotApply } from './sessionConnectedServiceAuthHotApply';
import { validateConnectedServiceGroupMutationCurrentness } from '../accountGroups/generation/validateGroupMutationCurrentness';
import { DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1 } from '../accountGroups/selection/selectConnectedServiceAuthGroupCandidate';
import { ApiClient } from '@/api/api';
import { readQualifiedConnectedAccountGroupV4, resolveQualifiedConnectedAccountAtomicV4Negotiation,
  resolveQualifiedConnectedAccountPeerClass } from '@/api/client/qualifiedConnectedAccountApi';
import { createRequesterSessionRuntimeContext } from '../../sessionEncryption/createRequesterSessionRuntimeContext';
import { admitRequesterSessionBootstrap, verifyRequesterSessionMachineAdmissionCurrent } from '../../sessionEncryption/requesterSessionCredentials';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from '../runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createRequesterSessionControlRuntimeFixture } from '../../testkit/requesterSessionControlRuntimeFixture';
import type { TrackedSession } from '../../types';

describe('requester native subscription hot apply', () => {
    const scopes = ['user:inference', 'user:profile', 'user:sessions:claude_code'];
    let providerRequests: Array<unknown> = [];
    let pluginRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
    beforeAll(async () => {
      pluginRuntime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.claude'], networkDependencies: {
        resolveNetworkAddresses: async () => ['8.8.8.8'],
        openPinnedStream: async request => {
          providerRequests.push(request.body);
          const bytes = new TextEncoder().encode(JSON.stringify({ access_token: 'bob-refreshed-backup',
            refresh_token: 'bob-refreshed-refresh', expires_in: 3600, scope: scopes.join(' '), token_type: 'Bearer' }));
          let delivered = false;
          return { status: 200, headers: {}, contentLength: bytes.length,
            read: async () => { if (delivered) return null; delivered = true; return bytes; }, cancel() {} };
        },
      } } });
    });
    afterAll(async () => { await pluginRuntime?.dispose(); });
  describe('Bot requester warm continuity', () => {
    beforeEach(() => { providerRequests = []; });
    it('refreshes and switches a Bot subscription under requester custody across reconnect and revoke', async () => {
    let requester: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
    let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
    let current = true;
    let connected = true;
    const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' } as const;
    const serviceId = 'happier.agent.claude/claude-subscription';
    const sourceRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const refreshedRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const homeUrl = 'https://bob-home.test';
    const credentials = { token: 'bob-session-token', encryption: null };
    const installation = tweetnacl.sign.keyPair();
    const attribution = { serverId: 'bob-home', accountId: 'bob', machineId: 'machine', installationId: 'installation' };
    const verifyCurrent = () => verifyRequesterSessionMachineAdmissionCurrent({ credentials,
      sessionId: 'bob-bot', attribution, serverHttpBaseUrl: homeUrl,
      boundary: { machineId: 'machine', daemonToken: 'alice-daemon', isHomeCurrent: () => true,
        readInstallation: () => ({ installationId: 'installation', privateKey: installation.secretKey }) } });
    const features = { status: 'ready' as const, features: FeaturesResponseSchema.parse({ features: {},
      capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } }) };
    const identity = { bot: { kind: 'bot' }, createdAsBot: true } as const;
    let group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'bob-group' },
      incarnation: 'bob-group-incarnation', displayName: 'Bob subscription',
      policy: { ...DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, autoSwitch: true },
      activeConnectedAccountId: 'primary', generation: 7, runtimeStateRevision: 1, state: {}, createdAt: 1, updatedAt: 1,
      members: ['primary', 'backup'].map((connectedAccountId, index) => ({ v: 1, connectedAccountId,
        priority: index + 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 })),
    });
    const snapshots = new Map(['primary', 'backup'].map(accountId => [accountId,
      QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: { service, accountId }, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
        credentialRevision: sourceRevision, configurationRevision: null, metadata: { scopes },
        content: { t: 'plain', v: { v: 1, values: { accessToken: `bob-${accountId}`, refreshToken: `bob-${accountId}-refresh`,
          providerAccountId: `bob-${accountId}`, scope: scopes.join(' '), scopes: JSON.stringify(scopes),
          expiresAtMs: String(Date.now() - 1_000) } } },
      })]));
    const profileHealth = new Map<string, 'connected' | 'refreshing' | 'needs_reauth' | 'refresh_failed_retryable'>();
    const profiles = () => [...snapshots.values()].map(snapshot => QualifiedConnectedAccountProfileV4Schema.parse({
      ref: snapshot.ref, status: profileHealth.get(snapshot.ref.accountId) ?? 'connected', authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
      credentialRevision: snapshot.credentialRevision, configurationRevision: null, configurationReady: true,
      kind: 'oauth', expiresAt: snapshot.credentialRevision === sourceRevision ? Date.now() - 1_000 : Date.now() + 3_600_000,
      displayName: snapshot.ref.accountId, scopes,
    }));
    const requests: Array<{ origin: string; token: unknown; path: string }> = [];
    const recordRequest = (url: string, token: unknown) => {
      const parsed = new URL(url);
      requests.push({ origin: parsed.origin, token, path: parsed.pathname });
      if (!connected) throw new Error('requester_home_unreachable');
      return parsed;
    };
    // Home HTTP and the OAuth provider are the system boundaries. Requester
    // admission, refresh, group decisions and native credential application stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const parsed = recordRequest(String(url), config?.headers?.Authorization);
      const path = parsed.pathname;
      if (path === ACCOUNT_SECURITY_PATH_V1) {
        // Real daemon startup reads its own terminal policy, not Bob content.
        expect(config?.headers?.Authorization).toBe('Bearer alice-daemon');
        return { status: 200, data: AccountSecurityGetResponseV1Schema.parse({ v: 1, encryptionMode: 'plain',
          terminalPresentUserPolicy: 'allowed', nativeEmail: null, password: { status: 'not_enrolled', revision: null } }) };
      }
      if (path === '/v1/account/profile') return { status: 200, data: { id: 'bob' } };
      if (path === '/v1/machines/machine/access') {
        const custodian = { accountId: 'alice', displayName: 'Alice' };
        return current ? { status: 200, data: { machineId: 'machine', custodian,
          access: { custodian, role: 'use', resourceMode: 'plain', accessState: 'ready' },
          canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [] } }
          : { status: 403, data: { kind: 'refused', code: 'access_denied' } };
      }
      if (path === '/v2/sessions/bob-bot') return { status: 200, data: { session: createSessionRecordFixture({
        id: 'bob-bot', encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/repo',
          bot: { kind: 'bot' }, createdAsBot: true, claudeSessionId: 'same-native-session' }), dataEncryptionKey: null, share: null,
      }) } };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (path === '/v4/connect/qualified/accounts') return { status: 200, data: { service, accounts: profiles() } };
      if (path === '/v4/connect/qualified/groups') return { status: 200, data: { service, groups: [group] } };
      if (path === '/v4/connect/qualified/group') return { status: 200, data: { group } };
      if (path === '/v4/connect/qualified/credential') {
        const ref = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema, parsed.searchParams.get('ref'));
        const snapshot = snapshots.get(ref.accountId);
        return { status: snapshot ? 200 : 404, data: snapshot ?? null };
      }
      if (path === '/v4/connect/qualified/configuration') return { status: 404, data: null };
      if (path === '/v1/artifacts') return { status: 200, data: [] };
      if (path.startsWith('/v1/account/entity-rows/')) return { status: 404, data: { error: 'not_found' } };
      throw new Error(`Unexpected requester Home read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, data, config) => {
      const parsed = recordRequest(String(url), config?.headers?.Authorization);
      if (parsed.pathname === '/v1/machines/machine/admission/verify') {
        const body = data as { context: SocketRpcMachineAdmissionContextV1;
          purpose: { kind: 'requester_session_currentness'; sessionId: string };
          proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
        const valid = verifyMachineInstallationProof({ publicKey: installation.publicKey, proof: body.proof,
          payload: { version: 1, accountId: 'alice', machineId: 'machine', installationId: 'installation',
            rpcAdmission: { context: body.context, purpose: body.purpose } } });
        expect(body.context.actorAccountId).toBe('bob');
        expect(body.purpose).toEqual({ kind: 'requester_session_currentness', sessionId: 'bob-bot' });
        return valid && current ? { status: 200, data: { v: 1, ok: true } }
          : { status: 403, data: { error: 'access_denied' } };
      }
      if (parsed.pathname === '/v4/connect/qualified/credential/refresh-lease') {
        const lease = QualifiedConnectedAccountRefreshLeaseV4Schema.parse(data);
        return { status: 200, data: { acquired: true, leaseUntil: Date.now() + lease.ttlMs,
          ownerId: lease.ownerId, credentialRevision: snapshots.get(lease.ref.accountId)?.credentialRevision } };
      }
      if (parsed.pathname === '/v4/connect/qualified/credential') {
        const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(data);
        const previous = snapshots.get(mutation.ref.accountId);
        if (!previous) throw new Error('Unexpected credential target');
        snapshots.set(mutation.ref.accountId, QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
          ...previous, content: mutation.content, metadata: mutation.metadata, credentialRevision: refreshedRevision }));
        profileHealth.set(mutation.ref.accountId, 'connected');
        return { status: 200, data: { success: true, credentialRevision: refreshedRevision, configurationRevision: null } };
      }
      if (parsed.pathname === '/v4/connect/qualified/group/active-account') {
        const accountId = data && typeof data === 'object' ? Reflect.get(data, 'connectedAccountId') : undefined;
        if (typeof accountId !== 'string') throw new Error('Missing group target');
        group = { ...group, activeConnectedAccountId: accountId, generation: group.generation + 1 };
        return { status: 200, data: { group } };
      }
      throw new Error(`Unexpected requester Home write: ${parsed.pathname}`);
    });
    vi.spyOn(axios, 'patch').mockImplementation(async (url, data, config) => {
      const parsed = recordRequest(String(url), config?.headers?.Authorization);
      if (parsed.pathname === '/v4/connect/qualified/credential/health') {
        const patch = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse(data);
        const previous = snapshots.get(patch.ref.accountId);
        if (!previous) throw new Error('Unexpected health target');
        profileHealth.set(patch.ref.accountId, patch.health.status);
        return { status: 200, data: { success: true, credentialRevision: previous.credentialRevision, configurationRevision: null } };
      }
      if (parsed.pathname !== '/v4/connect/qualified/group/runtime-state') throw new Error('Unexpected group mutation');
      const patch = QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema.parse(data);
      group = QualifiedConnectedAccountGroupV4Schema.parse({ ...group,
        runtimeStateRevision: group.runtimeStateRevision + 1,
        ...(patch.runtimeState.state ? { state: { ...group.state, ...patch.runtimeState.state } } : {}),
        members: group.members.map(member => {
          const update = patch.runtimeState.memberStates?.find(candidate => candidate.connectedAccountId === member.connectedAccountId);
          return update ? { ...member, state: { ...member.state, ...update.state } } : member;
        }) });
      return { status: 200, data: { group } };
    });
    // The real Account Action transport uses axios.request, unlike the
    // profile/credential clients. Both must reach the same Home HTTP fixture.
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      const method = (config.method ?? 'GET').toUpperCase();
      if (method === 'GET') return await axios.get(String(config.url), config);
      if (method === 'POST') return await axios.post(String(config.url), config.data, config);
      if (method === 'PATCH') return await axios.patch(String(config.url), config.data, config);
      throw new Error(`Unexpected requester Home method: ${method}`);
    });
    try {
      const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
      const trackedSessions = new Map<number, TrackedSession>();
      const activeServerDir = join(pluginRuntime.happyHomeDir, 'servers', attribution.serverId);
      host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: pluginRuntime.happyHomeDir, activeServerDir,
        serverId: attribution.serverId, serverHttpBaseUrl: homeUrl, machineId: attribution.machineId,
        custodianAccountId: 'alice', credentials: { token: 'alice-daemon', encryption: null },
        connectedServicesMaterializationBaseDir: join(pluginRuntime.happyHomeDir, 'materialized'),
        registry: runtimeRegistry, trackedSessions, getRequester: () => requester,
        resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(features) });
      const requesterRequestsStart = requests.length;
      expect(requests.every(request => request.origin === homeUrl && request.path === ACCOUNT_SECURITY_PATH_V1
        && request.token === 'Bearer alice-daemon'), JSON.stringify(requests)).toBe(true);
      expect(await verifyCurrent(), JSON.stringify(requests.map(request => request.path))).toBe(true);
      const admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester',
        credentials: { token: credentials.token } }, boundary: { serverId: 'bob-home', serverHttpBaseUrl: homeUrl,
        happyHomeDir: pluginRuntime.happyHomeDir }, existingSessionId: 'bob-bot', context: { signal: new AbortController().signal,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine', installationId: 'installation',
          role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: verifyCurrent } });
      if (!admitted) throw new Error(`Missing admitted requester: ${JSON.stringify(requests.map(request => request.path))}`);
      admitted.admitted.bindRuntimeMachineAdmissionCurrentness(verifyCurrent);
      requester = await createRequesterSessionRuntimeContext({ bootstrap: admitted.admitted,
        activeServerDir: pluginRuntime.happyHomeDir, connectedServicesMaterializationBaseDir: join(pluginRuntime.happyHomeDir, 'materialized'),
        resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(features),
        coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime',
          happyHomeDir: pluginRuntime.happyHomeDir, logger: { debug() {}, info() {}, warn() {} },
          processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '1', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
          pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: runtimeRegistry,
          connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator,
          resolveQualifiedConnectedAccountPeerClass: () => resolveQualifiedConnectedAccountPeerClass(features),
        } });
      if (!requester?.connectedServiceRefreshCoordinator) throw new Error('Missing real requester refresh owner');
      const captured = requester;
      captured.connectedServiceRuntimeRegistry?.registerTarget({ pid: 123, agentId: 'claude', sessionId: 'bob-bot',
        materializationKey: 'bob-bot', requesterWorkAttributionV1: captured.bootstrap.attribution,
        connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: { [serviceId]: {
          source: 'connected', selection: 'group', groupId: 'bob-group', profileId: 'primary' } } },
        connectedServiceSelectionsEnv: {},
      });
      expect(runtimeRegistry.getBySessionId('bob-bot')?.requesterWorkAttributionV1)
        .toEqual(captured.bootstrap.attribution);
      const root = join(requester.activeServerDir, 'bot-native');
      const nativeHome = await createConnectedServiceRuntimeAuthNativeHome({ agentId: 'claude', root,
        isCurrent: () => captured.bootstrap.isCurrent() });
      if (!nativeHome) throw new Error('Missing admitted native Home');
      const apply = createSessionConnectedServiceAuthHotApply({ isSessionCurrent: () => captured.bootstrap.isCurrent(),
        validateGroupMutationCurrentness: input => validateConnectedServiceGroupMutationCurrentness({ input,
          credentials, api: captured.api, readGroup: () => captured.qualifiedConnectedAccountApi.readGroup({ service, groupId: 'bob-group' }),
          assertCurrent: async () => { if (!await captured.bootstrap.isCurrent()) throw new Error('requester_session_not_current'); },
        }) });
      const tracked = { startedBy: 'daemon' as const, happySessionId: 'bob-bot', pid: 123,
        spawnOptions: { directory: root, identity,
            backendTarget: { kind: 'backend' as const, backendId: 'claude' as const, sourceKind: 'built_in' as const } } };
      trackedSessions.set(tracked.pid, { ...tracked, requesterWorkAttributionV1: attribution,
        requesterSessionRuntimeContext: captured });
      const switcher = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({ token: credentials.token,
        accountScope: captured.bootstrap.attribution, isCurrent: () => captured.bootstrap.isCurrent(),
        quotaFreshnessMs: 60_000, nowMs: () => Date.now(),
        prepareCandidateForSwitch: candidate => captured.connectedServiceRefreshCoordinator!.prepareConnectedServiceAuthGroupCandidateForSwitch({
          serviceId: 'claude-subscription', profileId: candidate.profileId, reason: candidate.reason }),
        applyGeneration: async generation => {
          const accountId = generation.activeProfileId;
          if (!accountId) throw new Error('Missing active refreshed Account');
          const snapshot = snapshots.get(accountId);
          if (!snapshot || snapshot.content.t !== 'plain' || typeof snapshot.authenticationModeId !== 'string') {
            throw new Error('Missing refreshed plaintext credential');
          }
          const values = parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: snapshot.ref,
            authenticationModeId: snapshot.authenticationModeId, metadata: snapshot.metadata,
            plaintext: openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', envelope: snapshot.content }),
          }).values;
          const normalizedBindings: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {
            [serviceId]: { source: 'connected', selection: 'group', groupId: 'bob-group', profileId: accountId } } };
          return await apply({ tracked,
            normalizedBindings, runtimeAuthSelectionsByServiceId: new Map([[serviceId, { serviceId, kind: 'group',
              groupId: 'bob-group', activeProfileId: accountId, groupGeneration: generation.generation, profileId: accountId,
              credentialRevision: snapshot.credentialRevision, nativeHome,
              credential: buildConnectedServiceCredentialRecord({ now: Date.now(), serviceId: 'claude-subscription', profileId: accountId,
                kind: 'oauth', oauth: { accessToken: values.accessToken!, refreshToken: values.refreshToken!, idToken: null,
                  scope: scopes.join(' '), tokenType: 'Bearer', providerAccountId: values.providerAccountId ?? null, providerEmail: null } }),
            }]]) });
        },
      });
      const switchInput = { sessionId: 'bob-bot', serviceId: service, groupId: 'bob-group', reason: 'auth_expired', observedProfileId: 'primary' };
      connected = false;
      await expect(runWithServerHttpBaseUrl(homeUrl, () => switcher.switchAfterClassifiedFailure(switchInput))).rejects.toThrow();
      connected = true;
      const result = await runWithServerHttpBaseUrl(homeUrl, () => switcher.switchAfterClassifiedFailure(switchInput));
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'switched', activeProfileId: 'backup' });
      const providerBodies = providerRequests.map(body => typeof body === 'string' ? body
        : body instanceof Uint8Array ? new TextDecoder().decode(body) : '');
      expect(providerBodies.some(body => body.includes('bob-backup-refresh'))).toBe(true);
      expect(providerBodies.some(body => body.includes('alice'))).toBe(false);
      const nativeBytes = await readFile(join(root, '.credentials.json'));
      expect(nativeBytes.toString()).toContain('bob-refreshed-backup');
      expect(tracked.spawnOptions.identity).toEqual(identity);
      expect(tracked.happySessionId).toBe('bob-bot');
      const session = await fetchSessionById({ token: credentials.token, serverUrl: homeUrl, sessionId: 'bob-bot' });
      expect(session).not.toBeNull();
      if (!session) throw new Error('Missing protected Bot Session');
      expect(tryDecryptSessionOwnerMetadataView({ credentials, accountEncryptionMode: 'plain', rawSession: session }))
        .toMatchObject({ bot: { kind: 'bot' }, createdAsBot: true, claudeSessionId: 'same-native-session' });
      expect(requests.slice(requesterRequestsStart).every(request => request.origin === homeUrl && request.token ===
        (request.path === '/v1/machines/machine/admission/verify' ? 'Bearer alice-daemon' : 'Bearer bob-session-token')),
        JSON.stringify(requests.slice(requesterRequestsStart))).toBe(true);
      current = false;
      const requestsBeforeRevoke = requests.length;
      const providerRequestsBeforeRevoke = providerRequests.length;
      await expect(runWithServerHttpBaseUrl(homeUrl, () => switcher.switchAfterClassifiedFailure(switchInput))).rejects.toThrow();
      expect(requests.slice(requestsBeforeRevoke).every(request =>
        request.path === '/v1/account/profile' || request.path === '/v1/machines/machine/access')).toBe(true);
      expect(providerRequests).toHaveLength(providerRequestsBeforeRevoke);
      await expect(readFile(join(root, '.credentials.json'))).resolves.toEqual(nativeBytes);
    } finally {
      try {
        await requester?.dispose();
      } finally {
        try {
          await host?.dispose();
        } finally {
          vi.restoreAllMocks(); vi.unstubAllGlobals();
        }
      }
    }
    });
  });
  it('preserves the admitted native subscription after requester admission is retired', async () => {
    const runtime = pluginRuntime;
    try {
      let current = true;
      const root = join(runtime.happyHomeDir, 'requester-native');
      const nativeHome = await createConnectedServiceRuntimeAuthNativeHome({ agentId: 'claude', root,
        isCurrent: async () => current });
      expect(nativeHome, JSON.stringify({ diagnostics: runtime.registry.pluginDiagnosticsByPluginId['happier.agent.claude'],
        declarations: runtime.registry.contributes.agents.filter(agent => agent.pluginId === 'happier.agent.claude')
          .map(agent => ({ manifestPath: agent.manifestPath, cliMetadata: agent.cliMetadata })) })).not.toBeNull();
      const serviceId = 'happier.agent.claude/claude-subscription';
      const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
      const credentials = { token: 'bob-session-token', encryption: null };
      const revision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
      // Real Claude health/codec requires these declared native OAuth scopes.
      const scopes = ['user:inference', 'user:profile', 'user:sessions:claude_code'];
      const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'bob-group' },
        incarnation: 'bob-group-incarnation', displayName: 'Bob subscription',
        policy: DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, activeConnectedAccountId: 'bob-subscription',
        generation: 7, runtimeStateRevision: 1, state: {}, createdAt: 1, updatedAt: 1,
        members: [{ v: 1, connectedAccountId: 'bob-subscription', priority: 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 }],
      });
      let groupGeneration = group.generation;
      const requests: string[] = [];
      // Only genuine Home HTTP is replaced: group currentness, credential
      // resolution, admitted Claude codec and native-file writes remain real.
      vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        requests.push(String(config?.headers?.Authorization));
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v4/connect/qualified/group') return { status: 200, data: { group: { ...group, generation: groupGeneration } } };
        if (path === '/v4/connect/qualified/credential') return { status: 200,
          data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
            ref: { service, accountId: 'bob-subscription' }, authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null,
            metadata: { scopes }, content: { t: 'plain', v: { v: 1, values: {
              accessToken: 'bob-admitted', refreshToken: 'bob-refresh', providerAccountId: 'bob', scope: scopes.join(' '),
            } } },
          }),
        };
        throw new Error(`Unexpected Home path: ${path}`);
      });
      const api = await ApiClient.create(credentials);
      const bindings: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {
        [serviceId]: { source: 'connected', selection: 'group', groupId: 'bob-group', profileId: 'bob-subscription' },
      } };
      const apply = createSessionConnectedServiceAuthHotApply({ isSessionCurrent: async () => current,
        validateGroupMutationCurrentness: input => validateConnectedServiceGroupMutationCurrentness({ input,
          credentials, api, readGroup: () => readQualifiedConnectedAccountGroupV4({ token: credentials.token,
            group: { service, groupId: 'bob-group' } }),
          assertCurrent: async () => { if (!current) throw new Error('requester_session_not_current'); },
        }),
      });
      const input = (accessToken: string) => ({
        tracked: { startedBy: 'daemon' as const, happySessionId: 'bob-session', pid: 123,
          spawnOptions: { directory: runtime.happyHomeDir,
            backendTarget: { kind: 'backend' as const, backendId: 'claude' as const, sourceKind: 'built_in' as const } } },
        normalizedBindings: bindings,
        runtimeAuthSelectionsByServiceId: new Map([[serviceId, {
          serviceId, kind: 'group', groupId: 'bob-group', activeProfileId: 'bob-subscription',
          groupGeneration: 7, profileId: 'bob-subscription', credentialRevision: revision, nativeHome,
          credential: buildConnectedServiceCredentialRecord({ now: 1_000, serviceId: 'claude-subscription',
            profileId: 'bob-subscription', kind: 'oauth', oauth: { accessToken, refreshToken: 'bob-refresh',
              idToken: null, scope: scopes.join(' '), tokenType: null, providerAccountId: 'bob', providerEmail: null } }),
        }]]),
      });
      const admitted = await apply(input('bob-admitted'));
      expect(admitted, JSON.stringify(admitted.ok ? { ok: true } : {
        ok: false, errorCode: admitted.errorCode, serviceId: admitted.serviceId,
        serviceResultsByServiceId: admitted.serviceResultsByServiceId,
      })).toMatchObject({ ok: true });
      const admittedNativeBytes = await readFile(join(root, '.credentials.json'));
      expect(admittedNativeBytes.toString()).toContain('bob-admitted');
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(bearer => bearer === 'Bearer bob-session-token')).toBe(true);
      groupGeneration += 1;
      await expect(apply(input('superseded-must-not-apply'))).resolves.toMatchObject({ ok: false });
      await expect(readFile(join(root, '.credentials.json'))).resolves.toEqual(admittedNativeBytes);
      groupGeneration = group.generation;
      current = false;
      await expect(apply(input('retired-must-not-apply'))).resolves.toMatchObject({ ok: false });
      await expect(readFile(join(root, '.credentials.json'))).resolves.toEqual(admittedNativeBytes);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
