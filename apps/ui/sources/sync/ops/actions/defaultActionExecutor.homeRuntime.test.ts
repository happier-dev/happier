import { parseCapabilitiesDetectResponse } from '@happier-dev/protocol/capabilities';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { SystemTaskResultSchema } from '@happier-dev/protocol/system/tasks/spec';
import { parseToken } from '@/utils/auth/parseToken';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

let answerRpc: Parameters<typeof installSessionActionRpcBoundary>[0] = () => { throw new Error('Unexpected daemon request'); };
const transportContexts: Parameters<Parameters<typeof installSessionActionRpcBoundary>[0]>[1][] = [];
const requests = installSessionActionRpcBoundary((request, context) => {
  transportContexts.push(context);
  return answerRpc(request, context);
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

describe('UI connected Machine Home restart Action', () => {
  beforeEach(async () => {
    await harness.reset();
    requests.length = 0;
    transportContexts.length = 0;
    answerRpc = () => { throw new Error('Unexpected daemon request'); };
  });
  afterEach(() => standardCleanup());

  it.each([
    [{ enabled: true }, 'ready'],
    [{ enabled: false, reason: 'indexing' }, 'indexing'],
    [{ enabled: false, reason: 'index_unavailable' }, 'unavailable'],
    [undefined, 'unknown'],
  ] as const)('reads search readiness from the addressed Home feature owner (%s)', async (homeSearch, searchReadiness) => {
    const serverId = await harness.addHome({ name: 'Search Home', serverUrl: 'https://readiness.test', accountId: 'alice' });
    harness.answer(serverId, '/v1/features', { body: createRootLayoutFeaturesResponse({ capabilities: {
      ...(homeSearch ? { homeSearch } : {}),
    } }) });
    expect(await createDefaultActionExecutor().execute('home.runtime.get', { force: true }, {
      surface: 'ui', serverId, expectedAccountId: 'alice',
    })).toMatchObject({ ok: true, result: { status: 'ready', searchReadiness } });
  });

  it('defers an automation restart to durable approval and never dispatches a rejected task', async () => {
    const serverId = await harness.addHome({ name: 'Approval Home', serverUrl: 'https://approval-restart.test', accountId: 'alice' });
    harness.answer(serverId, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, { body: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) });
    const result = await createDefaultActionExecutor().execute('home.runtime.restart', { machineId: 'machine' }, {
      surface: 'agent', authority: 'account_automation', serverId, expectedAccountId: 'alice', actionRequestId: 'restart-approval',
    });
    expect(result).toMatchObject({ ok: true });
    const created = ActionApprovalRequestCreatedResultSchema.parse(result.ok ? result.result : null);
    const artifacts = harness.artifacts(serverId);
    await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
    const artifactId = created.artifactId;
    expect(artifacts.list()[0]!.id).toBe(artifactId);
    const request = StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!));
    expect(request).toMatchObject({ status: 'open', actionId: 'home.runtime.restart',
      actionArgs: { machineId: 'machine' }, approval: { flow: 'deferred', result: 'required' } });
    expect(requests).toHaveLength(0);
    expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'reject' }, {
      surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'alice',
    })).toMatchObject({ ok: true });
    expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!)))
      .toMatchObject({ status: 'rejected', decision: { kind: 'reject' } });
    expect(requests).toHaveLength(0);
  });

  it('rebuilds the captured Personal Home index and refuses an unexpected success body', async () => {
    const serverId = await harness.addHome({ name: 'Index Home', serverUrl: 'https://index.test', accountId: 'alice' });
    harness.answer(serverId, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, { body: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) });
    harness.answer(serverId, '/v1/home/search/rebuild', { body: { ok: true } });
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'alice',
      presentUserConfirmation: { actionId: 'home.search.rebuild' as const } };
    expect(await createDefaultActionExecutor().execute('home.search.rebuild', {}, context))
      .toEqual({ ok: true, result: { ok: true } });
    harness.answer(serverId, '/v1/home/search/rebuild', { body: { ok: false } });
    expect(await createDefaultActionExecutor().execute('home.search.rebuild', {}, context)).toMatchObject({ ok: false });
  });

  it('keeps an admitted restart pending until its exact task terminates in the captured Home', async () => {
    const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://restart.test', accountId: 'alice' });
    harness.answer(serverId, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, { body: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) });
    harness.answer(serverId, '/v1/machines/machine', { body: { machine: createPlainMachineRowFixture({ id: 'machine', accountId: 'alice' }) } });
    const terminal = SystemTaskResultSchema.parse({ protocolVersion: 1, taskId: 'restart-task', ok: false, error: { code: 'restart_failed', message: 'Restart failed' } });
    let finish!: (value: unknown) => void;
    let admitted!: () => void;
    const admission = new Promise<void>(resolve => { admitted = resolve; });
    const task = new Promise<unknown>(resolve => { finish = resolve; });
    answerRpc = async ({ method, params }) => {
      if (method.endsWith(':capabilities.detect')) return parseCapabilitiesDetectResponse({ protocolVersion: 1, results: {
        'tool.systemTasks': { ok: true, checkedAt: 1, data: { available: true,
          kinds: ['relay.runtime.restart.v1'], methods: ['start', 'wait'] } },
      } });
      if ((params as { method?: string }).method === 'start') return { ok: true, result: { taskId: terminal.taskId } };
      return { ok: true, result: await task };
    };
    let settled = false;
    const signal = new AbortController().signal;
    const action = createDefaultActionExecutor().execute('home.runtime.restart', { machineId: 'machine', channel: 'preview' }, {
      surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'alice', signal,
      presentUserConfirmation: { actionId: 'home.runtime.restart' },
      operationAcceptance: { operationId: 'restart', accept: admitted },
    }).then(value => { settled = true; return value; });
    const initial = await Promise.race([admission.then(() => 'admitted' as const), action]);
    expect(initial).toBe('admitted');
    expect(settled).toBe(false);
    await harness.addHome({ name: 'Other', serverUrl: 'https://other.test', accountId: 'bob' });
    finish(terminal);
    expect(await action).toEqual({ ok: true, result: { status: 'completed', taskId: terminal.taskId, result: terminal } });
    expect(requests.map(request => request.method)).toEqual([
      'machine:capabilities.detect', 'machine:capabilities.invoke', 'machine:capabilities.invoke',
    ]);
    expect(transportContexts.map(context => context.serverUrl)).toEqual([
      'https://restart.test', 'https://restart.test', 'https://restart.test',
    ]);
    const machineReads = harness.requestsFor('/v1/machines/read-batch');
    expect(machineReads.length).toBeGreaterThan(0);
    for (const request of machineReads) {
      expect(request.serverId).toBe(serverId);
      expect(parseToken(request.token ?? '')).toBe('alice');
    }
    // Each serialized RPC retains the captured caller's cancellation custody at the SDK boundary.
    for (const context of transportContexts) expect(context.signal).toBeInstanceOf(AbortSignal);
  });
});
