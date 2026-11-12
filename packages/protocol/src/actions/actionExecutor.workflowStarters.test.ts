import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { getWorkflowStarterExamplesV1 } from '../workflows/builtins/examples.js';
import { WorkflowStarterExampleV1Schema, WorkflowStartersResolveResultV1Schema } from '../workflows/builtins/starterActionsV1.js';
import { MachineServiceExecInputV1Schema } from '../local/services/serviceExecV1.js';
import { createWorkflowActionExecutor } from './executor/workflowAccountActions.js';
import { createWorkflowDefinitionActions, type WorkflowDefinitionArtifactOperations } from './executor/workflowDefinitions.js';
import { WorkflowDefinitionGetResultV1Schema } from '../workflows/actionsV1.js';
function readyExample(result: unknown) {
  const resolved = WorkflowStartersResolveResultV1Schema.parse(result);
  if (resolved.status !== 'ready') throw new Error('The starter must resolve');
  return resolved.example;
}

const listActionId = 'workflow.starters.list';
const resolveActionId = 'workflow.starters.resolve';

describe('workflow authoring starters through Actions', () => {
  it('offers a Session-free restore drill that retains its chosen Environment and cleans up on failure', async () => {
    const executor = createActionExecutor({});
    const resolved = await executor.execute(resolveActionId, { key: 'restore-drill' }, { surface: 'cli' });
    expect(resolved).toMatchObject({ ok: true, result: { status: 'ready', example: { key: 'restore-drill' } } });
    if (!resolved.ok) throw new Error('The persistent drill must be discoverable');
    const example = readyExample(resolved.result);
    expect(example).not.toHaveProperty('sessionTarget');
    expect(example.definition.blocks.at(-1)).toMatchObject({ kind: 'loop', runWhen: 'always',
      body: [{ kind: 'action', actionId: 'machines.services.control', input: { operation: { kind: 'literal', value: 'stop' } } }] });
    expect(example.definition.inputs.map(field => field.name)).toEqual(expect.arrayContaining([
      'backupTarget', 'restoreSource', 'drillTarget', 'restoreDestination', 'verificationLevel', 'dataCheck',
    ]));
  });
  it('opens Restart when needed as an unsaved schedule using Setup facts and the ordinary reboot Action', async () => {
    const executor = createActionExecutor({});
    const listed = await executor.execute(listActionId, {}, { surface: 'agent' });
    expect(listed).toMatchObject({ ok: true, result: { examples: expect.arrayContaining([
      expect.objectContaining({ key: 'restart-when-needed' }),
    ]) } });
    const resolved = await executor.execute(resolveActionId, { key: 'restart-when-needed' }, { surface: 'ui' });
    expect(resolved).toMatchObject({ ok: true, result: { status: 'ready' } });
    if (!resolved.ok) throw new Error('Restart starter must resolve');
    const example = readyExample(resolved.result);
    expect(example.trigger).toMatchObject({ kind: 'schedule', enabled: false });
    expect(example.definition.blocks).toMatchObject([
      { kind: 'action', id: 'check', actionId: 'machines.setup.plan', input: {
        homeId: { kind: 'input', name: 'serverId' }, machineId: { kind: 'input', name: 'machineId' },
        mode: { kind: 'literal', value: 'check' }, updates: { kind: 'literal', value: { scope: 'all' } },
      } },
      { kind: 'action', actionId: 'machines.reboot', onlyWhen: {
        kind: 'compare', operator: 'eq', left: { kind: 'result', producer: { blockId: 'check', scope: { kind: 'current' } },
          path: ['updates', 'observation', 'rebootNeeded'] }, right: { kind: 'literal', value: true },
      }, input: { expectedInstallationId: { kind: 'input', name: 'expectedInstallationId' } } },
    ]);
    expect(example).not.toHaveProperty('sessionTarget');
  });

  it.each(['backup-verify', 'nightly-backups', 'restore-drill', 'daily-health-digest'])('resolves %s without a Session through the public starter Actions', async (key) => {
    let stored: Awaited<ReturnType<WorkflowDefinitionArtifactOperations['read']>> = null;
    const unused = (): never => { throw new Error('authoring_starts_no_run_or_trigger'); };
    // Artifact persistence is the system boundary; catalog resolution, semantic
    // admission, serialization and the create/read Action path remain real.
    const definitions = createWorkflowDefinitionActions({ artifactStore: {
      read: async id => stored?.artifactId === id ? stored : null,
      create: async input => {
        stored = { artifactId: input.artifactId, header: input.header, body: input.body,
          revision: { headerVersion: 1, bodyVersion: 1 }, ownerAccountId: 'account', access: 'owner' };
      },
      list: unused, update: unused, delete: unused,
    }, encodeListCursor: unused });
    const executor = createActionExecutor({ workflowAction: createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: () => true, definitions, runs: { execute: unused },
    }) });
    const context = { surface: 'cli' as const };
    expect(await executor.execute(listActionId, {}, context)).toMatchObject({ ok: true, result: {
      examples: expect.arrayContaining([expect.objectContaining({ key })]),
    } });
    const resolved = await executor.execute(resolveActionId, { key }, context);
    expect(resolved).toMatchObject({ ok: true, result: { status: 'ready', example: { key } } });
    if (!resolved.ok || !resolved.result || typeof resolved.result !== 'object' || !('example' in resolved.result)) {
      throw new Error('The backup starter must resolve through the real catalog');
    }
    const example = readyExample(resolved.result);
    if (key === 'daily-health-digest') {
      expect(example.definition.blocks[0]).toMatchObject({ kind: 'parallel', failurePolicy: 'collect_outcomes', branches: [
        { blocks: [{ kind: 'action', actionId: 'projects.readiness.read' }] },
        { blocks: [{ kind: 'loop', repetition: { kind: 'items', items: { kind: 'input', name: 'backupAutomationIds' } },
          body: [{ kind: 'action', actionId: 'workflow.trigger.list', input: {
            automationId: { kind: 'item', field: 'value' }, review: { kind: 'literal', value: true },
          } }] }] },
        { blocks: [{ kind: 'action', actionId: 'workflow.run.summaries', input: {
          automationIds: { kind: 'input', name: 'backupAutomationIds' },
        } }] },
      ] });
      expect(example.definition.inputs.map(input => input.name)).toEqual(['readinessScope', 'backupAutomationIds']);
    } else if (key === 'restore-drill') expect(example.definition.blocks[0]).toMatchObject({ kind: 'parallel',
      failurePolicy: 'collect_outcomes' });
    else expect(example.definition.blocks[0]).toMatchObject({ kind: 'action',
      actionId: key === 'backup-verify' ? 'deployments.backups.verify' : 'deployments.environments.get' });
    if (key === 'nightly-backups') {
      expect(example.definition.blocks).toMatchObject([
        { kind: 'action', id: 'current', actionId: 'deployments.environments.get', input: {
          serverId: { kind: 'input', name: 'backupEnvironment', path: ['serverId'] },
          environmentId: { kind: 'input', name: 'backupEnvironment', path: ['environmentId'] },
          backupPolicy: { kind: 'input', name: 'backupPolicy' },
        } },
        { kind: 'action', id: 'backup', actionId: 'deployments.backups.run', input: {
          environmentId: { kind: 'result', producer: { blockId: 'current', scope: { kind: 'current' } }, path: ['backupTarget', 'environmentId'] },
        } },
        { kind: 'loop', repetition: { kind: 'items', execution: 'sequential', failurePolicy: 'fail_stop',
          items: { kind: 'result', producer: { blockId: 'backup', scope: { kind: 'current' } }, path: ['manifests'] } },
          body: [{ kind: 'action', actionId: 'deployments.backups.verify', input: {
            environmentId: { kind: 'result', producer: { blockId: 'current', scope: { kind: 'outer', levels: 1 } }, path: ['backupTarget', 'environmentId'] },
            backupOperationId: { kind: 'result', producer: { blockId: 'backup', scope: { kind: 'outer', levels: 1 } }, path: ['operationId'] },
            snapshotId: { kind: 'item', field: 'value', path: ['snapshot', 'snapshotId'] },
          } }] },
        { kind: 'action', actionId: 'deployments.backups.prune', input: { retention: { kind: 'input', name: 'backupPolicy', path: ['retention'] } } },
      ]);
      expect(example.definition.inputs).toEqual([
        { name: 'backupEnvironment', valueType: 'json', required: true },
        { name: 'backupPolicy', valueType: 'json', required: true },
        { name: 'verificationLevel', valueType: 'string', required: true },
      ]);
    }
    expect(example).not.toHaveProperty('sessionTarget');
    expect(example).not.toHaveProperty('triggerSeed');
    const definitionId = '11111111-1111-4111-8111-111111111111';
    expect(await executor.execute('workflow.definition.create', { definitionId,
      definition: example.definition, metadata: { title: key } }, context))
      .toMatchObject({ ok: true, result: { definitionId } });
    const read = await executor.execute('workflow.definition.get', { definitionId }, context);
    expect(read).toMatchObject({ ok: true });
    if (!read.ok) throw new Error('The saved starter must be readable');
    expect(WorkflowDefinitionGetResultV1Schema.parse(read.result).definition.blocks)
      .toMatchObject(example.definition.blocks);
  });

  it('lists supported Ops starters and resolves drift as an unsaved read-only Action', async () => {
    const executor = createActionExecutor({});
    const context = { surface: 'cli' as const };
    const listed = await executor.execute(listActionId, {}, context);
    expect(listed).toMatchObject({ ok: true, result: { examples: expect.arrayContaining([
      expect.objectContaining({ key: 'check-for-drift' }),
      expect.objectContaining({ key: 'run-a-job-on-a-schedule' }),
    ]) } });
    const resolved = await executor.execute(resolveActionId, { key: 'check-for-drift' }, context);
    expect(resolved).toMatchObject({ ok: true, result: { status: 'ready', example: {
      key: 'check-for-drift', definition: { blocks: [{ kind: 'action', actionId: 'deployments.drift.read',
        input: { expectedRevision: { kind: 'input', name: 'expectedRevision' }, service: { kind: 'input', name: 'service' } } }] },
    } } });
    expect(resolved).not.toHaveProperty('result.example.trigger');
    expect(resolved).not.toHaveProperty('result.example.triggerSeed');
    expect(resolved).not.toHaveProperty('result.example.sessionTarget');
    const job = await executor.execute(resolveActionId, { key: 'run-a-job-on-a-schedule' }, context);
    expect(job).toMatchObject({ ok: true, result: { status: 'ready' } });
    if (!job.ok || !job.result || typeof job.result !== 'object' || !('example' in job.result)) {
      throw new Error('The service job starter must resolve');
    }
    const example = readyExample(job.result);
    const block = example.definition.blocks[0];
    if (block?.kind !== 'action' || block.input.argv?.kind !== 'literal' || block.input.mode?.kind !== 'literal') {
      throw new Error('The service job must retain an editable literal command and mode');
    }
    expect(block.actionId).toBe('machines.services.exec');
    const selected = { serverId: 'home', machineId: 'machine',
      target: { kind: 'current', serviceId: 'web', expectedGeneration: 'generation' } };
    expect(MachineServiceExecInputV1Schema.parse({ ...selected, argv: block.input.argv.value, mode: block.input.mode.value }))
      .toMatchObject({ ...selected, argv: expect.any(Array), mode: 'exec' });
    // A schedule on an Action-only starter needs no Session; it stays off until its inputs have values.
    expect(job).toMatchObject({ result: { example: { trigger: { kind: 'schedule', enabled: false } } } });
    expect(job).not.toHaveProperty('result.example.triggerSeed');
  });

  it('lists the unsaved catalog and resolves a schedule only with an explicit Session and timezone', async () => {
    const executor = createActionExecutor({});
    const context = { surface: 'mcp' as const };
    const catalog = getWorkflowStarterExamplesV1();
    const before = structuredClone(catalog);
    expect(await executor.execute(listActionId, {}, context)).toEqual({ ok: true, result: { examples: catalog.map(example => WorkflowStarterExampleV1Schema.parse(example)) } });
    expect(await executor.execute(resolveActionId, { key: 'daily-summary-in-session' }, context))
      .toEqual({ ok: true, result: { status: 'requires_session' } });
    const session = { sessionId: 'chosen-session', machineId: 'chosen-machine' };
    const resolved = await executor.execute(resolveActionId, { key: 'daily-summary-in-session', session, timezone: 'Europe/Zurich' }, context);
    expect(resolved).toMatchObject({ ok: true, result: { status: 'ready', example: {
      sessionTarget: session,
      trigger: { kind: 'schedule', schedule: { timezone: 'Europe/Zurich' } },
      definition: { defaults: { conversation: { kind: 'existing_session', ...session } },
        blocks: [{ execution: { conversation: { kind: 'existing_session', ...session } } }] },
    } } });
    expect(catalog).toEqual(before);
  });

  it('keeps ordinary starters usable without a Session and binds lifecycle seeds to the selected Session', async () => {
    const executor = createActionExecutor({});
    const context = { surface: 'cli' as const };
    const example = getWorkflowStarterExamplesV1().find(entry => entry.key === 'ask-once');
    expect(await executor.execute(resolveActionId, { key: 'ask-once' }, context))
      .toEqual({ ok: true, result: { status: 'ready', example: WorkflowStarterExampleV1Schema.parse(example) } });
    const session = { sessionId: 'selected', machineId: 'machine' };
    expect(await executor.execute(resolveActionId, { key: 'notify-when-agent-waits', session }, context))
      .toMatchObject({ ok: true, result: { status: 'ready', example: {
        sessionTarget: session, trigger: { kind: 'sessionLifecycle', sourceSessionId: 'selected', events: ['userActionRequired'] },
      } } });
    expect(await executor.execute(resolveActionId, { key: 'daily-summary-in-session', session, timezone: null }, context))
      .toMatchObject({ ok: true, result: { status: 'ready', example: { trigger: { schedule: { timezone: null } } } } });
  });

  it('rejects unsupported keys and unknown target fields without inventing a runtime workflow reference', async () => {
    const executor = createActionExecutor({});
    const context = { surface: 'agent' as const };
    expect(await executor.execute(resolveActionId, { key: 'missing' }, context)).toMatchObject({ ok: false });
    expect(await executor.execute(resolveActionId, {
      key: 'ask-once', session: { sessionId: 'selected', machineId: 'machine', originSessionId: 'guessed' },
    }, context)).toMatchObject({ ok: false });
  });

  it('resolves deployment as an unsaved deterministic Action, never an enabled repository trigger', async () => {
    const executor = createActionExecutor({});
    const resolved = await executor.execute(resolveActionId, { key: 'deploy-on-push' }, { surface: 'cli' });
    expect(resolved).toMatchObject({ ok: true, result: { status: 'ready', example: {
      key: 'deploy-on-push', definition: { blocks: [{ kind: 'action', actionId: 'deployments.deploy',
        input: { sha: { kind: 'input', name: 'sha' }, requestKey: { kind: 'input', name: 'requestKey' },
          whenBusy: { kind: 'literal', value: 'supersede' } } }] },
    } } });
    if (!resolved.ok) throw new Error('The canonical starter must be available');
    const result = resolved.result;
    expect(result).not.toHaveProperty('example.trigger');
    expect(result).not.toHaveProperty('example.triggerSeed');
    expect(result).not.toHaveProperty('example.sessionTarget');
    expect(result).toHaveProperty('example.definition.blocks.length', 1);
  });
});
