import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionReadBatchRequestV1Schema, SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { UNSUPPORTED_AGENT_SESSION_CAPABILITIES } from '@happier-dev/agents';

const homes = createHomeGovernanceHarness();
const httpBoundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
installHomeGovernanceBoundaries(httpBoundary);
installDisconnectedServerSocketBoundary();
const { createVoiceToolHandlers } = await import('@/voice/tools/handlers');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { getStorage } = await import('@/sync/domains/state/storage');
const initial = getStorage().getState();
beforeEach(async () => { await homes.reset(); installHomeGovernanceBoundaries(httpBoundary); });
afterEach(() => { getStorage().setState(initial, true); standardCleanup(); });

it('keeps supported, native unsupported and unknown compact evidence distinct in the public status Action', async () => {
  const serverId = await homes.addHome({ name: 'Compact', serverUrl: 'https://compact-status.test', accountId: 'alice', currentAccount: true });
  for (const [id, publication, expected] of [
    ['supported', { sessionCapabilities: { ...UNSUPPORTED_AGENT_SESSION_CAPABILITIES, compaction: { events: true, manual: true } } }, 'supported'],
    ['unsupported', { sessionCapabilities: UNSUPPORTED_AGENT_SESSION_CAPABILITIES }, 'unsupported'],
    ['unknown', undefined, 'unknown'],
  ] as const) {
    const session = createSessionFixture({ id, encryptionMode: 'plain', access: createSessionAccessFixture('owner'),
      metadata: { ...createSessionFixture().metadata, flavor: 'external/agent',
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
  const context = { surface: 'agent' as const, serverId, expectedAccountId: 'alice', defaultSessionId: 'lead',
    sessionListAccess: 'led_subtree' as const, authority: 'account_automation' as const,
    actionCaller: { kind: 'session' as const, sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
    agentStartContext: { caller: { kind: 'session' as const, sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
      baseline: { machineId: 'machine', directory: '/repo' }, roles: {}, callerPermissionCeiling: 'default' as const,
      ledSubtreeSessionIds: [], workDepthLimit: 4 } };
  homes.answer(serverId, '/v2/sessions/read-batch', { select: input => {
    const demand = SessionReadBatchRequestV1Schema.parse(input);
    return { body: SessionReadBatchResponseV1Schema.parse({ results: [{ sessionId: session.id,
      detail: { status: 200, body: createPlainSessionByIdResponseFixture(session) },
      ...(demand.includeTurns !== false ? { turns: { status: 200, body: { v: 1, sessionId: session.id, updatedAt: 1, turns: [] } } } : {}),
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
  // Core currently fences scope at preparation and dispatch. Each consumes one
  // exact proof; collapsing those authority fences is separate owner work.
  expect(proofs).toEqual([expectedProof, expectedProof]);
  homes.answer(serverId, '/v2/sessions/read-batch', { body: { results: [{ sessionId: session.id,
    detail: { status: 404, body: { error: 'not_found' } } }] } });
  expect(await executor.execute('session.status.get', { sessionId: session.id }, context))
    .toMatchObject({ ok: false, details: { cause: 'target_outside_led_subtree' } });
  expect(homes.requests.filter(request => request.path === '/v2/sessions/read-batch')
    .map(request => SessionReadBatchRequestV1Schema.parse(request.input)).filter(demand => demand.underSessionId !== undefined))
    .toEqual([expectedProof, expectedProof, expectedProof]);
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
