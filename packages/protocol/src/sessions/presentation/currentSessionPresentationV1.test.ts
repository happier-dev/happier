import { describe, expect, it } from 'vitest';

import {
  CurrentSessionPresentationAckV1Schema,
  CurrentSessionPresentationBindV1Schema,
  CurrentSessionPresentationStateV1Schema,
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

  it('requires exact focus and draft revision facts when a client binds', () => {
    expect(CurrentSessionPresentationBindV1Schema.parse({
      clientId: 'client-1', focused: true, draftRevision: 11,
    })).toEqual({ clientId: 'client-1', focused: true, draftRevision: 11 });
    expect(CurrentSessionPresentationBindV1Schema.safeParse({
      clientId: 'client-1', focused: 'yes', draftRevision: 11,
    }).success).toBe(false);
  });
});
