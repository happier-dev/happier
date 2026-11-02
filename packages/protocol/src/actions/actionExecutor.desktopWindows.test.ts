import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { listActionSpecsForCatalogSurface } from './actionCatalog.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { buildUiActionDispatchRequestV1, clientActionUnavailable, UiActionDispatchRequestV1Schema } from './clientDispatchV1.js';

const scope = { accountId: 'account', serverId: 'home' };
const person = { surface: 'ui', authority: 'present_user', runtimeAccountId: scope.accountId,
  serverId: scope.serverId, actionCaller: { kind: 'host' } } as const;

function executor(deps: Partial<ActionExecutorDeps>) {
  // Native/client effect adapters are the boundary; admission and completion stay real.
  return createActionExecutor(deps as ActionExecutorDeps);
}

describe('desktop destination window Action', () => {
  it('discovers one safe client Action and rejects incomplete or mixed routing identities', () => {
    const id = ActionIdSchema.parse('desktop.windows.open');
    const spec = getActionSpec(id);
    expect(spec.executionPlacement).toBe('client');
    for (const surface of ['ui', 'agent', 'mcp', 'cli', 'voice'] as const) {
      expect(listActionSpecsForCatalogSurface({ surface }).map(item => item.id)).toContain(id);
      expect(isApprovalRequiredByActionsSettings(id, ActionsSettingsV1Schema.parse({ v: 1 }),
        { surface, authority: 'account_automation' })).toBe(false);
    }
    for (const target of [
      { kind: 'session', ...scope, sessionId: 'session' },
      { kind: 'workspaceTab', ...scope, tabId: 'tab' },
      { kind: 'destination', ...scope, href: '/settings' },
      { kind: 'paneTab', ...scope, layoutId: 'main', scopeId: 'session:session', tabKey: 'editor' },
    ]) {
      expect(spec.inputSchema.safeParse({ target, windowId: 'window' }).success).toBe(true);
      expect(spec.inputSchema.safeParse({ target: { ...target, accountId: undefined } }).success).toBe(false);
      expect(spec.inputSchema.safeParse({ target: { ...target, unknownRoute: 'elsewhere' } }).success).toBe(false);
    }
  });

  it('admits once and preserves native opened/focused/cancelled outcomes', async () => {
    const id = ActionIdSchema.parse('desktop.windows.open');
    const input = { target: { kind: 'workspaceTab', ...scope, tabId: 'tab' }, windowId: 'existing' };
    for (const result of [
      { status: 'opened', windowId: 'new', rect: { x: 1, y: 2, width: 480, height: 640 } },
      { status: 'focused', windowId: 'existing' },
      { status: 'cancelled' },
    ]) {
      const received: unknown[] = [];
      const actions = executor({ desktopWindowsOpen: async request => { received.push(request.input); return result; } });
      expect(await actions.execute(id, input, person)).toEqual({ ok: true, result });
      expect(received).toEqual([input]);
    }
    expect(await executor({}).execute(id, input, person)).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(clientActionUnavailable(id)).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    const malformed = executor({ desktopWindowsOpen: async () => ({ status: 'opened' }) });
    expect(await malformed.execute(id, input, person)).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('routes Session window presentation to the same native owner and leaves ordinary opens on main', async () => {
    const opened: unknown[] = [];
    const main: unknown[] = [];
    const actions = executor({
      desktopWindowsOpen: async request => { opened.push(request.input); return { status: 'focused', windowId: 'window' }; },
      sessionOpen: async request => { main.push(request); return { opened: true }; },
    });
    expect(await actions.execute('session.open', { sessionId: 'session', serverId: 'home', presentation: 'window' }, person))
      .toEqual({ ok: true, result: { status: 'focused', windowId: 'window' } });
    expect(opened).toEqual([{ target: { kind: 'session', ...scope, sessionId: 'session' } }]);
    expect(main).toEqual([]);
    expect(await actions.execute('session.open', { sessionId: 'session', serverId: 'home' }, person))
      .toEqual({ ok: true, result: { opened: true } });
    expect(main).toHaveLength(1);
    expect(opened).toHaveLength(1);
    const destination = { kind: 'scmReview', comparison: { kind: 'workingTree' }, view: 'files' };
    expect(await actions.execute('session.open', { sessionId: 'session', presentation: 'window', destination }, person))
      .toEqual({ ok: true, result: { status: 'focused', windowId: 'window' } });
    expect(opened.at(-1)).toEqual({ target: { kind: 'session', ...scope, sessionId: 'session', destination } });
    expect(await actions.execute('session.open', { sessionId: 'session', tabId: 'retained', presentation: 'window', destination }, person))
      .toEqual({ ok: true, result: { status: 'focused', windowId: 'window' } });
    expect(opened.at(-1)).toEqual({ target: { kind: 'workspaceTab', ...scope, tabId: 'retained', destination } });
  });

  it('serializes the admitted context through the wire owner without leaking local runtime facts', () => {
    const request = buildUiActionDispatchRequestV1({ actionId: 'clipboard.write', input: { text: 'admitted' },
      context: { ...person, actionRequestId: 'request', defaultSessionId: 'session', signal: new AbortController().signal } });
    expect(request).toEqual({ v: 1, actionId: 'clipboard.write', input: { text: 'admitted' },
      context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        actionRequestId: 'request', defaultSessionId: 'session' } });
    expect(UiActionDispatchRequestV1Schema.safeParse(request).success).toBe(true);
  });

  it('forwards an admitted client effect without another policy decision and can continue locally', async () => {
    let admissions = 0;
    let effects = 0;
    let forwards = 0;
    const presenter = executor({
      isActionEnabled: () => { throw new Error('Presenter must trust the admitted request'); },
      isActionApprovalRequired: () => { throw new Error('Presenter must not ask again'); },
      clipboardWrite: async () => { effects += 1; return { status: 'copied' }; },
    });
    const main = executor({
      isActionApprovalRequired: () => { admissions += 1; return false; },
      clientActionExecute: async request => {
        forwards += 1;
        return presenter.executeAdmittedClientAction(request.actionId, request.input, request.context);
      },
    });
    expect(await main.execute('clipboard.write', { text: 'draft insertion' }, person))
      .toEqual({ ok: true, result: { status: 'copied' } });
    expect({ admissions, effects, forwards }).toEqual({ admissions: 1, effects: 1, forwards: 1 });
    const local = executor({
      clientActionExecute: request => request.execute(),
      clipboardWrite: async () => { effects += 1; return { status: 'copied' }; },
    });
    expect(await local.execute('clipboard.write', { text: 'local' }, person))
      .toEqual({ ok: true, result: { status: 'copied' } });
    expect(effects).toBe(2);
  });

  it('carries the admitted caller and effective authority through native workspace close continuation', async () => {
    for (const caller of [
      { surface: 'ui' as const, actionCaller: { kind: 'host' as const } },
      { surface: 'agent' as const, authority: 'account_automation' as const },
    ]) {
      let admitted: unknown;
      let effectContext: unknown;
      const presenter = executor({ workspaceAction: async request => {
        effectContext = Reflect.get(request, 'context');
        return { ok: true };
      } });
      const actions = executor({
        clientActionExecute: async request => {
          admitted = request.context;
          return presenter.executeAdmittedClientAction(request.actionId, request.input, request.context);
        },
      });
      const context = { ...caller, runtimeAccountId: 'account', serverId: 'home', actionRequestId: 'close-request' };
      expect(await actions.execute('workspace.tabs.close', { tabId: 'placed-session' }, context))
        .toEqual({ ok: true, result: { ok: true } });
      const expected = { ...context, authority: 'account_automation' };
      expect(admitted).toEqual(expected);
      expect(effectContext).toEqual(expected);
    }
    let effects = 0;
    const unavailable = executor({ clientActionExecute: async request => {
      effects += 1;
      return request.execute();
    } });
    expect(await unavailable.execute('workspace.tabs.close', { tabId: 'tab' }))
      .toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(effects).toBe(0);
  });
});
