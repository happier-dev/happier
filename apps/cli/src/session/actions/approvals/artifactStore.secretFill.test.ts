import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { ApprovalRequest } from '@happier-dev/protocol';
import { createCliApprovalsArtifactStore } from './artifactStore';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { AccountSettingsSchema, FeaturesResponseSchema, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';
import { installDaemonMachineAdmissionTransport } from '@/daemon/machineAdmissionTransport';
import { createConfidentialSecretFillExecutor } from '@/daemon/surfaces/confidentialSecretFill';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { configuration, reloadConfiguration } from '@/configuration';
import { readSettings, writeSettings, writeStoredCredentialsForServerId } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createAccountEncryptionCurrentnessFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), request: vi.fn() }));
// Only authenticated HTTP/storage is substituted: codecs, approval transitions and Artifact CAS remain real.
vi.mock('axios', () => ({ default: http }));

const request = { serverId: 'home', sessionId: 'session', machineId: 'machine', purpose: 'Sign in',
  sourceId: 'source', target: { kind: 'window', displayId: 'display', pid: 1, windowId: 2 },
  captureId: 'capture', geometry: { captureWidth: 100, captureHeight: 100, nativeWidth: 100, nativeHeight: 100,
    originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 100, height: 100 } },
  field: { fieldId: 'password', focusId: 'focus' } } as const;

afterEach(resetActiveAccountSettingsSnapshotForTests);

