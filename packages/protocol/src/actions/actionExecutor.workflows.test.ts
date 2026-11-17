import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { createWorkflowActionExecutor } from './executor/workflowAccountActions.js';
import { createWorkflowDefinitionActions } from './executor/workflowDefinitions.js';
import { createWorkflowAccountRunActionOwner } from './executor/workflowRunActions.js';
import { resolveWorkflowDefinitionRefV1 } from '../workflows/workflowDefinitionResolverV1.js';
import { getBuiltinWorkflowCatalogV1 } from '../workflows/builtins/catalog.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionExecuteFailureSchema } from './actionExecutionResult.js';
import { PLAN_WITH_A_PANEL_WORKFLOW_V1 } from '../workflows/builtins/planWithAPanel.js';
import { workflowDefinitionPreviewStepsV1 } from '../workflows/workflowStepLabel.js';

function workflowWithIngressBoundary(resolveIngressContext: NonNullable<Parameters<typeof createWorkflowActionExecutor>[0]['resolveIngressContext']>) {
  const unexpected = (): never => { throw new Error('unexpected_workflow_effect'); };
  const definitions = createWorkflowDefinitionActions({
    artifactStore: { list: unexpected, read: unexpected, create: unexpected, update: unexpected, delete: unexpected },
    encodeListCursor: row => row.artifactId, assertDefinitionWriteAllowed: unexpected,
  });
  return createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions, resolveIngressContext,
    runs: createWorkflowAccountRunActionOwner({ definitions, storage: { execute: unexpected },
      resolveAccountId: unexpected, resolveEncryption: unexpected, normalizeAbsolutePath: () => null, randomBytes: unexpected }),
  });
}

