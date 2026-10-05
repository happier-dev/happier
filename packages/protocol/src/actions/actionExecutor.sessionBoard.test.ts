import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import { SessionBoardLayoutUpdateInputV1Schema } from '../sessions/board/actions.js';
import { applySessionBoardLayoutOperationV1 } from '../sessions/board/layoutOperations.js';
import type { SessionBoardLayoutV1 } from '../sessions/board/layout.js';

const revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
const item = {
  v: 1,
  title: 'Note',
  frame: 'card',
  height: { mode: 'auto', fallback: 'regular' },
  source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: '# Note' } } },
} as const;

const upsertInput = {
  itemId: 'note',
  expectedItemRevision: null,
  item,
  placement: { tabId: 'overview', tabTitle: 'Overview', width: 'wide' },
} as const;

function mutationResult(operation: 'upsert_item' | 'remove_item' | 'update_layout') {
  const result = operation === 'upsert_item'
    ? { operation, itemId: 'note', outcome: 'created', itemRevision: revision, layoutRevision: revision }
    : operation === 'remove_item'
      ? { operation, itemId: 'note', outcome: 'removed', layoutRevision: revision }
      : { operation, outcome: 'created', layoutRevision: revision };
  return {
    v: 1,
    serverId: 'home-1',
    sessionId: 'session-1',
    result,
    destination: operation === 'remove_item' ? null : { tabId: 'overview', width: 'wide' },
    ...(operation === 'upsert_item' ? { preview: { title: 'Note', sourceKind: 'declarative' } } : {}),
  };
}