describe('confidential continuation Artifact custody', () => {
  it('consumes default production registration with isolated stored credentials and real Home/Session currentness', async () => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_TOKEN',
      'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', 'HAPPIER_ACCOUNT_SETTINGS_MODE', 'HAPPIER_ACTIONS_SETTINGS_V1']);
    try {
      await withTempDir('happier-private-approval-production-', async homeDir => {
        const endpoint = 'https://private-approval-home.example.test';
        env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: endpoint, HAPPIER_WEBAPP_URL: endpoint,
          HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined,
          HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', HAPPIER_ACTIONS_SETTINGS_V1: undefined });
        reloadConfiguration();
        const serverId = configuration.activeServerId;
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'alice',
          provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        await writeStoredCredentialsForServerId(serverId, credentials);
        await writeSettings({ ...await readSettings(), machineIdByServerId: { [serverId]: 'machine' } });
        expect((await readSettings()).machineId).toBe('machine');
        const scopeKey = resolveAccountSettingsScopeKeyForToken(token)!;
        const settings = AccountSettingsSchema.parse({});
        setActiveAccountSettingsSnapshot({ source: 'network', scopeKey, loadedAtMs: 1,
          settingsVersion: 1, settingsSecretsReadKeys: [], settings });
        const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true } },
          capabilities: { serverIdentity: { serverIdentityId: 'srv_private_approval' } } });
        const sessionId = 'c123456789012345678901234';
        const session = { ...createSessionNotificationContextFixture(sessionId), encryptionMode: 'plain',
          metadata: JSON.stringify({ machineId: 'machine' }) };
        const reviewedRequest = { ...request, serverId, sessionId };
        let created: ApprovalRequest | null = null;
        await createActionExecutor({ approvalsCreate: async ({ request }) => {
          created = request; return { artifactId: 'approval' };
        }, isActionApprovalRequired: () => false }).execute('computer.secret.fill', reviewedRequest, {
          surface: 'agent', authority: 'account_automation', serverId, serverIdentityId: 'srv_private_approval',
          defaultSessionId: sessionId, defaultSessionMachineId: 'machine', runtimeAccountId: 'alice',
          actionRequestId: 'request', actionCaller: { kind: 'host' },
        });
        const approval = ApprovalRequestV2Schema.parse(created);
        let record = { id: 'approval', ownerAccountId: 'alice', access: 'owner', encryptionMode: 'plain',
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
          body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'plain' });
        vi.stubGlobal('fetch', async (input: string | URL | Request) => {
          const url = String(input);
          if (url.endsWith('/v1/features') || url.endsWith('/v1/features/authenticated')) return new Response(JSON.stringify(features), { status: 200 });
          if (url.endsWith('/v1/account/encryption/currentness')) return new Response(JSON.stringify(currentness), { status: 200 });
          throw new Error('Unexpected Home fetch boundary');
        });
        http.get.mockImplementation(async (url: string) => {
          if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
          if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: currentness };
          if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
          if (url.endsWith('/v1/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: settings } } };
          if (url.includes('/v1/artifacts/approval')) return { status: 200, data: { ...record } };
          throw new Error('Unexpected Home HTTP boundary');
        });
        http.request.mockImplementation(async ({ url, method }: { url: string; method: string }) => {
          if (method === 'POST' && url.endsWith(ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1)) return { status: 200, data: { tokens: [] } };
          throw new Error('Unexpected Home HTTP request boundary');
        });
        http.post.mockImplementation(async (_url: string, input: { header: string; body: string; expectedHeaderVersion: number; expectedBodyVersion: number }) => {
          if (input.expectedHeaderVersion !== record.headerVersion || input.expectedBodyVersion !== record.bodyVersion) return { status: 409, data: { success: false, error: 'version-mismatch' } };
          record = { ...record, header: input.header, body: input.body, headerVersion: record.headerVersion + 1, bodyVersion: record.bodyVersion + 1 };
          return { status: 200, data: { success: true, headerVersion: record.headerVersion, bodyVersion: record.bodyVersion } };
        });
        const isOriginCurrent = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
          machineId: 'machine', serverId, serverApiUrl: endpoint,
          resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }) });
        expect(await isOriginCurrent?.({ origin: approval.executionOriginV1, request: approval }),
          JSON.stringify(approval.executionOriginV1)).toBe(true);
        let effects = 0;
        const value = 'PRIVATE-DEFAULT-REGISTRATION-D26';
        const api = createConnectedServiceCredentialApi(credentials);
        const trustedProducer = createConfidentialSecretFillExecutor({ expectedScopeKey: scopeKey, expectedAccountId: 'alice', serverId, machineId: 'machine',
          readHostIdentity: createCurrentMachineExecutionOriginContextResolver({ serverUrl: endpoint, resolveCurrentMachineId: () => 'machine' }),
          readAccountMode: async signal => {
            const mode = await api.getAccountEncryptionMode({ refresh: true, signal });
            if (mode === 'unknown') throw new Error('Account mode unavailable');
            return mode;
          },
          // Only the actual native OS preparation/delivery boundary is substituted.
          prepareTarget: async () => ({ nativeObservation: 'not_observable', recheck: async () => true,
            fill: async (bytes, _signal, beforeDelivery) => {
              if (!await beforeDelivery?.()) return { status: 'refused', code: 'approval_changed' };
              expect(Buffer.from(bytes).toString()).toBe(value); effects += 1;
              return { status: 'filled', code: 'filled' };
            }, finish: async () => {} }),
        });
        const uninstall = installDaemonMachineAdmissionTransport({ serverId,
          transport: async () => { throw new Error('Session input is not part of confidential delivery'); }, confidentialSecretFill: trustedProducer });
        try {
          const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
            authorizeRequest: input => authorizeMachineRpcRequest(input, { machineId: 'machine', resolveCustodianAccountId: async () => 'alice',
              resolveInstallationId: () => 'installation', verifyMachineAdmission: async () => true }) });
          registerApprovalRpcHandlers({ rpcHandlerManager: rpc });
          expect(await rpc.handleRequest({ method: `machine:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`,
            callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice',
              machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
            params: { v: 1, artifactId: 'approval', requestId: 'request', actionId: 'computer.secret.fill', request: reviewedRequest,
              choice: { kind: 'once', value }, accountEncryptionMode: 'plain', submit: false } }))
            .toEqual({ status: 'filled', code: 'filled' });
          expect(effects).toBe(1);
          const stored = await createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'plain' })
            .approvalsGet({ artifactId: 'approval', serverId });
          expect(JSON.stringify(stored)).not.toContain(value);
          expect(stored?.actionArgs).toEqual(reviewedRequest);
          expect(ApprovalRequestV2Schema.parse(stored).executionOriginV1).toEqual(approval.executionOriginV1);
        } finally { uninstall(); }
      });
    } finally { vi.unstubAllGlobals(); env.restore(); reloadConfiguration(); }
  });
  it.each([
    { name: 'same Home', localHome: 'home', hostIdentity: 'srv_verified_home', identitySource: 'bound', mode: 'plain', code: 'filled' },
    { name: 'portable Home alias', localHome: 'local-home', hostIdentity: 'srv_verified_home', identitySource: 'bound', mode: 'plain', code: 'filled' },
    { name: 'different Home despite caller identity', localHome: 'local-home', hostIdentity: 'srv_different_home', identitySource: 'bound', mode: 'plain', code: 'approval_changed' },
    { name: 'authenticated Home identity', localHome: 'local-home', hostIdentity: 'srv_verified_home', identitySource: 'features', mode: 'plain', code: 'filled' },
    { name: 'authenticated different Home despite caller identity', localHome: 'local-home', hostIdentity: 'srv_different_home', identitySource: 'features', mode: 'plain', code: 'approval_changed' },
    { name: 'changed Account mode', localHome: 'home', hostIdentity: 'srv_verified_home', identitySource: 'bound', mode: 'e2ee', code: 'saved_secret_mode_incompatible' },
    { name: 'uncertain issued delivery is not retried', localHome: 'home', hostIdentity: 'srv_verified_home', identitySource: 'bound', mode: 'plain', code: 'delivery_unknown' },
  ] as const)('consumes the credential-backed private RPC through the installed trusted producer: $name', async ({ localHome, hostIdentity, identitySource, mode, code }) => {
    let created: ApprovalRequest | null = null;
    await createActionExecutor({ approvalsCreate: async ({ request }) => {
      created = request; return { artifactId: 'approval' };
    }, isActionApprovalRequired: () => false }).execute('computer.secret.fill', request, {
      surface: 'agent', authority: 'account_automation', serverId: 'home', serverIdentityId: 'srv_verified_home',
      defaultSessionId: 'session', defaultSessionMachineId: 'machine', actionRequestId: 'request', actionCaller: { kind: 'host' },
    });
    const approval = ApprovalRequestV2Schema.parse(created);
    let record = { id: 'approval', ownerAccountId: 'alice', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    http.get.mockImplementation(async (url: string) => ({ status: 200,
      data: url.endsWith('/encryption') ? { mode: 'plain', updatedAt: 1 } : { ...record } }));
    http.post.mockImplementation(async (_url: string, input: { header: string; body: string; expectedHeaderVersion: number; expectedBodyVersion: number }) => {
      if (input.expectedHeaderVersion !== record.headerVersion || input.expectedBodyVersion !== record.bodyVersion) {
        return { status: 409, data: { success: false, error: 'version-mismatch' } };
      }
      record = { ...record, header: input.header, body: input.body,
        headerVersion: record.headerVersion + 1, bodyVersion: record.bodyVersion + 1 };
      return { status: 200, data: { success: true, headerVersion: record.headerVersion, bodyVersion: record.bodyVersion } };
    });
    const credentials = { token: `private-wrapper-${localHome}-${mode}-${hostIdentity}`, encryption: null,
      credentialProvenance: 'stored_session' as const };
    const scopeKey = resolveAccountSettingsScopeKeyForToken(credentials.token)!;
    const settings = AccountSettingsSchema.parse({});
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey, loadedAtMs: 1,
      settingsVersion: 1, settingsSecretsReadKeys: [], settings });
    const value = 'PRIVATE-REAL-WRAPPER-D26';
    const physicalBytes: Uint8Array[] = [];
    let effects = 0;
    const trustedProducer = createConfidentialSecretFillExecutor({ expectedScopeKey: scopeKey, expectedAccountId: 'alice',
      serverId: localHome, machineId: 'machine', readHostIdentity: async () => ({ machineId: 'machine', serverIdentityId: hostIdentity }),
      readAccountMode: async () => mode,
      // Native preparation and delivery are the OS boundary; the trusted executor and materializer remain real.
      prepareTarget: async ({ request: reviewed }) => {
        expect(reviewed).toEqual(request);
        return { nativeObservation: 'not_observable', recheck: async () => true,
          fill: async (bytes, _signal, beforeDelivery) => {
            if (!await beforeDelivery?.()) return { status: 'refused', code: 'approval_changed' };
            expect(Buffer.from(bytes).toString()).toBe(value);
            physicalBytes.push(bytes); effects += 1;
            if (code === 'delivery_unknown') throw new Error(value);
            return { status: 'filled', code: 'filled' };
          }, finish: async () => {} };
      },
    });
    const uninstall = installDaemonMachineAdmissionTransport({ serverId: localHome,
      transport: async () => { throw new Error('Session input is not part of confidential delivery'); }, confidentialSecretFill: trustedProducer });
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
        serverId: localHome, serverApiUrl: 'https://verified-home.example.test',
        ...(identitySource === 'bound' ? { serverIdentityId: hostIdentity } : {}),
        resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated',
          features: FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: hostIdentity } } }) }),
        machineId: 'machine', pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}), getAccountSettings: () => settings },
        // The stored origin's authorization is a genuine Home boundary, not an internal constructor.
        isApprovalExecutionOriginCurrent: async () => true });
      const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
        authorizeRequest: input => authorizeMachineRpcRequest(input, { machineId: 'machine',
          resolveCustodianAccountId: async () => 'alice', resolveInstallationId: () => 'installation', verifyMachineAdmission: async () => true }) });
      registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor.bindInvocation(new AbortController().signal) });
      const result = await rpc.handleRequest({ method: `machine:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`,
        callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice',
          machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        params: { v: 1, artifactId: 'approval', requestId: 'request', actionId: 'computer.secret.fill', request,
          choice: { kind: 'once', value }, accountEncryptionMode: 'plain', submit: false } });
      expect(result).toEqual({ status: code === 'filled' ? 'filled' : code === 'delivery_unknown' ? 'unknown' : 'refused', code });
      expect(effects).toBe(code === 'filled' || code === 'delivery_unknown' ? 1 : 0);
      if (code === 'approval_changed') {
        expect(await executor.continueConfidentialApprovalRequest({ v: 1, artifactId: 'approval', requestId: 'request',
          actionId: 'computer.secret.fill', request, choice: { kind: 'once', value }, accountEncryptionMode: 'plain', submit: false },
        { authority: 'present_user', surface: 'rpc', serverIdentityId: 'srv_verified_home',
          runtimeAccountId: 'alice', verifyMachineAdmissionCurrent: async () => true }))
          .toEqual({ ok: false, errorCode: 'approval_stale', error: 'approval_stale' });
        expect(effects).toBe(0);
      }
      expect(physicalBytes.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
      expect(JSON.stringify(record)).not.toContain(value);
      const stored = await createCliApprovalsArtifactStore({ credentials, getAccountEncryptionMode: async () => 'plain' })
        .approvalsGet({ artifactId: 'approval', serverId: 'home' });
      expect(stored?.actionArgs).toEqual(request);
      expect(JSON.stringify(stored)).not.toContain(value);
      expect(ApprovalRequestV2Schema.parse(stored).executionOriginV1).toEqual(approval.executionOriginV1);
    } finally { uninstall(); }
  });
  it('rechecks the deciding shared human admission after preparation through the real relay handler', async () => {
    let created: ApprovalRequest | null = null;
    const creator = createActionExecutor({ approvalsCreate: async ({ request }) => {
      created = request; return { artifactId: 'approval' };
    }, isActionApprovalRequired: () => false });
    await creator.execute('computer.secret.fill', request, { surface: 'agent', authority: 'account_automation',
      serverId: 'home', defaultSessionId: 'session', defaultSessionMachineId: 'machine', actionRequestId: 'request',
      actionCaller: { kind: 'host' } });
    const approval = ApprovalRequestV2Schema.parse(created);
    let record = { id: 'approval', ownerAccountId: 'alice', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    http.get.mockImplementation(async () => ({ status: 200, data: { ...record } }));
    http.post.mockImplementation(async (_url: string, input: { header: string; body: string; expectedHeaderVersion: number; expectedBodyVersion: number }) => {
      if (input.expectedHeaderVersion !== record.headerVersion || input.expectedBodyVersion !== record.bodyVersion) {
        return { status: 409, data: { success: false, error: 'version-mismatch' } };
      }
      record = { ...record, header: input.header, body: input.body,
        headerVersion: record.headerVersion + 1, bodyVersion: record.bodyVersion + 1 };
      return { status: 200, data: { success: true, headerVersion: record.headerVersion, bodyVersion: record.bodyVersion } };
    });
    const store = createCliApprovalsArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    let decidingHumanCurrent = true;
    let effects = 0;
    const executor = createActionExecutor({ ...store, isApprovalExecutionOriginCurrent: async () => true,
      // This port is the physical OS delivery boundary. Its awaited preparation
      // retires Bob's Home grant; the original requester's origin remains current.
      confidentialSecretFill: async ({ isCurrent }) => {
        await Promise.resolve();
        decidingHumanCurrent = false;
        if (!await isCurrent()) return { status: 'refused', code: 'approval_changed' };
        effects += 1;
        return { status: 'filled', code: 'filled' };
      } });
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
      installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: input => authorizeMachineRpcRequest(input, {
        machineId: 'machine', resolveCustodianAccountId: async () => 'alice', resolveInstallationId: () => 'installation',
        // Current Home admission is the external authorization boundary.
        verifyMachineAdmission: async () => decidingHumanCurrent,
      }) });
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc, actionExecutor: executor });
    const value = 'REVOKED-HUMAN-PRIVATE-D26';
    const result = await rpc.handleRequest({ method: `machine:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`,
      callerAuthority: 'present_user', machineAdmission,
      params: { v: 1, artifactId: 'approval', requestId: 'request', actionId: 'computer.secret.fill', request,
        choice: { kind: 'once', value }, accountEncryptionMode: 'plain', submit: false } });
    expect(result).toEqual({ status: 'refused', code: 'approval_changed' });
    expect(effects).toBe(0);
    expect(JSON.stringify(record)).not.toContain(value);
  });
  it('uses the real approval transition and HTTP revision CAS to issue only one concurrent effect', async () => {
    let created: ApprovalRequest | null = null;
    const creator = createActionExecutor({ approvalsCreate: async ({ request }) => {
      created = request; return { artifactId: 'approval' };
    }, isActionApprovalRequired: () => false });
    await creator.execute('computer.secret.fill', request, { surface: 'agent', authority: 'account_automation',
      serverId: 'home', defaultSessionId: 'session', defaultSessionMachineId: 'machine', actionRequestId: 'request',
      actionCaller: { kind: 'host' } });
    const approval = ApprovalRequestV2Schema.parse(created);
    let record = { id: 'approval', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    http.get.mockImplementation(async () => ({ status: 200, data: { ...record } }));
    http.post.mockImplementation(async (_url: string, input: { header: string; body: string; expectedHeaderVersion: number; expectedBodyVersion: number }) => {
      if (input.expectedHeaderVersion !== record.headerVersion || input.expectedBodyVersion !== record.bodyVersion) {
        return { status: 409, data: { success: false, error: 'version-mismatch' } };
      }
      record = { ...record, header: input.header, body: input.body,
        headerVersion: record.headerVersion + 1, bodyVersion: record.bodyVersion + 1 };
      return { status: 200, data: { success: true, headerVersion: record.headerVersion, bodyVersion: record.bodyVersion } };
    });
    const store = createCliApprovalsArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    let effects = 0;
    const executor = createActionExecutor({ ...store, isApprovalExecutionOriginCurrent: async () => true,
      confidentialSecretFill: async ({ isCurrent }) => {
        expect(await isCurrent()).toBe(true);
        effects += 1;
        return { status: 'filled', code: 'filled' };
      } });
    const value = 'CONCURRENT-PRIVATE-D26';
    const continuation = { v: 1, artifactId: 'approval', requestId: 'request', actionId: 'computer.secret.fill', request,
      choice: { kind: 'once', value }, accountEncryptionMode: 'plain', submit: false } as const;
    const results = await Promise.all([0, 1].map(() => executor.continueConfidentialApprovalRequest(continuation,
      { serverId: 'home', authority: 'present_user' })));
    expect(results.some(result => result.ok)).toBe(true);
    expect(effects).toBe(1);
    expect(JSON.stringify(record)).not.toContain(value);
    expect(await executor.continueConfidentialApprovalRequest(continuation, { serverId: 'home', authority: 'present_user' }))
      .toEqual({ ok: true, result: { status: 'filled', code: 'filled' } });
    expect(effects).toBe(1);
  });
  it.each(['alice', undefined])('keeps the deciding actor independent of the stored requester for saved material: %s', async runtimeAccountId => {
    let created: ApprovalRequest | null = null;
    await createActionExecutor({ approvalsCreate: async ({ request }) => {
      created = request; return { artifactId: 'approval' };
    }, isActionApprovalRequired: () => false }).execute('computer.secret.fill', request, {
      surface: 'agent', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'alice',
      defaultSessionId: 'session', defaultSessionMachineId: 'machine', actionRequestId: 'request', actionCaller: { kind: 'host' },
    });
    const approval = ApprovalRequestV2Schema.parse(created);
    expect(approval.executionOriginV1.accountId).toBe('alice');
    let record = { id: 'approval', ownerAccountId: 'alice', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    http.get.mockImplementation(async () => ({ status: 200, data: { ...record } }));
    http.post.mockImplementation(async (_url: string, input: { header: string; body: string; expectedHeaderVersion: number; expectedBodyVersion: number }) => {
      if (input.expectedHeaderVersion !== record.headerVersion || input.expectedBodyVersion !== record.bodyVersion) {
        return { status: 409, data: { success: false, error: 'version-mismatch' } };
      }
      record = { ...record, header: input.header, body: input.body,
        headerVersion: record.headerVersion + 1, bodyVersion: record.bodyVersion + 1 };
      return { status: 200, data: { success: true, headerVersion: record.headerVersion, bodyVersion: record.bodyVersion } };
    });
    const value = 'PRIVATE-SAVED-DECIDING-ACTOR-D26';
    const settings = AccountSettingsSchema.parse({ secrets: [{ id: 'personal', name: 'Password', kind: 'password',
      createdAt: 1, updatedAt: 1, encryptedValue: { _isSecretValue: true, value } }] });
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'deciding-actor', loadedAtMs: 1,
      settingsVersion: 1, settingsSecretsReadKeys: [], settings });
    let effects = 0;
    const consumer = createConfidentialSecretFillExecutor({ expectedScopeKey: 'deciding-actor', expectedAccountId: 'alice',
      serverId: 'home', machineId: 'machine', readAccountMode: async () => 'plain',
      prepareTarget: async () => ({ nativeObservation: 'not_observable', recheck: async () => true,
        fill: async (bytes, _signal, beforeDelivery) => {
          if (!await beforeDelivery?.()) return { status: 'refused', code: 'approval_changed' };
          expect(Buffer.from(bytes).toString()).toBe(value); effects += 1;
          return { status: 'filled', code: 'filled' };
        }, finish: async () => {} }),
    });
    const store = createCliApprovalsArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    const executor = createActionExecutor({ ...store, isApprovalExecutionOriginCurrent: async () => true,
      confidentialSecretFill: consumer });
    expect(await executor.continueConfidentialApprovalRequest({ v: 1, artifactId: 'approval', requestId: 'request',
      actionId: 'computer.secret.fill', request, choice: { kind: 'saved', ref: 'personal', fingerprint: 'personal:personal:1', revision: null },
      accountEncryptionMode: 'plain', submit: false }, { authority: 'present_user', surface: 'rpc', serverId: 'home',
      runtimeAccountId, verifyMachineAdmissionCurrent: async () => true }))
      .toEqual({ ok: true, result: runtimeAccountId ? { status: 'filled', code: 'filled' }
        : { status: 'refused', code: 'saved_secret_forbidden' } });
    expect(effects).toBe(runtimeAccountId ? 1 : 0);
    expect(JSON.stringify(record)).not.toContain(value);
    const stored = await store.approvalsGet({ artifactId: 'approval', serverId: 'home' });
    expect(ApprovalRequestV2Schema.parse(stored).executionOriginV1).toEqual(approval.executionOriginV1);
  });
});