describe('createActionExecutor (Workflow family)', () => {
  it('returns declared Workflow input names so discovery can recover and resolve a real consuming field', async () => {
    const consumer = { kind: 'workflow', workflow: 'builtin:plan-with-a-panel' } as const;
    const targetKey = 'agent:example.agent/planner';
    // Only the installed Agent inventory is a host boundary. Built-in lookup,
    // consumer-field admission and options-source dispatch remain real.
    const executor = createActionExecutor({ agentsBackendsList: async () => ({
      items: [{ targetKey, title: 'Planner' }],
    }) } as unknown as ActionExecutorDeps);
    const context = { surface: 'agent', authority: 'account_automation' } as const;

    expect(getActionSpec('action.options.resolve').inputSchema.safeParse({ consumer }).success).toBe(false);
    const refused = ActionExecuteFailureSchema.parse(await executor.execute('action.options.resolve', {
      consumer, fieldPath: 'inputs',
    }, context));
    expect(refused).toMatchObject({ errorCode: 'input_type_consumer_unavailable', details: {
      fieldPath: 'inputs', availableFields: PLAN_WITH_A_PANEL_WORKFLOW_V1.inputs.map(input => input.name),
    } });
    const fields = (refused.details as { availableFields: string[] }).availableFields;
    const fieldPath = fields.find(name => name === 'engines');
    expect(fieldPath).toBeDefined();
    const request = getActionSpec('action.options.resolve').inputSchema.parse({ consumer, fieldPath });
    const result = await executor.execute('action.options.resolve', request, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.errorCode);
    expect(getActionSpec('action.options.resolve').outputSchema!.parse(result.result)).toMatchObject({ fieldPath: 'engines',
      optionsSourceId: 'execution.backends.enabled', options: [{ value: targetKey, label: 'Planner' }] });
    await expect(executor.execute('action.options.resolve', {
      consumer: { ...consumer, workflow: 'builtin:missing' }, fieldPath: 'inputs',
    }, context)).resolves.toEqual({ ok: false, errorCode: 'input_type_consumer_unavailable', error: 'input_type_consumer_unavailable' });
  });
  it('discovers builtins and every Account library page through the real workflow owner', async () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    // Only the Account Artifact transport is substituted; catalog, definition
    // filtering, paging and Action discovery stay real.
    const definitions = createWorkflowDefinitionActions({
      readPluginWorkflows: () => [{ workflow: 'plugin:example.recipe/check', pluginId: 'example.recipe',
        version: '1.2.3', title: 'Check changes', definition: getBuiltinWorkflowCatalogV1()[0]!.definition }],
      artifactStore: {
        list: async ({ cursor }) => {
          const index = cursor ? 1 : 0;
          return { items: [{ artifactId: ids[index]!, headerVersion: 1, bodyVersion: 1, updatedAt: 1,
            header: { kind: 'workflow-definition.v1', definitionId: ids[index],
              revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: index ? 'Shared recipe' : 'Own recipe' },
              previewSteps: workflowDefinitionPreviewStepsV1(getBuiltinWorkflowCatalogV1()[0]!.definition.blocks) },
            body: JSON.stringify({ kind: 'workflow-definition.v1', definition: getBuiltinWorkflowCatalogV1()[0]!.definition }),
            access: index ? 'view' : 'owner', ownerAccountId: index ? 'other-account' : 'account' }],
            ...(index ? {} : { nextCursor: ids[0] }) };
        },
        read: async () => { throw new Error('discovery_uses_listed_bodies'); },
        create: async () => { throw new Error('discovery_is_read_only'); },
        update: async () => { throw new Error('discovery_is_read_only'); },
        delete: async () => { throw new Error('discovery_is_read_only'); },
      },
      readWorkflowTriggerSummaries: async () => new Map(),
      encodeListCursor: (row) => row.artifactId,
      assertDefinitionWriteAllowed: () => { throw new Error('discovery_is_read_only'); },
    });
    let workflowEnabled = true;
    const executor = createActionExecutor({ workflowAction: createWorkflowActionExecutor({
      isWorkflowFeatureEnabled: () => workflowEnabled, definitions,
      runs: createWorkflowAccountRunActionOwner({ definitions,
        storage: { execute: async () => { throw new Error('discovery_starts_no_run'); } },
        resolveAccountId: async () => 'account', resolveEncryption: async () => ({ kind: 'available',
          witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: () => null, randomBytes: () => { throw new Error('discovery_needs_no_keys'); } }),
    }) } as unknown as ActionExecutorDeps);
    for (const [actionId, fieldPath] of [['workflow.trigger.add', 'workflow'],
      ['workflow.run.start', 'source.workflow']] as const) {
      const result = await executor.execute('action.options.resolve', { actionId, fieldPath, draftInput: {} }, { surface: 'agent' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { options: expect.arrayContaining([
        ...(actionId === 'workflow.run.start' ? [] : [{ value: ids[0], label: 'Own recipe' }, { value: ids[1], label: 'Shared recipe' }]),
        expect.objectContaining({ value: 'builtin:keep-going' }),
        expect.objectContaining({ value: 'builtin:plan-with-a-panel' }),
        { value: 'plugin:example.recipe/check', label: 'Check changes' },
      ]) } });
      if (actionId === 'workflow.run.start') expect(result).not.toMatchObject({ result: { options: expect.arrayContaining([
        expect.objectContaining({ value: ids[0] }),
      ]) } });
      expect(await resolveWorkflowDefinitionRefV1('builtin:plan-with-a-panel')).toMatchObject({ kind: 'catalog' });
    }
    workflowEnabled = false;
    await expect(executor.execute('action.options.resolve', { actionId: 'workflow.trigger.add', fieldPath: 'workflow', draftInput: {} },
      { surface: 'agent' })).resolves.toMatchObject({ ok: false, errorCode: 'content_unavailable' });
  });
  it('routes a strict normalized input through the single Workflow dependency', async () => {
    const workflowAction = vi.fn(async () => ({
      valid: true,
      normalizedDefinition: {
        version: 1,
        inputs: [],
        defaults: {},
        blocks: [{
          kind: 'step',
          id: 'step-1',
          document: { text: 'Summarize', references: [], attachments: [] },
          input: [],
          result: { kind: 'text' },
        }],
      },
      issues: [],
      targetValidation: 'not_requested',
    }));
    const executor = createActionExecutor({
      workflowAction,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('workflow.validate', {
      definition: { blocks: ['Summarize'] },
    }, { surface: 'ui' })).resolves.toMatchObject({ ok: true });
    expect(workflowAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'workflow.validate',
      input: { definition: { blocks: ['Summarize'] } },
    }));
  });

  it.each(['mcp', 'voice'] as const)('reads Habits writing here through the shared Workflow owner on %s', async (surface) => {
    const unavailable = async (): Promise<never> => { throw new Error('destination_read_uses_no_artifacts'); };
    const definitions = createWorkflowDefinitionActions({
      artifactStore: { list: unavailable, read: unavailable, create: unavailable, update: unavailable, delete: unavailable },
      encodeListCursor: row => row.artifactId,
      assertDefinitionWriteAllowed: unavailable,
    });
    // Only storage and Account identity/material are boundaries. Surface
    // admission, family dispatch and destination filtering use the real owners.
    const requests: unknown[] = [];
    const runs = createWorkflowAccountRunActionOwner({
      definitions, resolveAccountId: async () => 'account',
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: () => null, randomBytes: () => { throw new Error('plain_read_needs_no_keys'); },
      storage: { execute: async operation => {
        if (operation.operation !== 'list') throw new Error('destination_read_only');
        requests.push(operation.request);
        return { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {} };
      } },
    });
    const executor = createActionExecutor({
      workflowAction: createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, definitions, runs }),
    } as unknown as ActionExecutorDeps);

    // Both surfaces read the same admitted destination history through Actions.
    const result = await executor.execute('workflow.run.list', { targetSessionId: 'destination' }, { surface });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { runs: [], metadataByRunId: {} } });
    expect(requests).toEqual([{ targetSessionId: 'destination' }]);
  });

  it('routes Workflow run summaries through the canonical host port', async () => {
    // The dependency is the external host port; the real Action admission and
    // dispatch below remain exercised.
    const summaries = { summaries: [], remainingSourceArtifactIds: [] };
    const input = { sourceArtifactIds: ['definition-1'], recent: 3 };
    const executor = createActionExecutor({
      workflowAction: async (args: Parameters<NonNullable<ActionExecutorDeps['workflowAction']>>[0]) => {
        if (args.actionId !== 'workflow.run.summaries') throw new Error('unexpected_workflow_host_dispatch');
        expect(args.input).toEqual(input);
        return summaries;
      },
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('workflow.run.summaries', input, { surface: 'mcp' }))
      .resolves.toEqual({ ok: true, result: summaries });
  });

  it('fails closed before execution when the Workflow dependency is absent', async () => {
    const executor = createActionExecutor({
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('workflow.validate', {
      definition: { blocks: ['Summarize'] },
    }, { surface: 'ui' })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:workflow.validate',
    });
  });

  it('rejects caller-supplied Workflow authorization before the Workflow owner runs', async () => {
    const workflowAction = vi.fn();
    const executor = createActionExecutor({
      workflowAction,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('workflow.run.start', {
      runId: '11111111-1111-4111-8111-111111111111',
      source: {
        kind: 'inline',
        definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'wait',
          document: { text: 'Continue', references: [], attachments: [] } }] },
      },
      authorization: {
        admittedPermissionCeiling: 'yolo',
        principal: { kind: 'host' },
      },
    }, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      externalActionCredential: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: { issues: [expect.objectContaining({ code: 'unrecognized_keys', path: [] })] },
    });
    expect(workflowAction).not.toHaveBeenCalled();
  });

  it('host-stamps the effective controller permission for a direct start', async () => {
    // The ingress host reads plugin-owned schemas after the real family has
    // normalized authenticated permission context.
    const readIngress = vi.fn(async () => { throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' }); });
    const workflowAction = workflowWithIngressBoundary(readIngress);
    const executor = createActionExecutor({
      workflowAction,
    } as unknown as ActionExecutorDeps);

    await executor.execute('workflow.run.start', {
      runId: '11111111-1111-4111-8111-111111111111',
      source: { kind: 'inline', definition: { blocks: ['Summarize'] } },
    }, {
      surface: 'api',
      authority: 'account_automation',
      actionCaller: { kind: 'host' },
      externalActionCredential: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
      },
      externalActionTarget: {
        kind: 'machine',
        machineId: 'machine-1',
        project: { machineId: 'machine-1', directory: '/repo' },
      },
    });

    expect(readIngress).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ callerPermissionMode: 'yolo' }),
    }));
  });

  it('preserves a Workflow Run mediated source in the canonical Action permission context', async () => {
    // The ingress host reads plugin-owned schemas after the real family has
    // normalized authenticated permission context.
    const readIngress = vi.fn(async () => { throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' }); });
    const workflowAction = workflowWithIngressBoundary(readIngress);
    const executor = createActionExecutor({
      workflowAction,
    } as unknown as ActionExecutorDeps);

    await executor.execute('workflow.validate', { definition: { blocks: ['Summarize'] } }, {
      surface: 'agent',
      authority: 'account_automation',
      actionCaller: {
        kind: 'workflowRun',
        runId: 'run-parent',
        authorization: {
          admittedPermissionCeiling: 'read-only',
          principal: { kind: 'host' },
          sourceAuthority: {
            mediatorPluginId: 'happier.channels',
            sourceRef: 'channels:binding:binding-1',
            sourceRevisionOrEpoch: '4:7',
            remoteApprovalMaxScope: 'session',
          },
        },
      },
    });

    expect(readIngress).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        callerPermissionMode: 'read-only',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'read-only',
          sourceAuthority: {
            kind: 'mediatedExternal',
            mediatorPluginId: 'happier.channels',
            sourceRef: 'channels:binding:binding-1',
            sourceRevisionOrEpoch: '4:7',
            admittedPermissionCeiling: 'read-only',
            remoteApprovalMaxScope: 'session',
          },
        },
      }),
    }));
  });

  it('forwards the host-stamped Action context separately from normalized Workflow input', async () => {
    const context = {
      surface: 'agent' as const,
      authority: 'account_automation' as const,
      actionCaller: { kind: 'host' as const },
      callerPermissionMode: 'yolo',
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1' as const,
        admittedPermissionCeiling: 'default',
      },
      sessionInputSource: {
        sourceSessionId: 'session-1',
        sourceTurnId: 'turn-1',
        via: 'mcp' as const,
      },
    };
    const readIngress = vi.fn<NonNullable<Parameters<typeof createWorkflowActionExecutor>[0]['resolveIngressContext']>>(async (args) => {
      expect(args.context).toMatchObject({
        ...context,
        callerPermissionMode: 'default',
      });
      expect(args.input).toEqual({
        definition: { blocks: ['Summarize'] },
      });
      expect(args.input).not.toHaveProperty('authorization');
      throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
    });
    const executor = createActionExecutor({
      workflowAction: workflowWithIngressBoundary(readIngress),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('workflow.validate', {
      definition: { blocks: ['Summarize'] },
    }, context)).resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    expect(readIngress).toHaveBeenCalledOnce();
  });

  it('preserves a receiving host review before Workflow admission', async () => {
    const input = { runId: '11111111-1111-4111-8111-111111111111', source: { kind: 'inline', definition: {
      version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'action', id: 'command', actionId: 'machines.command.run',
        input: { command: { kind: 'literal', value: 'printf reviewed' } } }],
    } } };
    const refusal = { ok: false, errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required',
      details: { reviewDigest: 'MSCiAiJh1KrPkLmLYAEwdx9rcQxLEgmAQPyiZmgnvfU', review: { actionArgs: input,
        preview: { actionId: 'workflow.run.start', actionArgs: input, hostReviewedChildren: {
          children: [{ action: 'machines.command.run', role: 'command', input: { command: 'printf reviewed' } }],
        } },
      } },
    };
    // Only the external Workflow host port is substituted. The shared Action
    // admission and failure-envelope classification remain real.
    const executor = createActionExecutor({ workflowAction: async () => refusal } as unknown as ActionExecutorDeps);
    await expect(executor.execute('workflow.run.start', input, { surface: 'ui' })).resolves.toMatchObject(refusal);
  });

  it('does not publish an unrecognized Workflow operation error', async () => {
    const executor = createActionExecutor({
      workflowAction: vi.fn(async () => ({
        ok: false,
        errorCode: 'workflow_private_internal_failure',
        error: 'private detail',
      })),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('workflow.validate', {
      definition: { blocks: ['Summarize'] },
    }, { surface: 'ui' })).resolves.toEqual({
      ok: false,
      errorCode: 'content_unavailable',
      error: 'content_unavailable',
    });
  });

  it('does not publish details for Workflow failures that do not define them', async () => {
    const executor = createActionExecutor({
      workflowAction: vi.fn(async () => ({
        ok: false,
        errorCode: 'run_not_found',
        error: 'private lookup detail',
        details: { storageKey: 'private-key' },
      })),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('workflow.run.get', {
      runId: 'missing-run',
    }, { surface: 'ui' })).resolves.toEqual({
      ok: false,
      errorCode: 'content_unavailable',
      error: 'content_unavailable',
    });
  });

  it('preserves a closed Workflow operation error and its details', async () => {
    const executor = createActionExecutor({
      workflowAction: vi.fn(async () => ({
        ok: false,
        errorCode: 'workflow_wait_self_dependency',
        error: 'The current Session is an execution target',
        details: { runId: 'run-1' },
      })),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('workflow.validate', {
      definition: { blocks: ['Summarize'] },
    }, { surface: 'ui' })).resolves.toEqual({
      ok: false,
      errorCode: 'workflow_wait_self_dependency',
      error: 'The current Session is an execution target',
      details: { runId: 'run-1' },
    });
  });

  it('fails closed when a self-dependency failure omits its required Run handle', async () => {
    const executor = createActionExecutor({
      workflowAction: vi.fn(async () => ({
        ok: false,
        errorCode: 'workflow_wait_self_dependency',
        error: 'The current Session is an execution target',
      })),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('workflow.validate', {
      definition: { blocks: ['Summarize'] },
    }, { surface: 'ui' })).resolves.toEqual({
      ok: false,
      errorCode: 'content_unavailable',
      error: 'content_unavailable',
    });
  });
});
