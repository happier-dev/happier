import { describe, expect, it } from 'vitest';

import {
  CurrentSessionPresentationAckV1Schema,
  CurrentSessionPresentationBindV1Schema,
  CurrentSessionPresentationBindResultV1Schema,
  CurrentSessionPresentationIntentV1Schema,
  CurrentSessionPresentationAuthorIntentV1Schema,
  CurrentSessionPresentationActionInputV1Schema,
  CurrentSessionPresentationStateV1Schema,
  CurrentSessionPresentationUnbindV1Schema,
  currentSessionPresentationEntryIdentityV1,
} from './currentSessionPresentationV1.js';

const owner = (pluginId: string, invocationId: string) => ({
  pluginId,
  contributionId: 'session-presentation',
  generationId: `immutable-${pluginId}`,
  invocationId,
  sessionId: 'session-1',
});

describe('current-session presentation wire contract', () => {
  it('admits only semantic Computer/Browser viewer operations through both transported unions', () => {
    const intents = [
      { kind: 'viewer.open', source: 'computer' },
      { kind: 'viewer.open', source: 'browser' },
      { kind: 'viewer.close' },
      { kind: 'viewer.source.select', source: 'computer' },
      { kind: 'viewer.source.select', source: 'browser' },
      { kind: 'viewer.expand' },
      { kind: 'viewer.restore' },
    ];
    for (const schema of [CurrentSessionPresentationIntentV1Schema, CurrentSessionPresentationAuthorIntentV1Schema]) {
      for (const intent of intents) {
        expect(schema.parse(intent)).toEqual(intent);
        for (const fields of [
          { sessionId: 'another-session' }, { clientId: 'another-client' },
          { targetId: 'another-target' }, { operationId: 'author-operation' },
          { corner: 'br' }, { width: 400 }, { dock: true }, { size: { width: 400 } },
        ]) expect(schema.safeParse({ ...intent, ...fields }).success).toBe(false);
      }
      for (const intent of [
        { kind: 'viewer.float' }, { kind: 'viewer.dock' },
        { kind: 'viewer.corner.set', corner: 'br' }, { kind: 'viewer.size.set', width: 400 },
        { kind: 'viewer.open', source: 'capture' }, { kind: 'viewer.source.select' },
      ]) expect(schema.safeParse(intent).success).toBe(false);
    }
  });
  it('keeps widget instance mutations behind qualified widget Actions, not author presentation', () => {
    const instance = { v: 1, id: 'copy-a', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} };
    const intents = [
      { kind: 'companion.item.add', item: { kind: 'instance', instance } },
      { kind: 'companion.item.remove', item: { kind: 'builtin', id: 'session_summary' }, expectedInstance: instance },
      { kind: 'companion.instance.inputs.set', instanceId: 'copy-a', bindings: {} },
      { kind: 'companion.instance.inputs.reset', instanceId: 'copy-a' },
      { kind: 'companion.instance.rename', instanceId: 'copy-a', displayName: 'Checks' },
    ];
    for (const intent of intents) {
      expect(CurrentSessionPresentationIntentV1Schema.safeParse(intent).success).toBe(true);
      expect(CurrentSessionPresentationActionInputV1Schema.safeParse({ intent }).success).toBe(false);
    }
    expect(CurrentSessionPresentationActionInputV1Schema.safeParse({ intent: {
      kind: 'companion.item.add', item: { kind: 'builtin', id: 'session_summary' },
    } }).success).toBe(true);
  });
  it('admits a closed conditional instance-removal snapshot through the existing intent', () => {
    const instance = { v: 1, id: 'copy-a', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} };
    const intent = { kind: 'companion.item.remove', item: { kind: 'instance', instance }, expectedInstance: instance,
      expectedPresentation: { frameStyle: null, nativeIndex: 1 } };
    expect(CurrentSessionPresentationIntentV1Schema.safeParse(intent).success).toBe(true);
    expect(CurrentSessionPresentationIntentV1Schema.safeParse({ ...intent,
      expectedPresentation: { ...intent.expectedPresentation, clientId: 'forged-authority' } }).success).toBe(false);
  });
  it('keeps bind refusal and exact retirement closed and typed', () => {
    expect(CurrentSessionPresentationBindResultV1Schema.parse({
      status: 'rejected',
      reason: 'notCurrent',
    })).toEqual({ status: 'rejected', reason: 'notCurrent' });
    expect(CurrentSessionPresentationBindResultV1Schema.safeParse({
      status: 'rejected',
      reason: 'notCurrent',
      clientId: 'caller-authored-authority',
    }).success).toBe(false);
    expect(CurrentSessionPresentationUnbindV1Schema.parse({ clientId: 'client-1' }))
      .toEqual({ clientId: 'client-1' });
    expect(CurrentSessionPresentationUnbindV1Schema.safeParse({
      clientId: 'client-1',
      connectionId: 'caller-authored-origin',
    }).success).toBe(false);
  });

  it('accepts every existing exact presentation boundary and rejects each +1 case', () => {
    const exactText = 'x'.repeat(16_384);
    const exact = {
      v: 1,
      hostNonce: 'host-1',
      revision: 1,
      statuses: Array.from({ length: 32 }, (_, index) => ({
        localKey: `status-${index}`,
        text: exactText,
        owner: owner('acme.status', `invocation-status-${index}`),
        revision: index,
      })),
      widgets: Array.from({ length: 16 }, (_, index) => ({
        localKey: `widget-${index}`,
        placement: 'beforeComposer' as const,
        lines: Array.from({ length: 32 }, () => exactText),
        owner: owner('acme.widget', `invocation-widget-${index}`),
        revision: index,
      })),
      command: {
        id: 'notify-1',
        clientId: 'client-1',
        kind: 'notify' as const,
        message: exactText,
        severity: 'info' as const,
      },
    };

    expect(CurrentSessionPresentationStateV1Schema.safeParse(exact).success).toBe(true);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...exact,
      statuses: [...exact.statuses, exact.statuses[0]],
    }).success).toBe(false);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...exact,
      widgets: [...exact.widgets, exact.widgets[0]],
    }).success).toBe(false);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...exact,
      widgets: [{ ...exact.widgets[0], lines: [...exact.widgets[0].lines, exactText] }],
    }).success).toBe(false);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...exact,
      statuses: [{ ...exact.statuses[0], text: `${exactText}x` }],
    }).success).toBe(false);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...exact,
      command: { ...exact.command, message: `${exactText}x` },
    }).success).toBe(false);
  });

  it('accepts a bounded reconnect snapshot and rejects unknown fields', () => {
    const snapshot = {
      v: 1,
      hostNonce: 'host-1',
      revision: 3,
      statuses: [{ localKey: 'build', text: 'Running', owner: owner('acme.status', 'status-a'), revision: 2 }],
      widgets: [{ localKey: 'checks', placement: 'beforeComposer', lines: ['Tests: 4/5'], owner: owner('acme.widget', 'widget-a'), revision: 3 }],
    };

    expect(CurrentSessionPresentationStateV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({ ...snapshot, receipts: [] }).success).toBe(false);
  });

  it('qualifies status and widget local keys by their exact host owner', () => {
    const alpha = owner('acme.alpha', 'invocation-a');
    const beta = owner('acme.beta', 'invocation-b');
    const snapshot = {
      v: 1,
      hostNonce: 'host-1',
      revision: 2,
      statuses: [
        { localKey: 'progress', text: 'Alpha', owner: alpha, revision: 1 },
        { localKey: 'progress', text: 'Beta', owner: beta, revision: 2 },
      ],
      widgets: [
        { localKey: 'progress', placement: 'beforeComposer' as const, lines: ['Alpha'], owner: alpha, revision: 1 },
        { localKey: 'progress', placement: 'beforeComposer' as const, lines: ['Beta'], owner: beta, revision: 2 },
      ],
    };

    expect(CurrentSessionPresentationStateV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(currentSessionPresentationEntryIdentityV1(alpha, 'progress'))
      .not.toBe(currentSessionPresentationEntryIdentityV1(beta, 'progress'));
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...snapshot,
      statuses: [...snapshot.statuses, { localKey: 'progress', text: 'again', owner: alpha, revision: 3 }],
    }).success).toBe(false);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...snapshot,
      widgets: [{ localKey: 'progress', placement: 'beforeComposer', lines: ['legacy'], revision: 1 }],
    }).success).toBe(false);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...snapshot,
      statuses: [{ key: 'legacy', text: 'must not be caller-qualified', owner: alpha, revision: 1 }],
    }).success).toBe(false);
  });

  it('rejects the producerless actionable presentation arm', () => {
    const snapshot = {
      v: 1,
      hostNonce: 'host-1',
      revision: 4,
      statuses: [],
      widgets: [],
      actionable: {
        key: 'connect-account',
        text: 'Connect an account to continue',
        attentionReason: 'action_required' as const,
        command: {
          kind: 'executeAction' as const,
          action: { pluginId: 'acme.channels', localId: 'connect-account' },
        },
        owner: {
          pluginId: 'acme.channels',
          contributionId: 'session-observer',
          generationId: 'generation-1',
          invocationId: 'invocation-1',
          sessionId: 'session-1',
        },
        revision: 4,
      },
    };

    expect(CurrentSessionPresentationStateV1Schema.safeParse(snapshot).success).toBe(false);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...snapshot,
      actionable: {
        ...snapshot.actionable,
        command: {
          kind: 'openSurface',
          destination: { pluginId: 'acme.channels', localId: 'connection-settings' },
          input: { source: 'session-presentation' },
          subPath: 'account/settings',
          instanceKey: 'connection-settings',
        },
      },
    }).success).toBe(false);
  });

  it('strictly validates targeted one-shot commands and client acknowledgements', () => {
    const command = {
      v: 1,
      hostNonce: 'host-1',
      revision: 4,
      statuses: [],
      widgets: [],
      command: {
        id: 'op-1',
        clientId: 'client-1',
        kind: 'composer.replace',
        transaction: {
          expectedRevision: 7,
          operations: [{ kind: 'text.set', text: 'replacement' }],
        },
      },
    };
    expect(CurrentSessionPresentationStateV1Schema.parse(command)).toEqual(command);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...command,
      command: {
        ...command.command,
        transaction: {
          ...command.command.transaction,
          operations: [
            ...command.command.transaction.operations,
            { kind: 'text.clear' },
          ],
        },
      },
    }).success).toBe(false);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...command,
      command: { ...command.command, text: 'replacement', expectedDraftRevision: 7 },
    }).success).toBe(false);

    expect(CurrentSessionPresentationAckV1Schema.parse({
      hostNonce: 'host-1', clientId: 'client-1', commandId: 'op-1', result: { status: 'applied', revision: 8 },
    })).toBeTruthy();
    expect(CurrentSessionPresentationAckV1Schema.safeParse({
      hostNonce: 'host-1', clientId: 'client-2', commandId: 'op-1', status: 'applied', draftRevision: 8,
    }).success).toBe(false);
    expect(CurrentSessionPresentationAckV1Schema.safeParse({
      hostNonce: 'host-1', clientId: 'client-2', commandId: 'op-1', result: { status: 'applied', revision: 8 }, replay: true,
    }).success).toBe(false);
  });

  it('admits only the closed Board and Companion presentation intents', () => {
    const intents = [
      { kind: 'chat.return' },
      { kind: 'board.open', mode: 'beside_chat' },
      { kind: 'board.view.select', viewId: 'overview' },
      { kind: 'board.item.reveal', widgetId: 'note-1', viewId: 'overview' },
      { kind: 'companion.show' },
      { kind: 'companion.hide' },
      { kind: 'companion.item.add', item: { kind: 'builtin', id: 'session_summary' }, index: 0 },
      { kind: 'companion.item.add', item: { kind: 'builtin', id: 'agent_plan' } },
      { kind: 'companion.item.add', item: { kind: 'builtin', id: 'changes' } },
      { kind: 'companion.item.add', item: { kind: 'builtin', id: 'local_services' } },
      { kind: 'companion.item.add', item: { kind: 'pane', paneId: 'git', frameStyle: 'plain' } },
      { kind: 'companion.item.add', item: { kind: 'instance', instance: { v: 1, id: 'copy-a', definition: { kind: 'installed', surface: { pluginId: 'acme.tools', localId: 'glance' } }, bindings: {} } } },
      { kind: 'companion.instance.inputs.set', instanceId: 'copy-a', bindings: { session: { kind: 'context', slot: 'session' } } },
      { kind: 'companion.instance.inputs.reset', instanceId: 'copy-a' },
      { kind: 'companion.instance.rename', instanceId: 'copy-a', displayName: 'Pinned checks' },
      { kind: 'companion.item.frameStyle.set', item: { kind: 'pane', paneId: 'git' }, frameStyle: 'card' },
      { kind: 'companion.item.frameStyle.set', item: { kind: 'widget', widgetId: 'note-1' }, frameStyle: null },
      { kind: 'companion.item.remove', item: { kind: 'widget', widgetId: 'note-1' } },
      { kind: 'companion.item.move', item: { kind: 'widget', widgetId: 'note-1' }, toIndex: 1 },
      { kind: 'companion.edge.set', edge: 'leading' },
      { kind: 'companion.collapse.set', collapsed: true },
      { kind: 'companion.density.set', density: 'comfortable' },
      { kind: 'companion.open_full' },
    ];
    for (const intent of intents) {
      expect(CurrentSessionPresentationIntentV1Schema.safeParse(intent).success).toBe(true);
    }
    // The host clamps a requested position against the current local list. The
    // wire therefore accepts every non-negative safe integer instead of
    // inventing a product item-count ceiling at this transport boundary.
    expect(CurrentSessionPresentationIntentV1Schema.safeParse({
      kind: 'companion.item.move',
      item: { kind: 'widget', widgetId: 'note-1' },
      toIndex: 10_001,
    }).success).toBe(true);
    expect(CurrentSessionPresentationIntentV1Schema.safeParse({ kind: 'board.item.delete', widgetId: 'note-1' }).success).toBe(false);
    expect(CurrentSessionPresentationIntentV1Schema.safeParse({ kind: 'board.open', mode: 'overlay' }).success).toBe(false);
    expect(CurrentSessionPresentationIntentV1Schema.safeParse({ kind: 'companion.show', sessionId: 'caller-selected' }).success).toBe(false);
    expect(CurrentSessionPresentationIntentV1Schema.safeParse({ kind: 'companion.item.add', item: { kind: 'plugin', surface: { pluginId: 'acme.tools', localId: 'glance' } } }).success).toBe(false);

    // Item order is a position in the current preference, not a product quota.
    // The controller clamps it to the actual list, so the wire must not invent a
    // maximum item count that would reject an otherwise harmless move request.
    expect(CurrentSessionPresentationIntentV1Schema.safeParse({
      kind: 'companion.item.move',
      item: { kind: 'widget', widgetId: 'note-1' },
      toIndex: Number.MAX_SAFE_INTEGER,
    }).success).toBe(true);

    const state = {
      v: 1,
      hostNonce: 'host-1',
      revision: 5,
      statuses: [],
      widgets: [],
      command: {
        id: 'present-1',
        clientId: 'client-1',
        kind: 'presentation.apply',
        intent: { kind: 'board.item.reveal', widgetId: 'note-1' },
      },
    };
    expect(CurrentSessionPresentationStateV1Schema.parse(state)).toEqual(state);
    expect(CurrentSessionPresentationAckV1Schema.safeParse({
      hostNonce: 'host-1', clientId: 'client-1', commandId: 'present-1', result: { status: 'notCurrent' },
    }).success).toBe(true);
  });

  it('requires exact focus and draft revision facts when a client binds', () => {
    expect(CurrentSessionPresentationBindV1Schema.parse({
      clientId: 'client-1', focused: true, draftRevision: 11,
    })).toEqual({ clientId: 'client-1', focused: true, draftRevision: 11 });
    expect(CurrentSessionPresentationBindV1Schema.safeParse({
      clientId: 'client-1', focused: 'yes', draftRevision: 11,
    }).success).toBe(false);
  });
});
