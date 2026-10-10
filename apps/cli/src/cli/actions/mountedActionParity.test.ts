import { describe, expect, it } from 'vitest';

import { createActionExecutor, getActionSpec, listActionSpecsForSurface, type ActionExecutorDeps, type ActionId } from '@happier-dev/protocol';
import { clientActionUnavailable } from '@happier-dev/protocol/actions/clientDispatchV1';

import { compileActionCliFields, listCompiledActionCliCommands } from './compiledCommands';
import { composeActionCliInput, parseActionCliCommandInput, parseActionCliInput } from './parseCommandInput';

const scope = { serverId: 'home-a', accountId: 'account-a' };
const canvas = { scope, canvasKey: 'canvas-a' };
const tab = { ...canvas, tabId: 'tab-a' };
const composer = { scope, ref: { kind: 'newSession', instanceId: 'composer-a' } };
const position = { anchorId: null, placement: 'before' };
const cases = [
  { id: 'session.canvas.tabs.list', input: canvas, result: { status: 'listed', focusedLeafId: null, maximizedLeafId: null, leaves: [], tabs: [] } },
  { id: 'session.canvas.tabs.open', input: { ...canvas, sessionId: 'session-a', leafId: 'leaf-a' }, result: { status: 'applied' } },
  { id: 'session.canvas.tabs.activate', input: tab, result: { status: 'applied' } },
  { id: 'session.canvas.tabs.close', input: tab, result: { status: 'applied' } },
  { id: 'session.canvas.tabs.move', input: { ...tab, targetLeafId: 'leaf-b' }, result: { status: 'applied' } },
  { id: 'session.canvas.tabs.reorder', input: { ...tab, beforeTabId: null }, result: { status: 'applied' } },
  { id: 'session.canvas.tabs.pin', input: { ...tab, pinned: true }, result: { status: 'applied' } },
  { id: 'session.organization.move', input: { scope, sourceRowId: 'session-a', sourceKind: 'leaf', instructionKind: 'move-to-root', targetRowId: null, containerId: null, parentRowId: null, depth: null, edge: null }, result: { status: 'applied' } },
  { id: 'session.pending.reorder', input: { scope, sourceId: 'pending-a', position, sessionId: 'session-a', recipient: null }, result: { status: 'applied' } },
  { id: 'todos.reorder', input: { scope, sourceId: 'todo-a', position }, result: { status: 'applied' } },
  { id: 'workflow.authoring.conversation.bind', input: { scope, draftId: 'draft-a', stepId: null, address: { serverId: 'home-a', sessionId: 'session-a' } }, result: { status: 'applied' } },
  { id: 'composer.transaction.apply', input: { ...composer, transaction: { expectedRevision: 1, operations: [{ kind: 'text.set', text: 'Context' }] } }, result: { status: 'applied', revision: 2 } },
  { id: 'composer.attachments.pick', input: composer, result: { status: 'opened' } },
  { id: 'repository.upload.pick', input: { scope, workspace: { serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo' }, destinationDir: 'src', kind: 'files' }, result: { status: 'requested' } },
  { id: 'session.presentation.apply', input: { intent: { kind: 'companion.show' } }, result: { status: 'applied', revision: 'client-a:2' } },
] as const satisfies readonly { id: ActionId; input: unknown; result: unknown }[];

function cliInput(actionId: ActionId, input: unknown) {
  // Generic `actions invoke` uses the same schema compiler/parser as each
  // Action's canonical command declaration.
  const spec = getActionSpec(actionId);
  const compiled = compileActionCliFields(spec);
  const parsed = parseActionCliInput({ fields: compiled.fields, positionals: [] }, ['--input-json', JSON.stringify(input)]);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error('invalid_cli_input');
  const composed = composeActionCliInput({ parsed, canonicalSchema: spec.inputSchema,
    wholeInputSchema: compiled.wholeInputSchema, callerSchema: compiled.callerSchema,
    bindInput: compiled.bindInput, context: { actionId, invocationId: 'cli-parity' } });
  expect(composed.ok).toBe(true);
  if (!composed.ok) throw new Error('invalid_cli_composition');
  return composed.input;
}

const context = { surface: 'cli', authority: 'account_automation', defaultSessionId: 'session-a', bypassApprovals: true } as const;
const commands = listCompiledActionCliCommands();

describe('mounted Action CLI parity', () => {
  it('does not expose undeclared client scope Actions', () => {
    for (const id of ['session.list.view.get', 'session.list.view.set', 'session.list.view.reset', 'shell.column.get', 'shell.column.set'] as const) {
      expect(getActionSpec(id).surfaces.cli).toBe(false);
      expect(commands.some(command => command.actionId === id)).toBe(false);
    }
  });
  it.each(cases)('$id admits CLI input and preserves the mounted responder outcome', async ({ id, input, result }) => {
    expect(listActionSpecsForSurface('cli').some(spec => spec.id === id)).toBe(true);
    const normalizedInput = cliInput(id, input);
    const command = commands.find(candidate => candidate.actionId === id && candidate.visibility === 'canonical');
    expect(command, id).toBeDefined();
    if (!command) throw new Error('missing_cli_command');
    const parsed = parseActionCliCommandInput(command, [...command.path, '--input-json', JSON.stringify(input)]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('invalid_friendly_cli_input');
    expect(command.wholeInputSchema.parse(parsed.canonicalBase)).toEqual(normalizedInput);
    const delivered: unknown[] = [];
    // These ports represent the cross-process mounted-client response. Only
    // that system boundary is substituted; parsing, admission and dispatch run.
    const respond = async (args: { input: unknown }) => { delivered.push(args.input); return result; };
    const mountedPorts = {
      clientActionExecute: async (args) => ({ ok: true as const, result: await respond(args) }),
      currentSessionPresentationApply: respond,
    } satisfies Partial<ActionExecutorDeps>;
    // Unused host services are absent in this bounded transport fixture.
    const executor = createActionExecutor(mountedPorts as ActionExecutorDeps);
    await expect(executor.execute(id, normalizedInput, context)).resolves.toEqual({ ok: true, result });
    expect(delivered).toEqual([normalizedInput]);
  });

  it.each(cases)('$id reports typed unavailability without a mounted responder', async ({ id, input }) => {
    const normalizedInput = cliInput(id, input);
    // The mounted-client transport has no responder; no headless writer exists.
    const executor = createActionExecutor({
      clientActionExecute: async ({ actionId }) => clientActionUnavailable(actionId),
    } as ActionExecutorDeps);
    const expected = id === 'session.presentation.apply'
      ? { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${id}` }
      : { ok: false, errorCode: 'unavailable', error: 'noClient' };
    await expect(executor.execute(id, normalizedInput, context)).resolves.toEqual(expected);
  });
});

describe('named area layout selection CLI dispatch', () => {
  const surface = { serverId: 'home', accountId: 'viewer', owner: {
    kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview',
  } } as const;
  const scopePorts = { widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) };

  it('forwards the selection to the mounted client rather than reading an Account layout', async () => {
    const result = getActionSpec('widgets.area.layout.select').outputSchema!.parse({
      surface, instances: [], items: [], canEdit: true, isShared: false, state: 'missing', revision: null,
    });
    const delivered: unknown[] = [];
    const ports = { ...scopePorts, clientActionExecute: async (args) => {
      delivered.push(args.input);
      return { ok: true as const, result };
    } } satisfies Partial<ActionExecutorDeps>;
    const executor = createActionExecutor(ports as ActionExecutorDeps);
    const input = cliInput('widgets.area.layout.select', { surface });
    await expect(executor.execute('widgets.area.layout.select', input, context)).resolves.toEqual({ ok: true, result });
    expect(delivered).toEqual([input]);
  });

  it('refuses selection without an answering mounted client', async () => {
    const ports = { ...scopePorts,
      clientActionExecute: async ({ actionId }) => clientActionUnavailable(actionId),
    } satisfies Partial<ActionExecutorDeps>;
    const executor = createActionExecutor(ports as ActionExecutorDeps);
    await expect(executor.execute('widgets.area.layout.select', cliInput('widgets.area.layout.select', { surface }), context))
      .resolves.toEqual({ ok: false, errorCode: 'unavailable', error: 'noClient' });
  });
});
