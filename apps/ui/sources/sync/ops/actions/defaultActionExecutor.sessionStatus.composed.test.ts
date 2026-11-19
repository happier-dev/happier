import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import {
  createHydratedPlainMachineFixture, createPlainMachineRowFixture, createReadyMachineAgentInventoryFixture,
} from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionReadBatchRequestV1Schema, SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { machineAgentInventoryStore } from '@/agents/machineAgents/machineAgentInventoryStore';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { UNSUPPORTED_AGENT_SESSION_CAPABILITIES } from '@happier-dev/agents';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { SessionModelSelectionV2Schema, sessionModelSelectionV2TeamBindingIntent } from '@happier-dev/protocol/providers/selection/v2';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readAccountAgentProviderRequirements } from '@/providers/catalog/accountProviderDeclarations';

const homes = createHomeGovernanceHarness();
const httpBoundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
const network = await installSessionOpsNetworkBoundary();
installHomeGovernanceBoundaries(httpBoundary);
const { createVoiceToolHandlers } = await import('@/voice/tools/handlers');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { getStorage } = await import('@/sync/domains/state/storage');
const initial = getStorage().getState();
beforeEach(async () => { network.resetRequests(); await homes.reset(); installHomeGovernanceBoundaries(httpBoundary); });
afterEach(() => { getStorage().setState(initial, true); standardCleanup(); });
afterAll(() => network.dispose());

it.each([
  { deliveryMode: 'brokered', resourceId: 'resource-1', teamId: 'team-1', revision: 2, ready: true },
  { deliveryMode: 'brokered', resourceId: 'resource-1', teamId: 'team-1', revision: 4, ready: true },
  { deliveryMode: 'direct', resourceId: 'resource-1', teamId: 'team-1', revision: 4, ready: true },
  { deliveryMode: 'brokered', resourceId: 'other-resource', teamId: 'team-1', revision: 4, ready: false },
  { deliveryMode: 'brokered', resourceId: 'resource-1', teamId: 'other-team', revision: 4, ready: false },
  { deliveryMode: 'vendor-native', resourceId: 'resource-1', teamId: 'team-1', revision: 4, ready: false },
] as const)('projects retained Team model readiness from the accepted $deliveryMode $teamId/$resourceId revision $revision', async ({
  deliveryMode, resourceId, teamId, revision, ready,
}) => {
  const serverUrl = 'https://team-model-status.test';
  const serverId = await homes.addHome({ name: 'Team route', serverUrl, accountId: 'alice', currentAccount: true });
  const machineId = 'team-model-machine';
  const agentTargetKey = 'agent:happier.agent.codex/codex';
  const machine = createHydratedPlainMachineFixture({ id: machineId, accountId: 'alice', machine: { activeAt: Date.now() } });
  await publishMachineInventoryForTest({ serverId, accountId: 'alice' }, [machine]);
  homes.answer(serverId, `/v1/machines/${machineId}`, {
    body: { machine: createPlainMachineRowFixture({ id: machineId, accountId: 'alice', machine }) },
  });
  const inventory = createReadyMachineAgentInventoryFixture([{ agentId: 'codex', title: 'Codex' }]);
  const providerRequirements = readAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' });
  if (!providerRequirements) throw new Error('Expected bundled Codex Provider requirements');
  network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, {
    protocolVersion: 1, projection: { ...inventory.projection, agentsById: {
      codex: { ...inventory.projection.agentsById.codex, identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, providerRequirements },
    } },
  });
  network.respond(RPC_METHODS.DAEMON_AGENTS_INSTALL_LIST, { jobs: [] });
  network.respond('capabilities.detect', inventory.capabilities);
  const retained = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 1, ref: {
    source: 'team_resource', resourceId: 'resource-1', teamId: 'team-1', expectedResourceRevision: 2,
    deliveryMode, agentTargetKey, modelId: 'shared-model',
  } });
  const accepted = sessionModelSelectionV2TeamBindingIntent(SessionModelSelectionV2Schema.parse({
    ...retained, ref: { ...retained.ref, resourceId, teamId, expectedResourceRevision: revision },
  }));
  const session = createSessionFixture({ id: 'team-model-session', metadata: {
    ...createSessionFixture().metadata!, machineId, flavor: 'codex', modelSelectionIntentV2: retained,
  } });
  const response = createPlainSessionByIdResponseFixture(session);
  homes.answer(serverId, `/v2/sessions/${session.id}`, { body: { session: { ...response.session,
    acceptedTeamCredentialBinding: accepted, effectiveAccess: { ...response.session.effectiveAccess!, primaryTeamId: 'team-1' },
  } } });
  const provider = { pluginId: 'happier.provider.muse', localId: 'muse' };
  const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
    id: resourceId, teamId, resourceRevision: revision,
    displayName: { content: { t: 'plain', v: 'Shared models' }, recipientEnvelope: null },
    readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: deliveryMode === 'direct',
    directMaterialState: deliveryMode === 'direct' ? 'current' : 'never_delivered',
    sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
    sourcePresentation: { kind: 'provider', provider: { identity: provider, definitionRevision: 1 } },
    providerModels: [{
      descriptor: { id: 'shared-model', name: 'Shared model' }, sourceRevision: 'source-current', availability: 'available',
      selection: { kind: 'team_credential_provider_model', resourceId, teamId, expectedResourceRevision: revision,
        deliveryMode, agentTargetKey, modelId: 'shared-model' },
      application: { agentTargetKey, implementationIdentity: provider, endpointTemplateId: 'responses', protocol: 'openai-responses' },
    }],
  });
  const entitledRequest = bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId });
  homes.answer(serverId, `${entitledRequest.method} ${entitledRequest.path}`, { select: input => ({
    body: { resources: input && typeof input === 'object' && 'teamId' in input && input.teamId === teamId ? [resource] : [], nextCursor: null },
  }) });
  const result = await createDefaultActionExecutor().execute('session.status.get', { sessionId: session.id, readiness: true },
    { surface: 'ui', serverId, expectedAccountId: 'alice' });
  expect(result, JSON.stringify({ result, rpcMethods: network.requests.map(request => request.method),
    homePaths: homes.requests.map(request => request.path) })).toMatchObject({ ok: true, result: { readiness: {
    status: ready ? 'ready' : 'unknown', cause: ready ? null : 'credential',
    credential: { kind: 'team', teamId: 'team-1', resourceId: 'resource-1', readiness: ready ? { kind: 'available' } : null },
  } } });
});

