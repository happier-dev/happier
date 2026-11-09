import { describe, expect, it, vi } from 'vitest';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createWorkflowDefinitionActions } from './workflowDefinitions';
import { createWorkflowActionExecutor } from './workflowActionExecutor';

const interchange = createWorkflowDefinitionActions({ artifactStore: createAccountArtifactStore({
  credentials: { token: 'workflow-fixture', encryption: null }, getAccountEncryptionMode: async () => 'plain',
}) });
const interchangePorts = { importDocument: interchange.importDocument, exportDocument: interchange.exportDocument };

const WORKFLOW_ACTION_IDS = [
  'workflow.validate',
  'workflow.run.start',
  'workflow.run.list',
  'workflow.run.get',
  'workflow.run.wait',
  'workflow.run.pause',
  'workflow.run.resume',
  'workflow.run.cancel',
  'workflow.run.invocations.list',
  'workflow.run.invocations.get',
  'workflow.run.invocations.retry',
  'workflow.run.delete',
  'workflow.definition.list',
  'workflow.definition.get',
  'workflow.definition.create',
  'workflow.definition.update',
  'workflow.definition.edit',
  'workflow.definition.delete',
] as const;

describe('workflow Action host', () => {
  const unavailable = { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' } as const;

  it('routes validation and definition operations through their canonical owners', async () => {
    const definition = {
      version: 1 as const,
      defaults: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.test', localId: 'test' } } },
      blocks: ['Review this'],
    };
    const list = vi.fn(async () => ({ definitions: [] }));
    const execute = createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: async () => true,
      definitions: { ...interchangePorts, list, get: vi.fn(), create: vi.fn(), update: vi.fn(), edit: vi.fn(), delete: vi.fn() },
      runs: { execute: vi.fn() },
    });

    await expect(execute({ actionId: 'workflow.validate', input: { definition }, context: {} }))
      .resolves.toMatchObject({ valid: true, normalizedDefinition: { blocks: [{ kind: 'step' }] } });
    await expect(execute({ actionId: 'workflow.definition.list', input: {}, context: {} }))
      .resolves.toEqual({ definitions: [] });
    expect(list).toHaveBeenCalledOnce();
  });

  it('does not claim target validation when the host has no target diagnostics owner', async () => {
    const execute = createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: async () => true,
      definitions: { ...interchangePorts, list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), edit: vi.fn(), delete: vi.fn() },
      runs: { execute: vi.fn() },
    });

    await expect(execute({
      actionId: 'workflow.validate',
      input: {
        definition: { blocks: ['Summarize'] },
        target: { machineId: 'machine-1' },
      },
      context: {},
    })).resolves.toMatchObject({ targetValidation: 'unavailable' });
  });

  it('delegates every Run operation to one Run owner without a second dispatcher', async () => {
    const runExecute = vi.fn(async () => unavailable);
    const execute = createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: async () => true,
      definitions: { ...interchangePorts, list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), edit: vi.fn(), delete: vi.fn() },
      runs: { execute: runExecute },
    });
    await expect(execute({
      actionId: 'workflow.run.get', input: { runId: '550e8400-e29b-41d4-a716-446655440000' }, context: {},
    })).resolves.toEqual(unavailable);
    expect(runExecute).toHaveBeenCalledOnce();
  });

  it('delegates an exact-Run list selection to the one Run owner without a detail read', async () => {
    const runExecute = vi.fn(async (_args: Readonly<{ actionId: string }>) => unavailable);
    const execute = createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: async () => true,
      definitions: { ...interchangePorts, list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), edit: vi.fn(), delete: vi.fn() },
      runs: { execute: runExecute },
    });
    // The lean background-refresh selection travels inside the existing
    // list input. The executor must parse it (not reject it as unknown)
    // and hand it to the Run owner untouched.
    await expect(execute({
      actionId: 'workflow.run.list',
      input: { runId: '550e8400-e29b-41d4-a716-446655440000', limit: 1 },
      context: {},
    })).resolves.toEqual(unavailable);
    expect(runExecute).toHaveBeenCalledOnce();
    expect(runExecute.mock.calls[0]?.[0]).toMatchObject({
      actionId: 'workflow.run.list',
      input: { runId: '550e8400-e29b-41d4-a716-446655440000', limit: 1 },
    });
  });

  it('covers the complete catalog through one workflow-family executor', async () => {
    const called = new Set<string>();
    const definitions = { ...interchangePorts,
      list: vi.fn(async () => { called.add('workflow.definition.list'); return unavailable; }),
      get: vi.fn(async () => { called.add('workflow.definition.get'); return unavailable; }),
      create: vi.fn(async () => { called.add('workflow.definition.create'); return unavailable; }),
      update: vi.fn(async () => { called.add('workflow.definition.update'); return unavailable; }),
      edit: vi.fn(async () => { called.add('workflow.definition.edit'); return unavailable; }),
      delete: vi.fn(async () => { called.add('workflow.definition.delete'); return unavailable; }),
    };
    const execute = createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: async () => true,
      definitions,
      runs: { execute: vi.fn(async ({ actionId }) => { called.add(actionId); return unavailable; }) },
    });
    const validInputs = {
      'workflow.run.start': { runId: '550e8400-e29b-41d4-a716-446655440000', source: { kind: 'inline', definition: { defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks: ['work'] } } },
      'workflow.run.list': {},
      'workflow.run.get': { runId: '550e8400-e29b-41d4-a716-446655440000' },
      'workflow.run.wait': { runId: '550e8400-e29b-41d4-a716-446655440000' },
      'workflow.run.pause': { runId: '550e8400-e29b-41d4-a716-446655440000', expectedRevision: 1 },
      'workflow.run.resume': { mode: 'boundary', runId: '550e8400-e29b-41d4-a716-446655440000', expectedRevision: 1 },
      'workflow.run.cancel': { runId: '550e8400-e29b-41d4-a716-446655440000', expectedRevision: 1 },
      'workflow.run.invocations.list': { runId: '550e8400-e29b-41d4-a716-446655440000' },
      'workflow.run.invocations.get': { runId: '550e8400-e29b-41d4-a716-446655440000', invocationId: 'invocation-1' },
      'workflow.run.invocations.retry': { runId: '550e8400-e29b-41d4-a716-446655440000', expectedRevision: 1, invocation: { recordId: 'invocation-1' }, causalInvocationIds: ['invocation-1'], conversation: 'same_conversation', input: { kind: 'original' } },
      'workflow.run.delete': { runId: '550e8400-e29b-41d4-a716-446655440000', expectedRevision: 1 },
      'workflow.definition.list': {},
      'workflow.definition.get': { definitionId: 'definition-1' },
      'workflow.definition.create': { definitionId: '11111111-1111-4111-8111-111111111111', definition: { defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks: ['work'] }, metadata: { title: 'Work' } },
      'workflow.definition.update': { definitionId: 'definition-1', expectedRevision: { headerVersion: 1, bodyVersion: 1 }, definition: { defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks: ['work'] }, metadata: { title: 'Work' } },
      'workflow.definition.edit': { definitionId: 'definition-1', expectedRevision: { headerVersion: 1, bodyVersion: 1 }, ops: [{ kind: 'rename', name: 'Changed' }] },
      'workflow.definition.delete': { definitionId: 'definition-1' },
    } as const;
    for (const actionId of WORKFLOW_ACTION_IDS) {
      if (actionId === 'workflow.validate') continue;
      await execute({ actionId, input: validInputs[actionId], context: {} } as never);
    }
    expect([...called].sort()).toEqual(WORKFLOW_ACTION_IDS.filter((id) => id !== 'workflow.validate').sort());
  });

  it('fails the whole family closed before parsing or invoking an owner', async () => {
    const definitions = { ...interchangePorts,
      list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), edit: vi.fn(), delete: vi.fn(),
    };
    const runs = { execute: vi.fn() };
    const execute = createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: async () => false,
      definitions,
      runs,
    });

    await expect(execute({ actionId: 'workflow.run.start', input: null as never, context: {} }))
      .resolves.toEqual({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' });
    expect(runs.execute).not.toHaveBeenCalled();
    expect(Object.values(definitions).every((owner) => !vi.isMockFunction(owner) || owner.mock.calls.length === 0)).toBe(true);
  });

  it('resolves one trusted ingress context for validate, inline start, create, and update', async () => {
    const ingress = {
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      machineId: 'machine-1',
    };
    const resolveIngressContext = vi.fn(async () => ingress);
    const create = vi.fn(async () => unavailable);
    const update = vi.fn(async () => unavailable);
    const runExecute = vi.fn(async () => unavailable);
    const execute = createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: async () => true,
      resolveIngressContext,
      definitions: { ...interchangePorts, list: vi.fn(), get: vi.fn(), create, update, edit: vi.fn(), delete: vi.fn() },
      runs: { execute: runExecute },
    });
    const promptOnly = { blocks: ['Work'] };

    await expect(execute({ actionId: 'workflow.validate', input: { definition: promptOnly }, context: { defaultSessionId: 'session-1' } }))
      .resolves.toMatchObject({ valid: true, normalizedDefinition: { defaults: { agentTarget: ingress.agentTarget } } });
    await execute({ actionId: 'workflow.run.start', input: { runId: '550e8400-e29b-41d4-a716-446655440000', source: { kind: 'inline', definition: promptOnly } }, context: { defaultSessionId: 'session-1' } });
    await execute({ actionId: 'workflow.definition.create', input: { definitionId: '11111111-1111-4111-8111-111111111111', definition: promptOnly, metadata: { title: 'One' } }, context: { defaultSessionId: 'session-1' } });
    await execute({ actionId: 'workflow.definition.update', input: { definitionId: 'definition-1', expectedRevision: { headerVersion: 1, bodyVersion: 1 }, definition: promptOnly, metadata: { title: 'Two' } }, context: { defaultSessionId: 'session-1' } });

    expect(resolveIngressContext).toHaveBeenCalledTimes(4);
    expect(runExecute).toHaveBeenCalledWith(expect.anything(), ingress);
    expect(create).toHaveBeenCalledWith(expect.anything(), ingress, { defaultSessionId: 'session-1', callerPermissionMode: 'yolo' });
    expect(update).toHaveBeenCalledWith(expect.anything(), ingress, { defaultSessionId: 'session-1', callerPermissionMode: 'yolo' });
  });

  it('delegates every Session-bound and unbound wait to the Run owner, which alone enforces the caller lifetime', async () => {
    const runs = { execute: vi.fn(async () => unavailable) };
    const execute = createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: async () => true,
      definitions: { ...interchangePorts, list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), edit: vi.fn(), delete: vi.fn() },
      runs,
    });
    const input = { runId: '550e8400-e29b-41d4-a716-446655440000' } as const;

    for (const surface of ['agent', 'mcp'] as const) {
      await execute({ actionId: 'workflow.run.wait', input, context: { surface, defaultSessionId: 'session-1' } });
    }
    await execute({ actionId: 'workflow.run.wait', input, context: { surface: 'cli' } });
    await execute({ actionId: 'workflow.run.wait', input, context: { surface: 'agent' } });
    expect(runs.execute).toHaveBeenCalledTimes(4);
  });

  it('delegates requested target validation to the host availability owner', async () => {
    const resolveTargetValidation = vi.fn(async () => ({
      targetValidation: 'checked' as const,
      targetIssues: [],
    }));
    const execute = createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: async () => true,
      resolveTargetValidation,
      definitions: { ...interchangePorts, list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), edit: vi.fn(), delete: vi.fn() },
      runs: { execute: vi.fn() },
    });

    await expect(execute({
      actionId: 'workflow.validate',
      input: { definition: { defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks: ['Summarize'] }, target: { machineId: 'machine-1' } },
      context: {},
    })).resolves.toMatchObject({ targetValidation: 'checked' });
    expect(resolveTargetValidation).toHaveBeenCalledOnce();
  });
});
