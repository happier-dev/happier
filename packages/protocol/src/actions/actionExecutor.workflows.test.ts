import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { createWorkflowActionExecutor } from './executor/workflowAccountActions.js';
import { createWorkflowDefinitionActions } from './executor/workflowDefinitions.js';
import { createWorkflowAccountRunActionOwner } from './executor/workflowRunActions.js';
import { resolveWorkflowDefinitionRefV1 } from '../workflows/workflowDefinitionResolverV1.js';
import { getBuiltinWorkflowCatalogV1 } from '../workflows/builtins/catalog.js';

describe('createActionExecutor (Workflow family)', () => {
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
              revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: index ? 'Shared recipe' : 'Own recipe' } },
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
    for (const [actionId, fieldPath] of [['workflow.trigger.add', 'workflow'], ['session.trigger.add', 'target.ref'],
      ['workflow.run.start', 'source.workflow']] as const) {
      const result = await executor.execute('action.options.resolve', { actionId, fieldPath, draftInput: {} }, { surface: 'agent' });
      expect(result).toMatchObject({ ok: true, result: { options: expect.arrayContaining([
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
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('workflow.validate', {
      definition: { blocks: ['Summarize'] },
    }, { surface: 'ui' })).resolves.toMatchObject({ ok: true });
    expect(workflowAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'workflow.validate',
      input: { definition: { blocks: ['Summarize'] } },
    }));
  });

  it('executes a discoverable Workflow operation through the generic MCP action transport without surface rejection', async () => {
    // The external host port returns the complete current page contract;
    // Action admission and result validation below remain real.
    const workflowAction = vi.fn(async () => ({ runs: [], metadataByRunId: {} }));
    const executor = createActionExecutor({
      workflowAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    // `workflow.run.list` is not a direct MCP tool, but the generic external
    // MCP `action_execute` transport must still reach the Workflow owner
    // instead of failing closed on surface availability.
    await expect(executor.execute('workflow.run.list', {}, { surface: 'mcp' }))
      .resolves.toMatchObject({ ok: true });
    expect(workflowAction).toHaveBeenCalledOnce();
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
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('workflow.run.summaries', input, { surface: 'mcp' }))
      .resolves.toEqual({ ok: true, result: summaries });
  });

  it('fails closed before execution when the Workflow dependency is absent', async () => {
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
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
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('workflow.run.start', {
      runId: '11111111-1111-4111-8111-111111111111',
      source: {
        kind: 'inline',
        definition: { version: 1, inputs: [], defaults: {}, blocks: [] },
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
    });
    expect(workflowAction).not.toHaveBeenCalled();
  });

  it('host-stamps the effective controller permission for a direct start', async () => {
    const workflowAction = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'target_unavailable' as const,
      error: 'target_unavailable',
    }));
    const executor = createActionExecutor({
      workflowAction,
      isActionApprovalRequired: () => false,
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

    expect(workflowAction).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ callerPermissionMode: 'yolo' }),
    }));
  });

  it('preserves a Workflow Run mediated source in the canonical Action permission context', async () => {
    const workflowAction = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'target_unavailable' as const,
      error: 'target_unavailable',
    }));
    const executor = createActionExecutor({
      workflowAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await executor.execute('workflow.run.get', { runId: 'run-1' }, {
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

    expect(workflowAction).toHaveBeenCalledWith(expect.objectContaining({
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
    const workflowAction = vi.fn(async (args) => {
      expect(args.context).toEqual({
        ...context,
        callerPermissionMode: 'default',
      });
      expect(args.input).toEqual({
        definition: { blocks: ['Summarize'] },
      });
      expect(args.input).not.toHaveProperty('authorization');
      return {
        ok: false as const,
        errorCode: 'invalid_input' as const,
        error: 'invalid_input',
      };
    });
    const executor = createActionExecutor({
      workflowAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('workflow.validate', {
      definition: { blocks: ['Summarize'] },
    }, context)).resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
    expect(workflowAction).toHaveBeenCalledOnce();
  });

  it('does not publish an unrecognized Workflow operation error', async () => {
    const executor = createActionExecutor({
      workflowAction: vi.fn(async () => ({
        ok: false,
        errorCode: 'workflow_private_internal_failure',
        error: 'private detail',
      })),
      isActionApprovalRequired: () => false,
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
      isActionApprovalRequired: () => false,
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
      isActionApprovalRequired: () => false,
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
      isActionApprovalRequired: () => false,
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
