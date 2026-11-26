import axios from 'axios';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionReadinessV1Schema } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { createLoadedMachineProvisionerFixture } from '@/plugins/projection/registry/machineProvisioners.testkit';
import { createApiSessionSocketStub, bindApiSessionSocketMock } from '@/testkit/backends/apiSessionSocketHarness';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { io } from 'socket.io-client';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { PluginAvailabilityIntentsListActionInputV1Schema, PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

function createReadinessSessionFixture(overrides: Parameters<typeof createSessionRecordFixture>[0] & { metadata: string }) {
  const fields = buildSessionMetadataEnvelopeFields({ credentials: { token: 'fixture', encryption: null }, accountEncryptionMode: 'plain',
    storedContentMode: 'plain', metadata: JSON.parse(overrides.metadata), agentState: null });
  const shared = overrides.effectiveAccess !== undefined && overrides.effectiveAccess.level !== 'owner';
  const sharedDisplay = fields.displayProjectionV1 ? { ...fields.displayProjectionV1 } : undefined;
  if (sharedDisplay) delete sharedDisplay.owner;
  return createSessionRecordFixture({ ...overrides, metadataVersion: 0, metadataLayoutVersion: fields.metadataLayoutVersion,
    metadata: fields.sharedMetadata.ciphertext,
    ...(shared ? { share: { accessLevel: overrides.effectiveAccess?.level === 'view' ? 'view' : 'edit', canApprovePermissions: false },
      displayProjectionV1: sharedDisplay }
      : { share: null, ownerMetadata: fields.ownerMetadata, displayProjectionV1: fields.displayProjectionV1 }) });
}

function bindMachineRpcBoundary(transport: Readonly<{
  machineId: string; invoke(method: string, input: unknown): Promise<unknown>;
}>) {
  bindApiSessionSocketMock(vi.mocked(io), createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
    expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Expected a Machine RPC packet');
    }
    expect(payload.method.startsWith(`${transport.machineId}:`)).toBe(true);
    const input: unknown = typeof payload.params === 'string' ? JSON.parse(payload.params) : payload.params;
    return { ok: true, result: await transport.invoke(payload.method.slice(transport.machineId.length + 1), input) };
  } }));
  return transport;
}