it('keeps supported, native unsupported and unknown compact evidence distinct in the public status Action', async () => {
  const serverId = await homes.addHome({ name: 'Compact', serverUrl: 'https://compact-status.test', accountId: 'alice', currentAccount: true });
  for (const [id, publication, expected] of [
    ['supported', { sessionCapabilities: { ...UNSUPPORTED_AGENT_SESSION_CAPABILITIES, compaction: { events: true, manual: true } } }, 'supported'],
    ['unsupported', { sessionCapabilities: UNSUPPORTED_AGENT_SESSION_CAPABILITIES }, 'unsupported'],
    ['unknown', undefined, 'unknown'],
  ] as const) {
    const session = createSessionFixture({ id, encryptionMode: 'plain', access: createSessionAccessFixture('owner'),
      metadata: { ...createSessionFixture().metadata, flavor: 'external/agent',
        runtimeDescriptorV1: { v: 1, agentId: 'external/agent', agent: {} },
        ...(publication ? { agentRuntimeCapabilitiesV1: publication } : {}) } });
    homes.answer(serverId, `/v2/sessions/${id}`, { body: createPlainSessionByIdResponseFixture(session) });
    const result = await createDefaultActionExecutor().execute('session.status.get', { sessionId: id },
      { surface: 'ui', serverId, expectedAccountId: 'alice' });
    expect(result).toMatchObject({ ok: true, result: { compaction: { status: expected } } });
    if (result.ok) expect(SessionStatusActionResultV1Schema.parse(result.result)).toEqual(result.result);
  }
  expect(homes.requests.filter(request => request.path.startsWith('/v1/machines'))).toHaveLength(0);
});

