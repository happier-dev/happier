import { describe, expect, it } from 'vitest';

import {
  CurrentSessionPresentationAckV1Schema,
  CurrentSessionPresentationBindV1Schema,
  CurrentSessionPresentationStateV1Schema,
} from './currentSessionPresentationV1.js';

describe('current-session presentation wire contract', () => {
  it('accepts every existing exact presentation boundary and rejects each +1 case', () => {
    const exactText = 'x'.repeat(16_384);
    const exact = {
      v: 1,
      hostNonce: 'host-1',
      revision: 1,
      statuses: Array.from({ length: 32 }, (_, index) => ({
        key: `status-${index}`,
        text: exactText,
        revision: index,
      })),
      widgets: Array.from({ length: 16 }, (_, index) => ({
        key: `widget-${index}`,
        placement: 'beforeComposer' as const,
        lines: Array.from({ length: 32 }, () => exactText),
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
      statuses: [{ key: 'build', text: 'Running', revision: 2 }],
      widgets: [{ key: 'checks', placement: 'beforeComposer', lines: ['Tests: 4/5'], revision: 3 }],
    };

    expect(CurrentSessionPresentationStateV1Schema.parse(snapshot)).toEqual(snapshot);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({ ...snapshot, receipts: [] }).success).toBe(false);
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
        text: 'replacement',
        expectedDraftRevision: 7,
      },
    };
    expect(CurrentSessionPresentationStateV1Schema.parse(command)).toEqual(command);
    expect(CurrentSessionPresentationStateV1Schema.safeParse({
      ...command,
      command: { ...command.command, expectedSessionId: 'wrong-owner' },
    }).success).toBe(false);

    expect(CurrentSessionPresentationAckV1Schema.parse({
      hostNonce: 'host-1', clientId: 'client-1', commandId: 'op-1', status: 'applied', draftRevision: 8,
    })).toBeTruthy();
    expect(CurrentSessionPresentationAckV1Schema.safeParse({
      hostNonce: 'host-1', clientId: 'client-2', commandId: 'op-1', status: 'applied', replay: true,
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
