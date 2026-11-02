import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

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