it('exposes the pending native permission offer through the exact-Home status Action', async () => {
  const serverId = await homes.addHome({ name: 'Pending', serverUrl: 'https://pending-status.test', accountId: 'alice', currentAccount: true });
  const nativeChoices = { requirementId: 'requirement-1', source: 'native-agent', choices: [
    { id: 'approve-one', label: 'Approve once', decision: 'approved' as const, scope: 'once' as const,
      response: { approved: true as const, decision: 'approved' as const } },
  ] };
  const session = createSessionFixture({ id: 'pending-session', active: true, encryptionMode: 'plain',
    access: createSessionAccessFixture('owner'),
    agentState: { controlledByUser: false, requests: { 'request-1': { tool: 'native-tool', kind: 'permission',
      turnId: 'turn-1', arguments: { privateArgument: 'excluded-from-status' }, createdAt: 1, nativeChoices } } } });
  homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
  const result = await createDefaultActionExecutor().execute('session.status.get', { sessionId: session.id },
    { surface: 'ui', serverId, expectedAccountId: 'alice' });
  expect(result).toMatchObject({ ok: true, result: { pendingRequests: [{ requestId: 'request-1', turnId: 'turn-1',
    kind: 'permission', tool: 'native-tool', nativeChoices }], agentState: { controlledByUser: false, pendingRequestsCount: 1 } } });
  if (result.ok) {
    expect(SessionStatusActionResultV1Schema.parse(result.result)).toEqual(result.result);
    expect(result.result).not.toHaveProperty('pendingRequests.0.arguments');
  }
});