beforeEach(() => {
  installAxiosRequestMethodAdapter();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} }))));
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (new URL(String(url)).pathname === '/v1/plugins/availability/intents/list') {
      const request = PluginAvailabilityIntentsListActionInputV1Schema.parse(body);
      const pluginIds = [...new Set(request.pluginIds ?? request.knownPluginIds ?? [])].sort();
      return { status: 200, data: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 0, pluginIds,
        intentReads: pluginIds.map(pluginId => ({ pluginId, response: { availabilityCursor: 0,
          hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [] } })), failedPluginIds: [] }) };
    }
    throw new Error(`Unexpected Home write: ${url}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reads an entitled exact Team binding through the live CLI composition without personal Account setup', async () => {
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'team-invoker' })).toString('base64url')}.signature`, encryption: null };
  const serverId = 'home-team';
  const serverHttpBaseUrl = 'https://team-readiness.test';
  const sessionId = 'c123456789012345678901234';
  const service = { pluginId: 'acme.external', localId: 'account' };
  const purpose = { consumer: { pluginId: service.pluginId, localId: 'helper' }, purpose: 'outside-write' };
  const selection = { source: 'team_resource' as const, resourceId: 'shared-resource', deliveryMode: 'brokered' as const };
  const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: selection.resourceId, teamId: 'team',
    displayName: { content: { t: 'plain', v: 'Shared Acme' }, recipientEnvelope: null },
    resourceRevision: 1, readiness: { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-10-20T00:00:00Z' },
    recoveryAction: 'source_owner_action', mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
    sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [selection], sourcePresentation: { kind: 'connected_service', service } });
  const teamRequest = bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: 'team' });
  const row = createReadinessSessionFixture({ id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine-1' }),
    computerMachineBinding: { homeId: 'team-home', machineId: 'machine-1' },
    effectiveAccess: { v: 1, level: 'edit', sources: [{ kind: 'direct', shareId: 'share' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: 'edit', canApprovePermissions: false }] }) } });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    if (path === '/v1/machines/machine-1') return { status: 200, data: { machine: { id: 'machine-1', active: true, revokedAt: null, replacedByMachineId: null,
      kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } } } };
    throw new Error(`Unexpected private Account read ${path}`);
  });
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    expect(request.url).toBe(`${serverHttpBaseUrl}${teamRequest.path}`);
    expect(request.method).toBe(teamRequest.method);
    return { status: 200, data: { resources: [resource], nextCursor: null } };
  });
  const executor = createCliActionExecutor({ token: credentials.token, credentials, mode: 'plain', ctx: null, sessionId: '', serverId, serverHttpBaseUrl,
    accountServerActionDeps: createAccountServerActionDeps({ token: credentials.token, credentials, serverId, serverHttpBaseUrl }),
    machineActionDirectTargetTransport: bindMachineRpcBoundary({ machineId: 'machine-1', invoke: async () => ({ protocolVersion: 1, projection: {
      v: 2, generation: 1, installedPackagesById: { [service.pluginId]: { id: service.pluginId, displayName: 'Acme', enabled: true,
        source: { kind: 'builtin', locator: service.pluginId } } }, resourcesById: { helper: { id: 'helper', pluginId: service.pluginId,
        resourceKind: 'config', path: 'helper.json', connectedAccountPurposes: [{ purpose: purpose.purpose, serviceRefs: [service] }] } },
    } }) }) });
  const teamResult = await executor.execute('session.status.get', { sessionId, readiness: true, operation: 'credential', credentialPurpose: purpose,
    credentialTeamSelection: { purpose, teamId: resource.teamId, selection } }, { surface: 'cli', serverId });
  expect(teamResult, JSON.stringify(teamResult))
    .toMatchObject({ ok: true, result: { readiness: { operation: 'credential', credential: { kind: 'team', teamId: resource.teamId,
      resourceId: resource.id, readiness: resource.readiness, recoveryAction: resource.recoveryAction } } } });
});