describe('createActionExecutor (Session Board family)', () => {
  it.each(['agent', 'ui'] as const)('requires approval for shared layout edits through both %s fronts, while a policy waiver reaches the same writer', async surface => {
    let document: SessionBoardLayoutV1 = { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'copy', width: 'wide' }] }] };
    const original = document;
    // The sealed Board persistence transport is the boundary; layout application stays real.
    const executor = createActionExecutor({
      widgetAccountScope: () => ({ serverId: 'home-1', accountId: 'account' }),
      isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id,
        context.actionsSettings ?? normalizeActionsSettingsV1({ v: 1 }), context, undefined, undefined, input),
      sessionBoardAction: async ({ actionId, input }) => {
        if (actionId === 'session.board.get') return { v: 1, serverId: 'home-1', sessionId: 'session-1',
          capabilities: { readTranscript: true, editSessionRecords: true }, layout: { revision, document },
          items: [{ itemId: 'copy', revision, title: 'Copy', sourceKind: 'widget', item: { ...item, title: 'Copy',
            source: { kind: 'widget', instance: { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } } } }],
          incomplete: false, page: { cursor: null, hasNext: false } };
        const command = SessionBoardLayoutUpdateInputV1Schema.parse(input);
        const applied = applySessionBoardLayoutOperationV1(document, command.operation);
        if (!applied.ok) throw new Error(applied.error);
        document = applied.layout;
        return { v: 1, serverId: 'home-1', sessionId: 'session-1',
          result: { operation: 'update_layout', outcome: 'updated', layoutRevision: revision },
          destination: { tabId: 'overview', width: 'wide', frameStyle: document.tabs[0]?.items[0]?.frameStyle } };
      },
    });
    const context = { surface, authority: surface === 'ui' ? 'present_user' as const : 'account_automation' as const,
      serverId: 'home-1', defaultSessionId: 'session-1' };
    const domainInput = { sessionId: 'session-1', expectedLayoutRevision: revision,
      operation: { op: 'item.frameStyle' as const, tabId: 'overview', itemId: 'copy', frameStyle: 'plain' as const } };
    const widgetInput = { ref: { surface: { serverId: 'home-1', accountId: 'account',
      owner: { kind: 'sessionBoard' as const, sessionId: 'session-1' } }, instanceId: 'copy' }, frameStyle: 'plain' as const };
    expect(await executor.execute('widgets.instance.frame.set', widgetInput, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(document).toEqual(original);
    expect(await executor.execute('session.board.layout.update', domainInput, context))
      .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(document).toEqual(original);
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
      'session.board.layout.update': [surface], 'widgets.instance.frame.set': [surface],
    } });
    expect(await executor.execute('session.board.layout.update', domainInput, { ...context, actionsSettings }))
      .toMatchObject({ ok: true });
    expect(document.tabs[0]?.items[0]?.frameStyle).toBe('plain');
    expect(await executor.execute('widgets.instance.frame.set', { ...widgetInput, frameStyle: 'card' }, { ...context, actionsSettings }))
      .toMatchObject({ ok: true });
    expect(document.tabs[0]?.items[0]?.frameStyle).toBe('card');
  });

  it('dispatches every Board intent through the one family port with host-stamped context', async () => {
    const controller = new AbortController();
    const sessionBoardAction = vi.fn(async () => mutationResult('upsert_item'));
    const executor = createActionExecutor({
      sessionBoardAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.board.item.upsert', upsertInput, {
      surface: 'agent',
      serverId: 'home-1',
      defaultSessionId: 'session-1',
      signal: controller.signal,
    })).resolves.toEqual({ ok: true, result: mutationResult('upsert_item') });

    expect(sessionBoardAction).toHaveBeenCalledTimes(1);
    const call = sessionBoardAction.mock.calls[0]?.[0] as unknown as {
      actionId: string;
      input: unknown;
      context: { surface?: string | null; defaultSessionId?: string | null };
      signal?: AbortSignal;
    };
    expect(call.actionId).toBe('session.board.item.upsert');
    expect(call.input).toEqual(upsertInput);
    expect(call.context.surface).toBe('agent');
    expect(call.context.defaultSessionId).toBe('session-1');
    expect(call.signal).toBe(controller.signal);
  });

  it.each(['agent', 'mcp'] as const)(
    'rejects an explicit different Session before dispatch when a %s caller is current-Session scoped',
    async (surface) => {
    const interceptActionExecution = vi.fn(async (args: Readonly<{ input: unknown }>) => ({
      status: 'continue' as const,
      input: args.input,
    }));
    const sessionBoardAction = vi.fn(async (args: Readonly<{
      input: Readonly<{ sessionId?: string }>;
      context: Readonly<{ defaultSessionId?: string | null }>;
    }>) => ({
      ...mutationResult('upsert_item'),
      sessionId: args.input.sessionId ?? args.context.defaultSessionId ?? 'missing-session',
    }));
    const executor = createActionExecutor({
      sessionBoardAction,
      interceptActionExecution,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    const context = {
      surface,
      authority: 'account_automation',
      serverId: 'home-1',
      defaultSessionId: 'session-1',
      sessionListAccess: 'current_session',
    } as const;

    await expect(executor.execute('session.board.item.upsert', {
      ...upsertInput,
      sessionId: 'session-2',
    }, context)).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.board.item.upsert',
    });
    expect(sessionBoardAction).not.toHaveBeenCalled();
    expect(interceptActionExecution).not.toHaveBeenCalled();

    await expect(executor.execute('session.board.item.upsert', upsertInput, context))
      .resolves.toMatchObject({ ok: true });
    await expect(executor.execute('session.board.item.upsert', {
      ...upsertInput,
      sessionId: 'session-1',
    }, context)).resolves.toMatchObject({ ok: true });
    expect(sessionBoardAction).toHaveBeenCalledTimes(2);
    expect(interceptActionExecution).toHaveBeenCalledTimes(2);
    },
  );

  it('rejects an Agent-explicit different Session even when the host scope marker is absent', async () => {
    const interceptActionExecution = vi.fn(async (args: Readonly<{ input: unknown }>) => ({
      status: 'continue' as const,
      input: args.input,
    }));
    const sessionBoardAction = vi.fn(async () => mutationResult('upsert_item'));
    const executor = createActionExecutor({
      sessionBoardAction,
      interceptActionExecution,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.board.item.upsert', {
      ...upsertInput,
      sessionId: 'session-2',
    }, {
      surface: 'agent',
      authority: 'account_automation',
      serverId: 'home-1',
      defaultSessionId: 'session-1',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.board.item.upsert',
    });
    expect(sessionBoardAction).not.toHaveBeenCalled();
    expect(interceptActionExecution).not.toHaveBeenCalled();
  });

  it.each([
    ['ui', 'present_user'],
    ['cli', 'present_user'],
    ['api', 'account_automation'],
  ] as const)('preserves explicit Session targeting for the %s surface', async (surface, authority) => {
    const sessionBoardAction = vi.fn(async (args: Readonly<{
      input: Readonly<{ sessionId?: string }>;
      context: Readonly<{ defaultSessionId?: string | null }>;
    }>) => ({
      ...mutationResult('upsert_item'),
      sessionId: args.input.sessionId ?? args.context.defaultSessionId ?? 'missing-session',
    }));
    const executor = createActionExecutor({
      sessionBoardAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.board.item.upsert', {
      ...upsertInput,
      sessionId: 'session-2',
    }, {
      surface,
      authority,
      serverId: 'home-1',
      defaultSessionId: 'session-1',
      sessionListAccess: 'current_session',
    })).resolves.toMatchObject({
      ok: true,
      result: { serverId: 'home-1', sessionId: 'session-2' },
    });
    expect(sessionBoardAction).toHaveBeenCalledTimes(1);
  });

  it('returns the shared typed unavailable result when the Board family producer is absent', async () => {
    const executor = createActionExecutor({ isActionApprovalRequired: () => false } as unknown as ActionExecutorDeps);
    for (const [actionId, input] of [
      ['session.board.get', {}],
      ['session.board.item.upsert', upsertInput],
      ['session.board.item.remove', { itemId: 'note', expectedItemRevision: revision, expectedLayoutRevision: revision }],
      ['session.board.layout.update', { expectedLayoutRevision: null, operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' } }],
    ] as const) {
      await expect(executor.execute(actionId, input, { surface: 'agent' })).resolves.toEqual({
        ok: false,
        errorCode: 'unsupported_action',
        error: `unsupported_action:${actionId}`,
      });
    }
  });

  it('rejects malformed Board input before the family port observes it', async () => {
    const sessionBoardAction = vi.fn(async () => mutationResult('upsert_item'));
    const executor = createActionExecutor({
      sessionBoardAction,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    for (const input of [
      { itemId: 'note', expectedItemRevision: null, item },
      { itemId: 'note', expectedItemRevision: revision, item, serverId: 'home-2' },
      { itemId: 'note', expectedItemRevision: 'not-a-revision', item },
    ]) {
      await expect(executor.execute('session.board.item.upsert', input, { surface: 'agent' })).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'invalid_parameters',
      });
    }
    expect(sessionBoardAction).not.toHaveBeenCalled();
  });

  it('refuses a family result that is not the canonical Board Action result', async () => {
    const executor = createActionExecutor({
      sessionBoardAction: vi.fn(async () => ({
        ...mutationResult('remove_item'),
        destination: { tabId: 'overview', width: 'wide' },
      })),
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.board.item.remove', {
      itemId: 'note',
      expectedItemRevision: revision,
      expectedLayoutRevision: revision,
    }, { surface: 'agent' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    });
  });

  it('refuses a well-shaped result for a different Board request', async () => {
    const executor = createActionExecutor({
      sessionBoardAction: vi.fn(async () => mutationResult('remove_item')),
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.board.layout.update', {
      expectedLayoutRevision: null,
      operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
    }, { surface: 'agent' })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_action_output',
      error: 'invalid_action_output',
    });
  });

  it('refuses a result attributed to a different Session than the host-bound request', async () => {
    const executor = createActionExecutor({
      sessionBoardAction: vi.fn(async () => ({ ...mutationResult('upsert_item'), sessionId: 'other-session' })),
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute('session.board.item.upsert', upsertInput, {
      surface: 'agent', defaultSessionId: 'session-1',
    })).resolves.toEqual({
      ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output',
    });
  });

  it('refuses malformed or request-mismatched Board failure envelopes', async () => {
    for (const failure of [
      { ok: false, errorCode: 'unknown_board_error', error: 'unknown_board_error' },
      { ok: false, errorCode: 'feature_disabled', error: 'feature_disabled', details: { operation: 'session.board.get' } },
      { ok: false, errorCode: 'session_board_forbidden', error: 'session_board_forbidden', details: { currentLayoutRevision: revision } },
    ]) {
      const executor = createActionExecutor({
        sessionBoardAction: vi.fn(async () => failure),
        isActionApprovalRequired: () => false,
      } as unknown as ActionExecutorDeps);
      await expect(executor.execute('session.board.layout.update', {
        expectedLayoutRevision: null,
        operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
      }, { surface: 'agent' })).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_action_output',
        error: 'invalid_action_output',
      });
    }
  });

  it('propagates a typed Board failure envelope without wrapping it as a success', async () => {
    const executor = createActionExecutor({
      sessionBoardAction: vi.fn(async () => ({
        ok: false,
        errorCode: 'session_board_revision_conflict',
        error: 'session_board_revision_conflict',
        details: { currentLayoutRevision: revision },
      })),
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.board.layout.update', {
      expectedLayoutRevision: null,
      operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
    }, { surface: 'agent' })).resolves.toEqual({
      ok: false,
      errorCode: 'session_board_revision_conflict',
      error: 'session_board_revision_conflict',
      details: { currentLayoutRevision: revision },
    });
  });

  it('preserves Board recovery evidence only through the canonical failure details', async () => {
    const requestBody = JSON.stringify({
      operation: 'upsert_item',
      itemId: 'note',
      expectedItemRevision: null,
      itemContent: { t: 'plain', v: item },
      placement: {
        expectedLayoutRevision: null,
        layoutContent: {
          t: 'plain',
          v: {
            v: 1,
            tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'note', width: 'wide' }] }],
          },
        },
      },
    });
    const mutationRequest = JSON.parse(requestBody);
    const recovery = {
      v: 1 as const,
      actionId: 'session.board.item.upsert' as const,
      serverId: 'home-1',
      sessionId: 'session-1',
      requestBody,
      mutationRequest,
      intent: upsertInput,
    };
    const executor = createActionExecutor({
      sessionBoardAction: vi.fn(async () => ({
        ok: false,
        errorCode: 'outcome_unknown',
        error: 'outcome_unknown',
        details: { recovery },
        requestBody: 'must-not-survive-at-top-level',
        intent: { itemId: 'must-not-survive-at-top-level' },
      })),
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.board.item.upsert', upsertInput, {
      surface: 'agent',
      serverId: 'home-1',
      defaultSessionId: 'session-1',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'outcome_unknown',
      error: 'outcome_unknown',
      details: { recovery },
    });
  });

  it('routes destructive Board removal through the shared approval owner before the family port runs', async () => {
    const sessionBoardAction = vi.fn(async (args: Readonly<{ actionId: string }>) => (
      mutationResult(args.actionId === 'session.board.item.remove' ? 'remove_item' : 'update_layout')
    ));
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-1' }));
    const executor = createActionExecutor({
      sessionBoardAction,
      approvalsCreate,
    } as unknown as ActionExecutorDeps);

    const removeInput = {
      itemId: 'note',
      expectedItemRevision: revision,
      expectedLayoutRevision: revision,
    } as const;

    // No wired approval policy still applies the shared danger floor on `agent`.
    await expect(executor.execute('session.board.item.remove', removeInput, {
      surface: 'agent',
      serverId: 'home-1',
      actionRequestId: 'board-remove-1',
      runtimeAccountId: 'account-1',
      defaultSessionId: 'session-1',
    })).resolves.toEqual({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'session.board.item.remove' },
    });
    expect(approvalsCreate).toHaveBeenCalledTimes(1);
    expect(sessionBoardAction).not.toHaveBeenCalled();

    // Shared layout changes use that same configurable approval owner.
    await expect(executor.execute('session.board.layout.update', {
      expectedLayoutRevision: null,
      operation: { op: 'tab.create', tabId: 'overview', title: 'Overview' },
    }, { surface: 'agent', serverId: 'home-1', defaultSessionId: 'session-1',
      actionRequestId: 'board-layout-1', runtimeAccountId: 'account-1' })).resolves.toMatchObject({ ok: true,
      result: { kind: 'approval_request_created', actionId: 'session.board.layout.update' } });
    expect(approvalsCreate).toHaveBeenCalledTimes(2);
    expect(sessionBoardAction).not.toHaveBeenCalled();
  });

  it('keeps require and skip confirmation policy inside the shared Action executor', async () => {
    const removeInput = {
      itemId: 'note',
      expectedItemRevision: revision,
      expectedLayoutRevision: revision,
    } as const;
    const context = {
      surface: 'agent' as const,
      serverId: 'home-1',
      actionRequestId: 'board-remove-policy-1',
      runtimeAccountId: 'account-1',
      defaultSessionId: 'session-1',
    };

    const requiredBoardAction = vi.fn(async () => mutationResult('remove_item'));
    const requiredApprovalsCreate = vi.fn(async () => ({ artifactId: 'approval-required-1' }));
    const requiredExecutor = createActionExecutor({
      sessionBoardAction: requiredBoardAction,
      approvalsCreate: requiredApprovalsCreate,
      isActionApprovalRequired: () => true,
    } as unknown as ActionExecutorDeps);

    await expect(requiredExecutor.execute('session.board.item.remove', removeInput, context)).resolves.toEqual({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'approval-required-1',
        actionId: 'session.board.item.remove',
      },
    });
    expect(requiredApprovalsCreate).toHaveBeenCalledTimes(1);
    expect(requiredBoardAction).not.toHaveBeenCalled();

    const skippedBoardAction = vi.fn(async () => mutationResult('remove_item'));
    const skippedApprovalsCreate = vi.fn(async () => ({ artifactId: 'must-not-be-created' }));
    const skippedExecutor = createActionExecutor({
      sessionBoardAction: skippedBoardAction,
      approvalsCreate: skippedApprovalsCreate,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(skippedExecutor.execute('session.board.item.remove', removeInput, {
      ...context,
      actionRequestId: 'board-remove-policy-2',
    })).resolves.toEqual({ ok: true, result: mutationResult('remove_item') });
    expect(skippedApprovalsCreate).not.toHaveBeenCalled();
    expect(skippedBoardAction).toHaveBeenCalledTimes(1);
  });

  it('keeps a disabled Board Action disabled on its surface', async () => {
    const sessionBoardAction = vi.fn(async () => mutationResult('upsert_item'));
    const executor = createActionExecutor({
      sessionBoardAction,
      isActionEnabled: (actionId) => actionId !== 'session.board.item.upsert',
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    const outcome = await executor.execute('session.board.item.upsert', upsertInput, { surface: 'agent' });
    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
    });
    expect(sessionBoardAction).not.toHaveBeenCalled();
  });
});