it('WF44 reaches exact managed-subtree proof through the default Action executor and denies a detached target', async () => {
  // This scenario serves the exact batch route itself; the legacy scalar
  // fixture adapter deliberately synthesizes batches without forwarding it.
  installHomeGovernanceBoundaries(homes);
  const serverId = await homes.addHome({ name: 'Managed', serverUrl: 'https://managed.test', accountId: 'alice', currentAccount: true });
  const session = createSessionFixture({ id: 'managed-child', encryptionMode: 'plain', access: createSessionAccessFixture('owner') });
  const callerSession = createSessionFixture({ id: 'lead', encryptionMode: 'plain', access: createSessionAccessFixture('owner') });
  const context = { surface: 'agent' as const, serverId, expectedAccountId: 'alice', defaultSessionId: 'lead',
    sessionListAccess: 'led_subtree' as const, authority: 'account_automation' as const,
    actionCaller: { kind: 'session' as const, sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
    agentStartContext: { caller: { kind: 'session' as const, sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine', directory: '/repo' }, roles: {}, callerPermissionCeiling: 'default' as const,
      ledSubtreeSessionIds: [], workDepthLimit: 4 } };
  homes.answer(serverId, '/v2/sessions/read-batch', { select: input => {
    const demand = SessionReadBatchRequestV1Schema.parse(input);
    const target = demand.sessionIds[0] === callerSession.id ? callerSession : session;
    return { body: SessionReadBatchResponseV1Schema.parse({ results: [{ sessionId: target.id,
      detail: { status: 200, body: createPlainSessionByIdResponseFixture(target) },
      ...(demand.includeTurns !== false ? { turns: { status: 200, body: { v: 1, sessionId: target.id, updatedAt: 1, turns: [] } } } : {}),
    }] }) };
  } });
  const executor = createDefaultActionExecutor();
  const result = await executor.execute('session.status.get', { sessionId: session.id }, context);
  expect(result, JSON.stringify(result))
    .toMatchObject({ ok: true, result: { session: { id: session.id } } });
  const proofs = homes.requests.filter(request => request.path === '/v2/sessions/read-batch')
    .map(request => SessionReadBatchRequestV1Schema.parse(request.input)).filter(demand => demand.underSessionId !== undefined);
  const expectedProof = { sessionIds: [session.id], underSessionId: 'lead', accessProjectionVersion: 1,
    includeSnapshot: true, includeTurns: false, includeMessages: false };
  // The exact subtree observation admits this invocation once.
  expect(proofs).toEqual([expectedProof]);
  homes.answer(serverId, '/v2/sessions/read-batch', { select: input => {
    const demand = SessionReadBatchRequestV1Schema.parse(input);
    return { body: { results: [demand.sessionIds[0] === callerSession.id
      ? { sessionId: callerSession.id, detail: { status: 200, body: createPlainSessionByIdResponseFixture(callerSession) } }
      : { sessionId: session.id, detail: { status: 404, body: { error: 'not_found' } } }] } };
  } });
  expect(await executor.execute('session.status.get', { sessionId: session.id }, context))
    .toMatchObject({ ok: false, details: { cause: 'target_outside_led_subtree' } });
  expect(homes.requests.filter(request => request.path === '/v2/sessions/read-batch')
    .map(request => SessionReadBatchRequestV1Schema.parse(request.input)).filter(demand => demand.underSessionId !== undefined))
    .toEqual([expectedProof, expectedProof]);
  expect(homes.requests.some(request => request.path === '/v2/sessions/query')).toBe(false);
});

it.each(['ui', 'voice'] as const)('reads configured versus denied invocation through the registered exact-Home %s status Action without Machine work', async surface => {
  const serverId = await homes.addHome({ name: 'Readiness', serverUrl: 'https://readiness.test', accountId: 'alice', currentAccount: true });
  const session = createSessionFixture({ id: 'status-session', encryptionMode: 'plain', access: createSessionAccessFixture('view') });
  homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
  const input = { sessionId: session.id, readiness: true };
  const result = surface === 'ui'
    ? await createDefaultActionExecutor().execute('session.status.get', input, { surface, serverId, expectedAccountId: 'alice' })
    : JSON.parse(await createVoiceToolHandlers({ resolveSessionId: () => null }).action_execute!(
      { actionId: 'session.status.get', input }, { serverId }));
  expect(result).toMatchObject({ ok: true, result: { session: { id: session.id },
    readiness: { v: 1, configured: true, status: 'unavailable', cause: 'invocation' } } });
  if (result.ok) expect(SessionStatusActionResultV1Schema.parse(result.result)).toEqual(result.result);
  expect(homes.requests.filter(request => request.path.startsWith('/v1/machines'))).toHaveLength(0);
});

it('retains the requested credential operation without borrowing the viewing Account setup', async () => {
  const serverId = await homes.addHome({ name: 'Readiness', serverUrl: 'https://readiness.test', accountId: 'bob', currentAccount: true });
  const session = createSessionFixture({ id: 'shared-bot', encryptionMode: 'plain', access: createSessionAccessFixture('view') });
  homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
  const result = await createDefaultActionExecutor().execute('session.status.get', { sessionId: session.id, readiness: true,
    operation: 'credential', credentialPurpose: { consumer: { pluginId: 'acme.external', localId: 'helper' }, purpose: 'outside-write' } },
  { surface: 'ui', serverId, expectedAccountId: 'bob' });
  expect(result).toMatchObject({ ok: true, result: { readiness: {
    operation: 'credential', credential: { kind: 'unknown' }, status: 'unavailable', cause: 'invocation',
  } } });
  if (result.ok) expect(SessionStatusActionResultV1Schema.parse(result.result)).toEqual(result.result);
  expect(homes.requests.filter(request => request.path === '/v1/account/profile')).toHaveLength(0);
});

it('reads a Session for a Home the Action context names by profile id and the Account scope by its portable id', async () => {
  // A widget's picked Session is qualified by the portable Home id, while the caller's context carries the device profile id.
  const serverId = await homes.addHome({ name: 'Portable', serverUrl: 'https://portable.test', serverIdentityId: 'srv_status_portable', accountId: 'alice', currentAccount: true });
  const session = createSessionFixture({ id: 'portable-session', encryptionMode: 'plain', access: createSessionAccessFixture('view') });
  homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
  const result = await createDefaultActionExecutor().execute('session.status.get', { sessionId: session.id },
    { surface: 'ui', serverId, expectedAccountId: 'alice' });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { session: { id: session.id } } });
});

