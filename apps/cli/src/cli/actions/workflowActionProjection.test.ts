import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { describe, expect, it, vi } from 'vitest';
import { listActionSpecsForSurface, searchSerializedActionSpecsForSurface } from '@happier-dev/protocol';

import { findCompiledActionCliCommand, listCompiledActionCliCommands } from './compiledCommands';
import { composeActionCliInput, parseActionCliCommandInput } from './parseCommandInput';
import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { renderActionCliRootHelp } from './rootCommand';
import { createActionExecutor } from '@happier-dev/protocol';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { UiActionDispatchRequestV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { workflowDraftClientRpcMethod } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { describeCompiledActionCliCommandArgvPolicy, stripTransportTokens } from './executeCommand';
import { buildActionCliHelpModel } from './commandHelp';
import { resolveCompiledActionCliCompletionCandidates } from './commandCompletion';
import { runCompiledActionCliCommand } from './executeCommand';
import { captureStdoutJsonOutput, captureConsoleText } from '../../testkit/logger/captureOutput';

it('keeps project routing outside Action input across Workflow commands', () => {
  const commands = listCompiledActionCliCommands().filter(command => command.path[0] === 'workflow');
  expect(commands.some(command => command.actionId === 'workflow.run.start')).toBe(true);
  for (const command of commands) {
    const argv = [...command.path, '--server-id', 'home-a', '--machine-id', 'machine-1', '--project-directory', '/repo',
      '--workspace-ref-id', 'workspace-1', '--input-json', '{}'];
    expect(parseActionCliCommandInput(command, stripTransportTokens(command, argv)))
      .toMatchObject({ ok: true, canonicalBase: {}, callerOverlay: {} });
    if (command.actionId === 'workflow.run.list' || command.actionId === 'workflow.events.list') {
      expect(parseActionCliCommandInput(command, stripTransportTokens(command, [...argv, '--action-machine-id', 'filter-machine'])))
        .toMatchObject({ ok: true, callerOverlay: { machineId: 'filter-machine' } });
    }
    const help = buildActionCliHelpModel(command);
    const completions = resolveCompiledActionCliCompletionCandidates({ committed: command.path, prefix: '--' });
    for (const flag of ['--server-id', '--project-directory', '--workspace-ref-id']) {
      expect(help.cliOptions.some(row => row.label.startsWith(`${flag} `))).toBe(true);
      expect(completions).toContain(flag);
      expect(describeCompiledActionCliCommandArgvPolicy(command).valueFlags).toContain(flag);
    }
  }
});

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
  'workflow.definition.delete',
] as const;

