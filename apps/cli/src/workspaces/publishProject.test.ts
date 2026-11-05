import { describe, expect, it, vi } from 'vitest';
import { MachineSetupApplyInputV1Schema, deriveWorkflowReplacementId, getActionSpec, type MachineSetupApplyTargetV1 } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { buildPublishWorkflow, createPublishProjectActionDeps, type PublishWorkflowInvocationRead,
  type PublishWorkflowStart } from './publishProject';
import { createPreparedPublishTestFixture, createPublishWorkflowRecoveryFixture } from './publishProject.testkit';

describe('Publish admission ownership', () => {
  it('refuses preparation without the canonical deployment preparation owner', async () => {
    const { input } = createPreparedPublishTestFixture();
    let presenceReads = 0;
    const host = {
      readHostFacts: async () => {
        presenceReads += 1;
        return { machines: [{ machineId: 'parent-host', online: true }] };
      },
      orchestrationDirectory: '/publish',
      startCombined: async () => { throw new Error('preparation_must_not_start_children'); },
      waitForRun: async () => { throw new Error('preparation_must_not_wait_for_children'); },
      readInvocations: async () => { throw new Error('preparation_must_not_read_run_content'); },
    };
    const deps = createPublishProjectActionDeps(host);
    const prepared = await deps.prepareDeploymentPublish!({ input, context: {} });

    expect(prepared).toMatchObject({ ok: false, errorCode: 'deployment_unavailable' });
    expect(presenceReads).toBe(0);
  });

  it.each(['failed', 'cancelled', 'interrupted', 'succeeded'] as const)(
    'exposes retained child operations from the real Run owner after %s', async state => {
      const { input } = createPreparedPublishTestFixture();
      const runId = deriveWorkflowReplacementId(['deployments.publish', input.serverId, 'deployment-account', input.requestKey]);
      const fixture = await createPublishWorkflowRecoveryFixture(input, runId, state);
      const fixtureDetailReads = fixture.storage.calls.filter(call => call.operation === 'invocations.get').length;
      const host = {
        prepareDeploymentAction: async () => { throw new Error('execution_must_not_prepare_deployment'); },
        readHostFacts: async () => { throw new Error('execution_must_use_admitted_host'); },
        orchestrationDirectory: '/publish',
        startCombined: fixture.reader.startCombined,
        waitForRun: () => fixture.reader.execute({ actionId: 'workflow.run.wait',
          input: { runId, conditions: ['terminal'] }, context: fixture.context }),
        readInvocations: (_request: PublishWorkflowStart, input: PublishWorkflowInvocationRead) =>
          fixture.reader.execute({ actionId: 'workflow.run.invocations.list', input, context: fixture.context }),
      };
      const deps = createPublishProjectActionDeps(host);
      const result = await deps.deploymentPublish!(input, fixture.context);
      const expected = { childOperationRefs: [fixture.operationRef], operationRef: {
        serverId: input.serverId, machineId: input.hostMachineId, operationId: 'publish-operation',
      } };

      if (state === 'interrupted') {
        expect(fixture.rootIds).toHaveLength(2);
        expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ ok: false, errorCode: 'outcome_uncertain', details: expected });
      } else {
        expect(result).toMatchObject({ ...expected, kind: state === 'succeeded' ? 'started' : 'partial',
          ...(state === 'succeeded' ? {} : { reason: state === 'cancelled' ? 'cancelled' : 'child_failed' }) });
      }
      expect(fixture.storage.calls.filter(call => call.operation === 'invocations.list'))
        .toEqual(expect.arrayContaining([expect.objectContaining({ parentRecordIds: fixture.rootIds, progressEnvelopes: true })]));
      expect(fixture.storage.calls.filter(call => call.operation === 'invocations.get')).toHaveLength(fixtureDetailReads);
    });

  it.each(['nonterminal', 'refused', 'thrown', 'typed refusal', 'content unavailable'] as const)(
    'keeps Publish nonterminal with child recovery after a %s observation', async observation => {
      const { input } = createPreparedPublishTestFixture();
      const runId = deriveWorkflowReplacementId(['deployments.publish', input.serverId, 'deployment-account', input.requestKey]);
      const fixture = await createPublishWorkflowRecoveryFixture(input, runId, 'running');
      const execute = fixture.storage.execute;
      // Only Home storage/transport is replaced; Run readers and Action settlement remain real.
      const boundary = vi.spyOn(fixture.storage, 'execute').mockImplementation(async (request, options) => {
        if (request.operation === 'wait' && (observation === 'refused' || observation === 'thrown'))
          throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET',
            ...(observation === 'refused' ? { response: { status: 403, data: { error: 'run_access_denied' } } } : {}) });
        if (observation === 'content unavailable' && request.operation === 'invocations.list' && request.parentRecordIds)
          throw Object.assign(new Error('run_access_denied'), { response: { status: 403, data: { error: 'run_access_denied' } } });
        return execute(request, options);
      });
      const store = createActionOperationStore();
      const spec = getActionSpec('deployments.publish');
      const scope = { accountId: 'deployment-account', machineId: input.hostMachineId! };
      const runner = createActionOperationRunner({ store, generateOperationId: () => 'publish-operation',
        resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
      const deps = createPublishProjectActionDeps({
        readHostFacts: async () => { throw new Error('execution_must_use_admitted_host'); },
        orchestrationDirectory: '/publish', startCombined: fixture.reader.startCombined,
        waitForRun: () => observation === 'typed refusal'
          ? Promise.resolve({ ok: false, errorCode: 'run_access_denied', error: 'run_access_denied' })
          : fixture.reader.execute({ actionId: 'workflow.run.wait',
            input: { runId, conditions: ['terminal'] }, context: fixture.context }),
        readInvocations: (_request, input) => fixture.reader.execute({ actionId: 'workflow.run.invocations.list', input,
          context: fixture.context }),
      });
      try {
        const result = await runner.observe({ actionId: spec.id, scope, requestId: input.requestKey,
          execute: async () => ActionExecuteFailureSchema.parse(await deps.deploymentPublish!(input, fixture.context)) });
        expect(store.get(scope, 'publish-operation')).toMatchObject({ state: 'running',
          observation: { kind: 'outcome_uncertain' } });
        expect(result).toMatchObject({ ok: false, errorCode: 'outcome_uncertain', details: { runId,
          operationRef: { operationId: 'publish-operation' },
          childOperationRefs: observation === 'content unavailable' ? [] : [fixture.operationRef] } });
        if (observation === 'typed refusal') expect(result).toMatchObject({ details: {
          observationFailure: { ok: false, errorCode: 'run_access_denied' },
        } });
        expect(fixture.storage.run()).toMatchObject({ state: 'running' });
        boundary.mockRestore();
        const child = await fixture.reader.execute({ actionId: 'workflow.run.invocations.list',
          input: { runId, parentRecordIds: fixture.rootIds }, context: fixture.context });
        expect(child).toMatchObject({ invocations: expect.arrayContaining([
          expect.objectContaining({ parentRecordId: fixture.rootIds[0], lifecycle: 'running' }),
        ]) });
      } finally { boundary.mockRestore(); }
    });

  it('preserves already observed child operations if a later Run page becomes unavailable', async () => {
    const setup = MachineSetupApplyInputV1Schema.parse({ homeId: 'deployment-home', machineId: 'setup-host',
      targets: [setupTarget('setup-host')] });
    const { input } = createPreparedPublishTestFixture({ setup: [setup] });
    const runId = deriveWorkflowReplacementId(['deployments.publish', input.serverId, 'deployment-account', input.requestKey]);
    const fixture = await createPublishWorkflowRecoveryFixture(input, runId, 'failed');
    const execute = fixture.storage.execute;
    const unavailable = vi.spyOn(fixture.storage, 'execute').mockImplementation(async (request, options) => {
      if (request.operation === 'invocations.list' && request.parentRecordIds && request.cursor)
        throw Object.assign(new Error('run_access_denied'), { response: { status: 403, data: { error: 'run_access_denied' } } });
      return execute(request, options);
    });
    try {
      const deps = createPublishProjectActionDeps({
        prepareDeploymentAction: async () => { throw new Error('execution_must_not_prepare_deployment'); },
        readHostFacts: async () => { throw new Error('execution_must_use_admitted_host'); },
        orchestrationDirectory: '/publish', startCombined: fixture.reader.startCombined,
        waitForRun: () => fixture.reader.execute({ actionId: 'workflow.run.wait', input: { runId, conditions: ['terminal'] },
          context: fixture.context }),
        readInvocations: (_request, input) => fixture.reader.execute({ actionId: 'workflow.run.invocations.list', input,
          context: fixture.context }),
      });
      expect(await deps.deploymentPublish!(input, fixture.context)).toMatchObject({ ok: false, errorCode: 'run_access_denied',
        details: { childOperationRefs: [fixture.operationRefs[0]], operationRef: {
          serverId: input.serverId, machineId: input.hostMachineId, operationId: 'publish-operation',
        } } });
    } finally { unavailable.mockRestore(); }
  });
});