it.each(['accepted', 'recipient', 'unavailable'] as const)('projects %s checkout proof only on an explicit status read', async scenario => {
  const serverId = await homes.addHome({ name: 'Checkout', serverUrl: 'https://checkout-status.test', accountId: 'alice', currentAccount: true });
  const state = getStorage().getState();
  const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice' };
  getStorage().setState({ profileScope: scope });
  const checkout = { id: 'checkout', serverId: scope.serverId, machineId: 'checkout-machine', rootPath: '/work/project', createdAtMs: 1,
    repositoryIdentity: { kind: 'github' as const, deployment: 'https://github.com', repository: 'acme/project' } };
  state.activateProjectAccountRowsScope(scope);
  getStorage().getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
    workspaceRefs: scenario === 'unavailable' ? [] : [checkout], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
  const session = createSessionFixture({ id: 'checkout-session', encryptionMode: 'plain', ownerAccountId: scenario === 'recipient' ? 'other' : 'alice',
    access: createSessionAccessFixture(scenario === 'recipient' ? 'view' : 'owner'),
    metadata: { ...createSessionFixture().metadata!, flavor: 'codex', machineId: checkout.machineId, path: checkout.rootPath, workspaceId: checkout.id } });
  homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
  const executor = createDefaultActionExecutor();
  const ordinary = await executor.execute('session.status.get', { sessionId: session.id }, { surface: 'ui', serverId, expectedAccountId: 'alice' });
  expect(ordinary).not.toHaveProperty('result.acceptedWorkspace');
  if (scenario === 'recipient') expect(ordinary).not.toHaveProperty('result.agentTarget');
  else expect(ordinary).toMatchObject({ result: {
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
  } });
  const result = await executor.execute('session.status.get', { sessionId: session.id, includeAcceptedWorkspace: true },
    { surface: 'ui', serverId, expectedAccountId: 'alice' });
  expect(result).toMatchObject({ ok: true, result: { session: { id: session.id } } });
  if (scenario === 'accepted') expect(result).toMatchObject({ result: { acceptedWorkspace: {
    checkout: { serverId: scope.serverId, workspaceId: checkout.id, machineId: checkout.machineId, rootPath: checkout.rootPath }, repository: checkout.repositoryIdentity,
  } } });
  else expect(result).not.toHaveProperty('result.acceptedWorkspace');
  expect(homes.requests.filter(request => request.path.includes('/project-rows'))).toHaveLength(0);
});


it('reads qualified configured ACP facts for a Session declaring the bare Agent id', async () => {
  const serverId = await homes.addHome({ name: 'ACP', serverUrl: 'https://acp-status.test', accountId: 'alice', currentAccount: true });
  const machineId = 'acp-machine';
  const definitionId = 'qa-foldseed-acp';
  const session = createSessionFixture({ id: 'acp-status', encryptionMode: 'plain', access: createSessionAccessFixture('owner'),
    metadata: { ...createSessionFixture().metadata, machineId,
      runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: { definitionId } },
      acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: definitionId, title: 'Foldseed' } } });
  homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
  const key = serverAccountScopedResourceKey({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice' }, 'machine-agents', machineId);
  machineAgentInventoryStore.publish(key, { status: 'ready', lastCheckedAt: 1, items: [{
    agentId: 'happier.agent.custom-acp/custom-acp', definitionId, title: 'Foldseed', installed: true,
    version: null, latestVersion: null, update: { supported: false, command: null },
    signIn: { status: 'unknown', loginSupport: 'unsupported' }, platform: { supported: true }, dependencies: [],
    install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null },
  }] });
  const result = await createDefaultActionExecutor().execute('session.status.get', { sessionId: session.id, readiness: true },
    { surface: 'ui', serverId, expectedAccountId: 'alice' });
  expect(result).toMatchObject({ ok: true, result: { readiness: { agent: { agentId: 'happier.agent.custom-acp/custom-acp', definitionId } } } });
});