describe('workflow Action projections', () => {
  it.each([
    { status: 'refused', reason: 'save_conflict', draftRevision: 7 },
    { status: 'unavailable' },
    { status: 'applied', draftRevision: 8 },
    { status: 'unchanged', draftRevision: 7 },
    { status: 'available', drafts: [] },
  ] as const)('presents mounted authoring $status honestly through the friendly CLI', async (receipt) => {
    const command = findCompiledActionCliCommand(['workflow', 'authoring', 'draft',
      receipt.status === 'available' ? 'get' : 'save']);
    if (!command) throw new Error('Missing mounted authoring command');
    const input = { scope: { serverId: 'home-a', accountId: 'account-a' }, draftId: 'draft-a' };
    let effects = 0;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), clientActionExecute: createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, raw, options) => {
        const request = UiActionDispatchRequestV1Schema.parse(raw);
        expect(request).toMatchObject({ actionId: command.actionId, input });
        options.onIssued();
        effects++;
        return { ok: true, result: { v: 1, execution: { ok: true, result: receipt } } };
      },
    })) });
    const failed = receipt.status === 'refused' || receipt.status === 'unavailable';
    for (const json of [true, false]) {
      const output = json ? captureStdoutJsonOutput() : null;
      const text = json ? null : captureConsoleText();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await runCompiledActionCliCommand({ command,
          argv: [...command.path, '--input-json', JSON.stringify(input), ...(json ? ['--json'] : [])],
          deps: { readCredentialsFn: async () => ({ token: 'hap_v1_test' } as never), createExecutorFn: () => executor },
        });
        expect(process.exitCode ?? 0).toBe(failed ? 1 : 0);
        if (failed) {
          if (output) expect(output.json()).toMatchObject({ ok: false, error: {
            code: receipt.status === 'refused' ? receipt.reason : 'unavailable', details: receipt,
          } });
          else expect(errors).toHaveBeenCalledWith(expect.anything(),
            receipt.status === 'refused' ? receipt.reason : 'unavailable');
        } else if (output) expect(output.json()).toMatchObject({ ok: true, data: receipt });
      } finally {
        output?.restore();
        text?.restore();
        errors.mockRestore();
        process.exitCode = undefined;
      }
    }
    expect(effects).toBe(2);
  });

  it('discovers Library clients and addresses view controls through the compiled CLI and real target selector', async () => {
    const { selectRpcTarget } = await import('../../../../server/sources/app/api/socket/rpc/rpcTargetSelection');
    const observed = { view: 'all', filters: { view: 'all' }, searchQuery: '', offeredViews: ['all', 'triggered'],
      visibleKeys: [], coverage: 'complete', selectedSpaceId: 'all-workflows' };
    const effects: string[] = [];
    let requests = 0;
    let lastFocusedClient: string | null = null;
    const unfocusedClients = new Set<string>();
    const receiver = (id: string) => ({ id,
      // The authenticated server focus event stamps this fact; socket id order is not focus history.
      ...(lastFocusedClient === id ? { data: { uiLastFocusedAt: 1 } } : {}),
      timeout: () => ({ emitWithAck: async (_event: string, raw: unknown) => {
      const request = UiActionDispatchRequestV1Schema.parse(raw);
      effects.push(`${id}:${request.actionId}`);
      if (unfocusedClients.has(id)) return { v: 1, execution: { ok: false, errorCode: 'unavailable', error: 'noClient' } };
      return { v: 1, execution: { ok: true, result: request.actionId.endsWith('.get') ? observed : { ok: true } } };
    } }) });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), clientActionExecute: createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (method, raw, options) => {
        requests++;
        expect(method).toBe(RPC_METHODS.UI_ACTION_EXECUTE);
        const selection = selectRpcTarget({ targets: [receiver('app-b'), receiver('app-a')], answeringClient: options.answeringClient });
        if (selection.type === 'ambiguous') return { ok: false, errorCode: RPC_ERROR_CODES.CLIENT_AMBIGUOUS,
          answeringClients: selection.clients };
        if (selection.type !== 'target') return { ok: false, errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE };
        options.onIssued();
        return { ok: true, result: await selection.target.timeout(0).emitWithAck('rpc-request', raw),
          answeringClientId: selection.target.id, answeringClientIds: selection.clientIds };
      },
    })) });
    const execute = async (operation: string, flags: string[] = []) => {
      const command = findCompiledActionCliCommand(['workflow', 'library', 'view', operation]);
      if (!command) throw new Error('Missing Library CLI command');
      const parsed = parseActionCliCommandInput(command, [...command.path, ...flags]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('Invalid Library CLI input');
      const bound = composeActionCliInput({ parsed, canonicalSchema: command.spec.inputSchema,
        callerSchema: command.callerSchema, context: { actionId: command.actionId, invocationId: 'cli-test' } });
      if (!bound.ok) throw new Error('Invalid Library CLI binding');
      return executor.execute(command.actionId, bound.input, { surface: 'cli', authority: 'present_user' });
    };
    // No focus history means no arbitrary client executes the read; discovery keeps its addresses.
    expect(await execute('get')).toMatchObject({ ok: false, errorCode: 'client_ambiguous', details: {
      clients: [{ id: 'app-a', deviceLabel: null }, { id: 'app-b', deviceLabel: null }],
      recovery: { kind: 'choose_client', inputField: 'clientId' },
    } });
    expect(effects).toEqual([]);
    // A real server-stamped focus fact selects the answering app and preserves every address.
    lastFocusedClient = 'app-a';
    expect(await execute('get')).toEqual({ ok: true, result: { ...observed,
      answeringClientId: 'app-a', answeringClientIds: ['app-a', 'app-b'] } });
    for (const operation of ['get', 'set', 'reset']) {
      expect(await execute(operation, ['--client-id', 'app-b'])).toMatchObject({ ok: true });
    }
    expect(effects).toEqual(['app-a:workflow.library.view.get', 'app-b:workflow.library.view.get',
      'app-b:workflow.library.view.set', 'app-b:workflow.library.view.reset']);
    // Missing or absent addresses must never mutate another app or retry unselected.
    lastFocusedClient = null;
    expect(await execute('set')).toMatchObject({ ok: false, errorCode: 'client_ambiguous',
      details: { recovery: { kind: 'choose_client', inputField: 'clientId' } } });
    expect(await execute('reset', ['--client-id', 'disconnected-app'])).toMatchObject({ ok: false, errorCode: 'client_not_available' });
    expect(effects).toHaveLength(4);
    expect(requests).toBe(7);
    // Discovery must still expose addresses if the last focused app has no mounted Library.
    lastFocusedClient = 'app-a';
    unfocusedClients.add('app-a');
    expect(await execute('get')).toMatchObject({ ok: false, errorCode: 'unavailable',
      details: { answeringClientId: 'app-a', answeringClientIds: ['app-a', 'app-b'] } });
    expect(await execute('get', ['--client-id', 'app-b'])).toMatchObject({ ok: true });
    expect(requests).toBe(9);
  });

  it.each([
    ['workflow.authoring.draft.get', {}],
    ['workflow.authoring.draft.edit', { expectedDraftRevision: 0, ops: [{ kind: 'rename', name: 'Review' }] }],
    ['workflow.authoring.draft.undo', {}],
    ['workflow.authoring.draft.redo', {}],
    ['workflow.authoring.draft.save', {}],
    ['workflow.authoring.draft.discard', {}],
    ['workflow.run.review.draft.set', { runId: 'run-a', expectedContentRevision: '1', value: 'Reviewed' }],
    ['workflow.library.view.get', null],
    ['workflow.library.view.set', { searchQuery: 'review' }],
    ['workflow.library.view.reset', null],
  ] as const)('publishes %s through CLI and returns typed absence from answering-client transport', async (id, patch) => {
    const command = findCompiledActionCliCommand(id.split('.'));
    expect(command?.actionId).toBe(id);
    if (!command) throw new Error('Missing compiled CLI command');
    const input = id.startsWith('workflow.library.') ? patch ?? {} : {
      scope: { serverId: 'home-a', accountId: 'account-a' }, draftId: 'draft-a', ...patch,
    };
    const parsed = parseActionCliCommandInput(command, [...command.path, '--input-json', JSON.stringify(input)]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Invalid CLI input');
    const bound = composeActionCliInput({ parsed, canonicalSchema: command.spec.inputSchema,
      callerSchema: command.callerSchema, context: { actionId: id, invocationId: 'cli-test' } });
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error('CLI input binding failed');
    const address = { scope: { serverId: 'home-a', accountId: 'account-a' }, draftId: 'draft-a' };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), clientActionExecute: createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => false,
      callConnectedClientRpc: async (method, request) => {
        expect(method).toBe(id.startsWith('workflow.library.') ? RPC_METHODS.UI_ACTION_EXECUTE : workflowDraftClientRpcMethod(address));
        expect(UiActionDispatchRequestV1Schema.parse(request)).toMatchObject({ actionId: id, input: bound.input, context: { surface: 'cli' } });
        return { ok: false, errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE };
      },
    })) });
    const context = { surface: 'cli' as const, authority: 'present_user' as const };
    if (id === 'workflow.authoring.draft.discard') {
      // CLI publication must retain danger's normal human-approval requirement.
      expect(await executor.execute(id, bound.input, context))
        .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    }
    expect(await executor.execute(id, bound.input, { ...context,
      // The transport check below represents the host's approved human replay.
      bypassApprovals: id === 'workflow.authoring.draft.discard' }))
      .toEqual(id.startsWith('workflow.library.') ? { ok: false, errorCode: 'unavailable', error: 'noClient' }
        : { ok: true, result: { status: 'unavailable' } });
  });
  it('derives every friendly workflow command from the canonical Action catalog', () => {
    const projected = new Set(
      listCompiledActionCliCommands().map((command) => String(command.actionId)),
    );

    expect(WORKFLOW_ACTION_IDS.filter((actionId) => !projected.has(actionId))).toEqual([]);
  });

  it('publishes portable document commands alongside the generated workflow Actions', () => {
    const help = renderActionCliRootHelp('workflow');
    expect(help).toContain('workflow definition import <file|->');
    expect(help).toContain('workflow definition export <definition-id>');
  });

  it('projects retry input without colliding with the compiler-owned whole-Action JSON flag', () => {
    const command = findCompiledActionCliCommand(['workflow', 'run', 'invocations', 'retry']);
    expect(command?.actionId).toBe('workflow.run.invocations.retry');
    expect(command?.fields.find((field) => field.path === 'retryInput')).toMatchObject({
      flag: '--retry-input',
      kind: 'json',
    });

    const parsed = parseActionCliCommandInput(command!, [
      ...command!.path,
      '--run-id', 'workflow_run_1',
      '--expected-revision', '3',
      '--invocation-json', '{"recordId":"workflow_invocation_1"}',
      '--causal-invocation-ids', 'workflow_invocation_1',
      '--conversation', 'same_conversation',
      '--retry-input-json', '{"kind":"original"}',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(composeActionCliInput({
      parsed,
      canonicalSchema: command!.spec.inputSchema,
      callerSchema: command!.callerSchema,
      bindInput: command!.binding ? command!.spec.cli?.bindInput : undefined,
      context: { actionId: command!.actionId, invocationId: 'invocation-1' },
    })).toMatchObject({
      ok: true,
      input: {
        runId: 'workflow_run_1',
        expectedRevision: 3,
        invocation: { recordId: 'workflow_invocation_1' },
        causalInvocationIds: ['workflow_invocation_1'],
        conversation: 'same_conversation',
        input: { kind: 'original' },
      },
    });
  });

  it('keeps only the four interactive Workflow MCP tools direct and discovers the remaining Actions', () => {
    const tools = listBuiltInHappierTools({
      surface: 'mcp',
      registry: createResolvedContributionRegistry({ agents: [] }),
    });
    const workflowActionIds = tools
      .map((tool) => String(tool.actionId))
      .filter((actionId) => actionId.startsWith('workflow.'))
      .sort();

    expect(workflowActionIds).toEqual([
      'workflow.run.cancel',
      'workflow.run.get',
      'workflow.run.start',
      'workflow.run.wait',
    ]);
    const discoverableOnlyWorkflowIds = listActionSpecsForSurface('mcp')
      .filter((spec) => spec.id.startsWith('workflow.') && spec.toolExposure?.mcp === 'discoverable_only')
      .map((spec) => String(spec.id));
    expect(workflowActionIds.filter((actionId) => discoverableOnlyWorkflowIds.includes(actionId))).toEqual([]);
    const discovered = new Set(searchSerializedActionSpecsForSurface({ surface: 'mcp', query: 'workflow',
      limit: 100, isActionEnabled: () => true }).map(spec => String(spec.id)));
    expect(discoverableOnlyWorkflowIds.filter(actionId => !discovered.has(actionId))).toEqual([]);
  });

  it('keeps every agent-exposed workflow Action discoverable', () => {
    const discoveredWorkflowIds = searchSerializedActionSpecsForSurface({
      surface: 'agent',
      query: 'workflow',
      limit: 100,
      isActionEnabled: () => true,
    })
      .map((spec) => String(spec.id))
      .filter((actionId) => actionId.startsWith('workflow.'));
    const exposedWorkflowIds = listActionSpecsForSurface('agent')
      .map((spec) => String(spec.id))
      .filter((actionId) => actionId.startsWith('workflow.'));
    expect(new Set(discoveredWorkflowIds)).toEqual(new Set(exposedWorkflowIds));
  });
});