it.each(['resource', 'machineProvisioner'] as const)('reads the %s operation execution Account purpose and repairs its expired exact connection through the real Action', async consumerKind => {
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`, encryption: null };
  const service = { pluginId: 'acme.external', localId: 'account' };
  const purpose = { consumer: { pluginId: 'acme.external', localId: 'helper' }, purpose: 'outside-write' };
  const account = { service, accountId: 'work' };
  const sessionId = 'c123456789012345678901234';
  const row = createReadinessSessionFixture({ id: sessionId, encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine-1' }),
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
  const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
    projection: { v: 2, generation: 1, installedPackagesById: { 'acme.external': { id: 'acme.external', displayName: 'Acme',
      enabled: true, source: { kind: 'builtin', locator: 'acme.external' } } },
    resourcesById: consumerKind === 'resource' ? { helper: { id: 'helper', pluginId: 'acme.external', resourceKind: 'config', path: 'helper.json',
      connectedAccountPurposes: [{ purpose: purpose.purpose, serviceRefs: [service] }] } } : {},
    familiesById: { ...(consumerKind === 'machineProvisioner' ? { machineProvisioners: { family: 'machineProvisioners', entriesById: {
      [`${service.pluginId}/helper`]: { id: `${service.pluginId}/helper`, pluginId: service.pluginId, pluginVersion: '1.0.0',
        definition: { ...createLoadedMachineProvisionerFixture(service.pluginId).manifest.contributes.machineProvisioners![0], id: 'helper' },
        connectedAccountPurposes: [{ purpose: purpose.purpose, serviceRefs: [service] }] },
    } } } : {}), connectedAccounts: { family: 'connectedAccounts', entriesById: { account: {
      id: service.localId, serviceId: service.localId, pluginId: service.pluginId, provenance: 'external', sourceKind: 'test', title: 'Acme',
      authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] },
      capabilities: [], availability: { state: 'available', reason: 'enabled' }, diagnostics: [],
    } } } } } });
  let connected = false;
  const profile = () => AccountProfileSchema.parse({ id: 'alice', connectedAccountsV4: [{ ref: account, status: 'connected',
    revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`, authenticationModeId: 'manual',
    configurationReady: true, configurationRevision: null, expiresAt: connected ? null : 1 }] });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    if (path === '/v1/machines/machine-1') return { status: 200, data: { machine: { id: 'machine-1', active: true,
      revokedAt: null, replacedByMachineId: null, kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
    if (path === '/v1/account/profile') return { status: 200, data: profile() };
    if (path === '/v4/connect/qualified/credential') return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: account, authenticationModeId: 'manual', revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`,
      configurationRevision: null, content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
        payload: { v: 1, values: { token: 'fixture-credential' } }, randomBytes: length => new Uint8Array(length) }), metadata: { scopes: [] },
    }) };
    if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: { status: 'present', revision: 1,
      content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{ purpose, target: { kind: 'account', account } }] } } } } };
    throw new Error(`Unexpected operation diagnostic HTTP ${path}`);
  });
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://readiness.test',
    snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }, isCurrent: async () => true });
  const describeSelections: unknown[] = [];
  const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, mode: 'plain', ctx: null,
    sessionId: '', serverId: 'home-a', serverHttpBaseUrl: 'https://readiness.test', savedSecretOperationContext: operationContext,
    machineActionDirectTargetTransport: bindMachineRpcBoundary({ machineId: 'machine-1', invoke: async (method, payload) => {
      if (method.includes('contributionRegistryProjection.describe')) {
        describeSelections.push((payload as Readonly<{ selection?: unknown }>).selection);
        return projection;
      }
      if (method === CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD) {
        expect(payload).toMatchObject({ command: { operation: 'beginReconnect', account } });
        connected = true;
        return { status: 'connected', attemptId: 'exact-repair', account };
      }
      throw new Error(`Unexpected operation diagnostic RPC ${method}`);
    } }) }));
  const context = { surface: 'cli' as const, serverId: 'home-a', authority: 'present_user' as const };
  const input = { sessionId, readiness: true, operation: 'credential', credentialPurpose: purpose };
  const result = await executor.execute('session.status.get', input, context);
  expect(describeSelections, JSON.stringify(result)).toContain('connectedAccountAdmission');
  expect(result).toMatchObject({ ok: true, result: { readiness: { operation: 'credential',
    credential: { kind: 'personal', purpose, usable: false, repair: {
      actionId: 'connectedServices.authentication.beginReconnect', input: { machineId: 'machine-1', account },
    } } } } });
  if (!result.ok) throw new Error(result.errorCode);
  const parsed = SessionStatusActionResultV1Schema.parse(result.result);
  const repair = parsed.ok !== false && parsed.readiness?.credential.kind === 'personal' ? parsed.readiness.credential.repair : null;
  if (!repair) throw new Error('Missing exact operation repair');
  const repaired = await executor.execute(repair.actionId, repair.input, { ...context, presentUserConfirmation: { actionId: repair.actionId } });
  expect(repaired, JSON.stringify(repaired))
    .toMatchObject({ ok: true, result: { status: 'connected', account } });
  expect(await executor.execute('session.status.get', input, context)).toMatchObject({ ok: true, result: {
    readiness: { credential: { kind: 'personal', usable: true, repair: null } },
  } });
});

it('keeps a requested credential operation unknown when the Session has no admitted binding instead of certifying conversation', async () => {
  const sessionId = 'c123456789012345678901234';
  const row = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}',
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: row } };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
    mode: 'plain', ctx: null, sessionId: '', serverId: 'home-a', serverHttpBaseUrl: 'https://readiness.test' }));
  const result = await executor.execute('session.status.get', { sessionId, readiness: true, operation: 'credential',
    credentialPurpose: { consumer: { pluginId: 'acme.external', localId: 'helper' }, purpose: 'outside-write' } },
  { surface: 'cli', serverId: 'home-a' });
  expect(result).toMatchObject({ ok: true, result: { readiness: {
    operation: 'credential', credential: { kind: 'unknown' },
  } } });
  if (result.ok) expect(SessionStatusActionResultV1Schema.parse(result.result)).toEqual(result.result);
});

it('reads on demand, repairs through the real sign-in Action, and observes the acknowledged native setup', async () => {
  const sessionId = 'c123456789012345678901234';
  const sessionForAccess = (invokeAllowed: boolean) => createReadinessSessionFixture({ id: sessionId, encryptionMode: 'plain',
    metadata: JSON.stringify({ machineId: 'machine-1', path: '/workspace', flavor: 'codex' }),
    effectiveAccess: { v: 1, level: invokeAllowed ? 'owner' : 'view', sources: invokeAllowed ? [{ kind: 'owner' }] : [],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: invokeAllowed, grants: [] }) } });
  let invokeAllowed = true;
  let machineOnline = true;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: sessionForAccess(invokeAllowed) } };
    if (path === '/v1/machines/machine-1') return { status: 200, data: { machine: { id: 'machine-1', active: machineOnline,
      revokedAt: null, replacedByMachineId: null, kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  let signedIn = false;
  const calls: string[] = [];
  const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
    mode: 'plain', ctx: null, sessionId: '', serverId: 'home-a', serverHttpBaseUrl: 'https://readiness.test',
    machineActionDirectTargetTransport: bindMachineRpcBoundary({ machineId: 'machine-1', invoke: async (method) => {
      calls.push(method);
      if (method === 'daemon.extensions.contributionRegistryProjection.describe') return { protocolVersion: 1,
        projection: { v: 2, generation: 1, familiesById: {}, agentsById: { codex: { id: 'codex', title: 'Codex',
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } } } };
      if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.codex': {
        ok: true, checkedAt: Date.now(), data: { installed: true, available: true, resolvedPath: '/agent/codex',
          version: null, latestVersion: null, update: { supported: false, command: null },
          signIn: { status: signedIn ? 'signedIn' : 'signedOut', loginSupport: 'login_terminal' },
          platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] },
      } } };
      if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: 'codex' } };
      if (method === 'daemon.terminal.ensure') return { ok: true, terminalId: 'login-terminal', reused: false };
      throw new Error(`Unexpected Machine operation ${method}`);
    } }),
  }));
  const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home-a' };
  const status = await executor.execute('session.status.get', { sessionId }, context);
  expect(status.ok, JSON.stringify(status)).toBe(true);
  expect(calls).toEqual([]);
  const unavailable = await executor.execute('session.status.get', { sessionId, readiness: true }, context);
  expect(unavailable, JSON.stringify({ unavailable, calls })).toMatchObject({ ok: true, result: { readiness: { configured: true, status: 'unavailable', cause: 'agent' } } });
  if (!unavailable.ok) throw new Error(unavailable.errorCode);
  const result = SessionStatusActionResultV1Schema.parse(unavailable.result);
  if (result.ok === false || !result.readiness) throw new Error('Missing current readiness');
  const readiness = SessionReadinessV1Schema.parse(result.readiness);
  const repair = readiness.agent?.repair;
  if (!repair) throw new Error('Missing entitled native repair');
  const repaired = await executor.execute(repair.actionId, repair.input, { ...context,
    presentUserConfirmation: { actionId: repair.actionId } });
  expect(repaired, JSON.stringify(repaired)).toMatchObject({ ok: true, result: { terminalId: 'login-terminal' } });
  signedIn = true; // OS/native login acknowledgement at the substituted Machine boundary.
  expect(await executor.execute('session.status.get', { sessionId, readiness: true }, context))
    .toMatchObject({ ok: true, result: { readiness: { status: 'ready', cause: null } } });
  machineOnline = false;
  expect(await executor.execute('session.status.get', { sessionId, readiness: true }, context))
    .toMatchObject({ ok: true, result: { readiness: { status: 'unavailable', cause: 'machine', machine: { status: 'offline' } } } });
  invokeAllowed = false;
  expect(await executor.execute('session.status.get', { sessionId, readiness: true }, context))
    .toMatchObject({ ok: true, result: { session: { id: sessionId }, readiness: { status: 'unavailable', cause: 'invocation' } } });
  expect(calls.filter(method => method === 'capabilities.detect')).toHaveLength(2);
  expect(calls.filter(method => method === 'daemon.terminal.ensure')).toHaveLength(1);
});