function setupTarget(machineId: string): MachineSetupApplyTargetV1 {
  return { homeId: 'deployment-home', machineId, desiredRevision: 0, recipePlans: [],
    sources: [{ kind: 'accountPreset', presetId: 'server-tools', presetRevision: 1,
      setup: { scripts: [{ body: 'echo setup', affects: 'none' }] } },
    { kind: 'direct', setup: {} }] };
}

describe('Publish app-free setup admission', () => {
  it.each(['preset', 'direct', 'appChildren'] as const)(
    'refuses %s apps in a later setup root and target before composing children', kind => {
      const fixture = createPreparedPublishTestFixture();
      const target = setupTarget('second-target');
      const app = { kind: 'app' as const, definition: { name: 'Separate app',
        project: { kind: 'existing' as const, projectSourceId: fixture.input.project.kind === 'existing'
          ? fixture.input.project.projectSourceId : 'source-app' },
        definition: { from: 'compose' as const, document: 'services:\n  app:\n    image: example/app:1\n',
          profiles: [], services: ['app'] }, bindings: [] } };
      if (kind === 'appChildren') {
        target.appChildren = [{ sourceIndex: 0, itemIndex: 0,
          actionId: 'deployments.deploy', input: fixture.input.preparedChildren.deploy }];
      } else {
        const sourceIndex = kind === 'preset' ? 0 : 1;
        const source = target.sources[sourceIndex];
        if (!source) throw new Error('setup_source_required');
        target.sources = target.sources.map((value, index) => index === sourceIndex
          ? { ...source, setup: { ...source.setup, items: [app] } } : value);
      }
      const setup = MachineSetupApplyInputV1Schema.parse({ homeId: target.homeId,
        machineId: 'setup-host', targets: [setupTarget('first-target'), target] });
      const input = createPreparedPublishTestFixture({ setup: [MachineSetupApplyInputV1Schema.parse({
        homeId: target.homeId, machineId: 'first-host', targets: [setupTarget('first-host')],
      }), setup] }).input;

      expect(() => buildPublishWorkflow(input)).toThrow(expect.objectContaining({ code: 'deployment_unavailable' }));
    });

  it('preserves reviewed app-free preset and direct setup before the app deployment', () => {
    const setup = MachineSetupApplyInputV1Schema.parse({ homeId: 'deployment-home', machineId: 'setup-host',
      targets: [setupTarget('first-target'), setupTarget('second-target')] });
    const { input } = createPreparedPublishTestFixture({ setup: [setup] });
    const workflow = buildPublishWorkflow(input);
    expect(workflow.blocks.map(block => block.kind === 'action' ? block.actionId : block.kind))
      .toEqual(['machines.setup.apply', 'deployments.deploy']);
    expect(workflow.blocks[0]).toMatchObject({ kind: 'action', input: {
      targets: { kind: 'literal', value: setup.targets },
    } });
  });
});
