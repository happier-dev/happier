import { describe, expect, it } from 'vitest';

import { ActionSpecSchema, getActionSpec } from './actionSpecs.js';
import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { WORKSPACE_ACTION_IDS } from './workspaceActionFamily.js';
import { HOME_HUB_LAYOUT_ACTION_IDS } from './specs/homeHub.js';
import { clientActionUnavailable } from './clientDispatchV1.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';

describe('current UI context host ActionSpecs', () => {
  it('refuses draft deletion without a connected app instead of reporting a successful unavailable receipt', () => {
    expect(clientActionUnavailable('session.draft.delete')).toMatchObject({
      ok: false, errorCode: 'unavailable', details: { reason: 'client_unavailable' },
    });
  });
  it('publishes mounted Workflow draft Actions with the canonical edit grammar and human discard admission', () => {
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    const address = { scope, draftId: 'draft-a' };
    for (const id of ['workflow.authoring.draft.get', 'workflow.authoring.draft.edit', 'workflow.authoring.draft.undo',
      'workflow.authoring.draft.redo', 'workflow.authoring.draft.save', 'workflow.authoring.draft.discard', 'workflow.run.review.draft.set'] as const) {
      const spec = getActionSpec(id);
      expect(ActionIdSchema.safeParse(id).success, id).toBe(true);
      expect(ActionSpecSchema.safeParse(spec).success, id).toBe(true);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, rpc: false });
      expect(spec.inputSchema.safeParse(JSON.parse(spec.examples?.mcp?.argsExample ?? 'null')).success, id).toBe(true);
      expect(spec.inputSchema.safeParse(JSON.parse(spec.examples?.voice?.argsExample ?? 'null')).success, id).toBe(true);
      expect(clientActionUnavailable(id)).toEqual({ ok: true, result: { status: 'unavailable' } });
    }
    const edit = getActionSpec('workflow.authoring.draft.edit');
    expect(edit.inputSchema.safeParse({ ...address, expectedDraftRevision: 3,
      ops: [{ kind: 'set_step_prompt', blockId: 'step-a', text: 'Keep the exact text' }] }).success).toBe(true);
    expect(edit.inputSchema.safeParse({ ...address, ops: [{ kind: 'invented' }] }).success).toBe(false);
    expect(edit.inputSchema.safeParse({ ...address, expectedDraftRevision: 3, settings: {
      description: 'Describe this draft', projectTarget: null, executionTarget: 'detached_run',
      triggers: { rows: [], project: null, inputs: {} },
    } }).success).toBe(true);
    expect(edit.inputSchema.safeParse({ ...address, expectedDraftRevision: 3, settings: { unexpected: true } }).success).toBe(false);
    expect(edit.inputSchema.safeParse({ ...address, expectedDraftRevision: 3, ops: [], settings: {} }).success).toBe(false);
    expect(edit.inputSchema.safeParse({ ...address, expectedDraftRevision: 3, settings: { triggers: {
      rows: [{ identity: { clientId: 'event-a' }, trigger: null, enabled: true },
        { identity: { clientId: 'event-a' }, trigger: null, enabled: true }], project: null, inputs: {},
    } } }).success).toBe(false);
    expect(getActionSpec('workflow.authoring.draft.get').inputSchema.safeParse({ scope }).success).toBe(true);
    expect(getActionSpec('workflow.authoring.draft.save').sideEffectClass).toBe('write');
    expect(getActionSpec('workflow.authoring.draft.discard').safety).toBe('danger');
    expect(getActionSpec('workflow.authoring.draft.discard').requiredAuthority).toBe('present_user');
  });
  it('distinguishes review buffer clearing and reading from setting a JSON result value', () => {
    const schema = getActionSpec('workflow.run.review.draft.set').inputSchema;
    const address = { scope: { serverId: 'home-a', accountId: 'account-a' }, draftId: 'invocation-a',
      runId: 'run-a', expectedContentRevision: '7' };
    expect(schema.safeParse({ ...address, value: null }).success).toBe(true);
    for (const operation of ['clear', 'show_newer'] as const) {
      expect(schema.safeParse({ ...address, operation }).success, operation).toBe(true);
      expect(schema.safeParse({ ...address, operation, value: null }).success).toBe(false);
      expect(schema.safeParse({ ...address, operation, unexpected: true }).success).toBe(false);
    }
    expect(schema.safeParse({ ...address, operation: 'complete' }).success).toBe(false);
    expect(schema.safeParse(address).success).toBe(false);
  });
  it('lets an approved (bypass) agent Discard reach the draft owner; agents ask by default', async () => {
    const actionId = 'workflow.authoring.draft.discard';
    let reached = 0;
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), requiredByPolicy: false,
      context: { surface: 'agent', authority: 'account_automation' } })).toMatchObject({ required: false });
    const executor = createActionExecutor({
      workflowAuthoringAction: async () => { reached += 1; return { discarded: true }; },
    } as unknown as ActionExecutorDeps);
    expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId),
      context: { surface: 'agent', authority: 'account_automation' } }).required).toBe(true);
    expect(await executor.execute('workflow.authoring.draft.discard',
      { scope: { serverId: 'home-a', accountId: 'account-a' }, draftId: 'draft-a' },
      { surface: 'agent', authority: 'account_automation', bypassApprovals: true }))
      .not.toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(reached).toBe(1);
  });
  it('publishes admitted Home layout and pool reorder invocation metadata', () => {
    for (const actionId of ['home.hub.layout.get', 'home.hub.layout.update', 'connectedServices.pools.reorder'] as const) {
      const spec = getActionSpec(actionId);
      expect.soft(ActionSpecSchema.safeParse(spec).success, actionId).toBe(true);
      expect(spec.surfaces.cli).toBe(true);
      expect(spec.surfaces.mcp).toBe(true);
      if (actionId !== 'connectedServices.pools.reorder') {
        expect.soft(spec.bindings?.rpcMethod).toBe(actionId);
      }
    }
  });

  it('publishes workspace and Home inputs and usable examples for every declared Voice operation', () => {
    for (const actionId of [...WORKSPACE_ACTION_IDS, ...HOME_HUB_LAYOUT_ACTION_IDS]) {
      const spec = getActionSpec(actionId);
      expect(ActionSpecSchema.safeParse(spec).success, actionId).toBe(true);
      expect(spec.inputHints?.fields, actionId).toEqual(expect.any(Array));
      expect(spec.examples?.voice?.argsExample, actionId).toEqual(expect.any(String));
      expect(spec.inputSchema.safeParse(JSON.parse(spec.examples?.voice?.argsExample ?? 'null')).success, actionId).toBe(true);
    }
    expect(getActionSpec('workspace.tabs.open').inputHints?.fields.map(field => field.path)).toEqual(
      expect.arrayContaining(['href', 'groupId', 'beforeTabId', 'mode']),
    );
    expect(getActionSpec('workspace.tabs.move').inputHints?.fields.map(field => field.path)).toEqual(
      expect.arrayContaining(['tabId', 'targetGroupId', 'beforeTabId']),
    );
  });

  it('exposes composer transactions and file pickers at their actual client placement without serializing OS handles', async () => {
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    const ref = { kind: 'newSession', instanceId: 'input-a' };
    const transaction = { expectedRevision: 1, operations: [{ kind: 'text.insert', position: { offset: 0 }, text: 'context' }] };
    const transactionSpec = getActionSpec('composer.transaction.apply' as never);
    for (const id of ['composer.transaction.apply', 'composer.attachments.pick', 'repository.upload.pick'] as const) {
      const spec = getActionSpec(id);
      expect(ActionSpecSchema.safeParse(spec).success).toBe(true);
      expect(spec.inputHints?.fields.length).toBeGreaterThan(0);
      expect(spec.inputSchema.safeParse(JSON.parse(spec.examples?.mcp?.argsExample ?? 'null')).success).toBe(true);
    }
    expect(transactionSpec.inputSchema.safeParse({ scope, ref, transaction }).success).toBe(true);
    const executor = createActionExecutor({ isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    expect(await executor.execute('composer.transaction.apply' as never, { scope, ref, transaction }, { surface: 'agent', authority: 'account_automation' }))
      .toEqual({ ok: true, result: { status: 'composerUnavailable' } });
    for (const [id, input] of [
      ['composer.attachments.pick', { scope, ref }],
      ['repository.upload.pick', { scope, workspace: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, destinationDir: 'src', kind: 'files' }],
    ] as const) {
      const spec = getActionSpec(id as never);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, rpc: false });
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expect(spec.inputSchema.safeParse({ ...input, files: [{ name: 'invented', bytes: 'fake' }] }).success).toBe(false);
      expect(await executor.execute(id as never, input, { surface: 'agent', authority: 'account_automation' })).toEqual({ ok: true, result: { status: 'unavailable' } });
    }
  });
  it('binds a qualified Workflow authoring conversation only on the answering client', async () => {
    const actionId = 'workflow.authoring.conversation.bind';
    const spec = getActionSpec(actionId);
    const input = { scope: { serverId: 'home-a', accountId: 'account-a' }, draftId: 'draft-a', stepId: 'step-a',
      address: { serverId: 'home-a', sessionId: 'session-a' } };
    expect(spec.executionPlacement).toBe('client');
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, rpc: false });
    expect(spec.inputSchema.safeParse(input).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...input, prompt: 'do not submit' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...input, address: { ...input.address, machineId: 'caller-chosen' } }).success).toBe(false);
    expect(spec.inputHints?.fields.map(field => field.path)).toEqual(['scope', 'draftId', 'stepId', 'address', 'clientId']);
    const executor = createActionExecutor({ isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    expect(await executor.execute(actionId, input, { surface: 'agent', authority: 'account_automation' }))
      .toEqual({ ok: true, result: { status: 'unavailable' } });
  });
  it('preserves scoped reorder refusals and returns unavailable on headless hosts', async () => {
    const input = { scope: { serverId: 'home-a', accountId: 'account-a' }, sourceId: 'source', position: { anchorId: 'anchor', placement: 'before' } };
    // The client-hosted execution port is the system boundary; real Protocol admission and result handling run below.
    const executor = createActionExecutor({ listReorder: async () => ({ status: 'refused', reason: 'todo_reorder_conflict' }),
      isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    const context = { surface: 'agent' as const, authority: 'account_automation' as const };
    expect(await executor.execute('tasks.internal.reorder', input, context)).toEqual({ ok: true, result: { status: 'refused', reason: 'todo_reorder_conflict' } });
    const headless = createActionExecutor({ isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    expect(await headless.execute('tasks.internal.reorder', input, context)).toEqual({ ok: true, result: { status: 'unavailable' } });
    expect(await executor.execute('tasks.internal.reorder', { ...input, orderedIds: ['source'] }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });
  it('exposes exact pending and undone-todo semantic reorder without replacement membership', () => {
    for (const actionId of ['session.pending.reorder', 'tasks.internal.reorder']) {
      const spec = getActionSpec(actionId as never);
      const common = { scope: { serverId: 'home-a', accountId: 'account-a' }, sourceId: 'source', position: { anchorId: 'anchor', placement: 'before' } };
      const input = actionId === 'session.pending.reorder' ? { ...common, sessionId: 'session-a', recipient: null } : common;
      expect(spec.executionPlacement).toBe(actionId === 'session.pending.reorder' ? 'client' : 'account');
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, rpc: false });
      expect(spec.inputSchema.safeParse(input).success).toBe(true);
      expect(spec.inputSchema.safeParse({ ...input, orderedIds: ['source'] }).success).toBe(false);
      expect(spec.inputSchema.safeParse({ ...input, position: { anchorId: 'anchor', placement: 'before', index: 1 } }).success).toBe(false);
      expect(spec.outputSchema?.safeParse({ status: 'unavailable' }).success).toBe(true);
      expect(spec.outputSchema?.safeParse({ status: 'unknown', reason: 'transport_failure' }).success).toBe(true);
      if (actionId === 'session.pending.reorder') {
        expect(spec.inputSchema.safeParse({ ...input, recipient: { kind: 'execution_run', runId: 'run-a' } }).success).toBe(true);
        const { recipient, ...unboundRecipient } = input as typeof common & { sessionId: string; recipient: null };
        expect(spec.inputSchema.safeParse(unboundRecipient).success).toBe(false);
      }
    }
  });
  it('exposes semantic Session organization movement on the answering client', () => {
    const spec = getActionSpec('session.organization.move');
    expect(spec.executionPlacement).toBe('client');
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, rpc: false });
    expect(spec.inputSchema.safeParse({ scope: { serverId: 'home-a', accountId: 'account-a' },
      sourceRowId: 'row-a', sourceKind: 'leaf', instructionKind: 'reorder-before',
      targetRowId: 'row-b', containerId: 'root', parentRowId: null, depth: 0, edge: 'top' }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ sourceRowId: 'row-a', index: 2 }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ status: 'unavailable' }).success).toBe(true);
  });
  it('opens the addressed prompt picker without accepting or disclosing draft text', () => {
    const spec = getActionSpec('ui.prompts.picker.open');
    expect(spec.executionPlacement).toBe('client');
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: false, rpc: false });
    expect(spec.inputSchema.safeParse({}).success).toBe(true);
    expect(spec.inputSchema.safeParse({ composerRef: { kind: 'newSession', instanceId: 'new-1' } }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ composerRef: { kind: 'session', sessionId: 's1', serverId: 'untrusted' } }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ text: 'private draft' }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ status: 'opened', composerRef: { kind: 'newSession', instanceId: 'new-1' } }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ status: 'noEligibleComposer' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ status: 'opened', text: 'private draft' }).success).toBe(false);
  });
  it('admits Find operations only on a mounted client and rejects corpus disclosure', () => {
    const spec = getActionSpec('ui.find' as never);
    expect(spec.executionPlacement).toBe('client');
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, rpc: false });
    expect(spec.inputSchema.safeParse({ op: 'set', query: 'literal\\query', options: { regex: false, matchCase: true }, target: 'chat:1' }).success).toBe(true);
    expect(spec.inputSchema.safeParse({ op: 'read', query: 'ignored' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ op: 'step', direction: 0 }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ op: 'refold', target: 'review:1' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ status: 'unavailable', reason: 'unsupportedOperation' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ status: 'unavailable', reason: 'noRevealedFold' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ status: 'noMountedSurface' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ status: 'unavailable', unavailable: 'engineOwned',
      query: 'host seed', options: { matchCase: true, regex: false } }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ status: 'unavailable', unavailable: 'engineOwned',
      query: 'host seed', options: { matchCase: true, regex: false }, total: 0 }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ status: 'results', current: null, total: 0, coverage: 'loaded' }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ status: 'results', current: null, total: 0, coverage: 'complete', text: 'private corpus' }).success).toBe(false);
  });
  it('exposes Next only through a mounted client with closed navigation results', () => {
    const spec = getActionSpec('session.pending.next' as never);
    expect(spec.executionPlacement).toBe('client');
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: false, rpc: false });
    expect(spec.inputSchema.safeParse({}).success).toBe(true);
    expect(spec.inputSchema.safeParse({ sessionId: 'untrusted-target' }).success).toBe(false);
    for (const status of ['opened', 'none', 'unavailable']) {
      expect(spec.outputSchema?.safeParse({ status }).success).toBe(true);
    }
    expect(spec.outputSchema?.safeParse({ status: 'resumed' }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ status: 'opened', sessionId: 'leaked-target' }).success).toBe(false);
  });
  it('exposes mounted palette commands to client-backed Agent and MCP callers', () => {
    for (const actionId of ['ui.command_palette.list', 'ui.command_palette.invoke'] as const) {
      const spec = getActionSpec(actionId);
      expect(spec.executionPlacement).toBe('client');
      expect(spec.surfaces).toMatchObject({ ui: true, agent: true, mcp: true, cli: true, rpc: false });
      expect(spec.inputSchema.safeParse(actionId.endsWith('.list') ? {} : { commandId: 'account' }).success).toBe(true);
    }
    expect(getActionSpec('ui.command_palette.invoke').inputSchema.safeParse({ commandId: 'account', href: '/dev' }).success).toBe(false);
  });

  it('publishes the stable read, opaque-command, and generic Action bindings', () => {
    const read = getActionSpec('ui.current_context.read' as never);
    const invoke = getActionSpec('ui.current_context.command.invoke' as never);
    const invokeAction = getActionSpec('action.invoke' as never);

    const voiceApiPlugin = {
      ui: false,
      voice: true,
      agent: false,
      mcp: false,
      cli: true,
      rpc: false,
      api: true,
      plugin: true,
    };
    expect(read).toMatchObject({
      id: 'ui.current_context.read',
      sideEffectClass: 'read',
      safety: 'safe',
      bindings: { voiceClientToolName: 'readCurrentUiContext' },
    });
    expect(read.executionPlacement).toBe('client');
    expect(read.surfaces).toEqual({ ...voiceApiPlugin, ui: true, agent: true, mcp: true });
    expect(read.inputSchema.safeParse({}).success).toBe(true);
    expect(read.outputSchema?.safeParse({
      navigation: { area: 'workspace', screen: 'session', title: 'Current session' },
      commands: [{ id: 'current-ui:1:0', title: 'Open details' }],
    }).success).toBe(true);

    expect(invoke).toMatchObject({
      id: 'ui.current_context.command.invoke',
      sideEffectClass: 'external',
      safety: 'safe',
      bindings: { voiceClientToolName: 'invokeCurrentUiCommand' },
    });
    expect(invoke.executionPlacement).toBe('client');
    expect(invoke.surfaces).toEqual({ ...voiceApiPlugin, ui: true, agent: true, mcp: true });
    expect(invoke.inputSchema.safeParse({ commandId: 'current-ui:1:0' }).success).toBe(true);
    expect(invoke.inputSchema.safeParse({ command: { kind: 'executeAction' } }).success).toBe(false);

    expect(invokeAction).toMatchObject({
      id: 'action.invoke',
      sideEffectClass: 'external',
      safety: 'safe',
      bindings: { voiceClientToolName: 'invokeAction' },
    });
    expect(invokeAction.surfaces).toEqual({
      ...voiceApiPlugin,
      ui: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
      api: true,
      plugin: true,
    });
    expect(invokeAction.inputSchema.safeParse({
      action: { pluginId: 'acme.plugin', localId: 'open-details' },
      input: { source: 'voice' },
    }).success).toBe(true);
    expect(invokeAction.inputSchema.safeParse({
      action: { localId: 'open-details' },
    }).success).toBe(false);
  });
});
