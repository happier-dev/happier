import { describe, expect, it } from 'vitest';

import { MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES } from '@happier-dev/channels-protocol';

import {
  classifyConversationCommand,
  createConversationNewSessionCreationKey,
  normalizeConversationPairingToken,
} from './commands.js';

describe('Channels command evidence', () => {
  it('classifies only the closed command grammar after Unicode whitespace normalization', () => {
    expect(classifyConversationCommand('/pair abcd0il2')).toEqual({
      kind: 'pair',
      token: 'ABCD0112',
    });
    expect(classifyConversationCommand('/start ABCD2345')).toEqual({
      kind: 'pair',
      token: 'ABCD2345',
    });
    expect(classifyConversationCommand('/allow request-1')).toEqual({
      kind: 'approve',
      requestId: 'request-1',
      decision: 'allow',
      scope: 'request',
    });
    expect(classifyConversationCommand('/allow\u00A0request-1\u2003session')).toEqual({
      kind: 'approve',
      requestId: 'request-1',
      decision: 'allow',
      scope: 'session',
    });
    expect(classifyConversationCommand('/deny request-1')).toEqual({
      kind: 'approve',
      requestId: 'request-1',
      decision: 'deny',
      scope: 'request',
    });
    // Preserve the JSON answer values exactly. The canonical Session owner
    // resolves these displayed labels/custom values against its live request;
    // normalizing this payload would silently change a legitimate free-text
    // answer before that owner sees it.
    expect(classifyConversationCommand(
      '/answer input-1 [{"questionIndex":0,"values":["Other"]},{"questionIndex":1,"values":["A custom  note"]}]',
    )).toEqual({
      kind: 'userActionAnswer',
      requestId: 'input-1',
      answers: [
        { questionIndex: 0, values: ['Other'] },
        { questionIndex: 1, values: ['A custom  note'] },
      ],
    });
    expect(classifyConversationCommand('/new  investigate   this')).toEqual({
      kind: 'newSession',
      initialPrompt: 'investigate this',
    });
    expect(classifyConversationCommand('/new')).toEqual({ kind: 'newSession' });
    expect(classifyConversationCommand('/unknown command')).toEqual({ kind: 'ordinaryText' });
  });

  it('never upgrades malformed recognized commands into ordinary or session-scope authority', () => {
    expect(classifyConversationCommand('/pair ABCD2345 extra')).toEqual({
      kind: 'malformedCommand',
      command: 'pair',
    });
    expect(classifyConversationCommand('/allow request-1 request session')).toEqual({
      kind: 'malformedCommand',
      command: 'approve',
    });
    expect(classifyConversationCommand('/deny request-1 session')).toEqual({
      kind: 'malformedCommand',
      command: 'approve',
    });
    expect(classifyConversationCommand('/answer input-1 not-json')).toEqual({
      kind: 'malformedCommand',
      command: 'answer',
    });
    expect(classifyConversationCommand('/answer input-1 [{"questionIndex":0}]')).toEqual({
      kind: 'malformedCommand',
      command: 'answer',
    });
    expect(normalizeConversationPairingToken('ABCDU234')).toBeNull();
  });

  it('refuses an approval request id the frozen ingress obligation could not persist', () => {
    // Ingress text is bounded at 64 KiB, so an admitted `/allow` could freeze a
    // request id far past the persisted approval bound and the canonical
    // Permission contract. That row is unwritable, and the ingest that writes
    // it has no settlement for an invalid value, so the bound belongs here at
    // the one command classifier rather than at the storage write.
    const atBound = 'r'.repeat(MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES);
    expect(classifyConversationCommand(`/allow ${atBound}`)).toEqual({
      kind: 'approve',
      requestId: atBound,
      decision: 'allow',
      scope: 'request',
    });
    expect(classifyConversationCommand(`/allow ${atBound}r`)).toEqual({
      kind: 'malformedCommand',
      command: 'approve',
    });
    expect(classifyConversationCommand(`/deny ${atBound}r`)).toEqual({
      kind: 'malformedCommand',
      command: 'approve',
    });
    // The bound is UTF-8 bytes, not code points: a multibyte identifier that
    // fits the code-point count still exceeds the byte contract.
    expect(classifyConversationCommand(`/allow ${'\u00e9'.repeat(
      MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES / 2 + 1,
    )}`)).toEqual({ kind: 'malformedCommand', command: 'approve' });
  });

  it('uses the approved deterministic /new creation key literal', () => {
    expect(createConversationNewSessionCreationKey({
      bindingId: 'binding-01',
      commandOccurrenceId: 'telegram-update-9001',
    })).toBe('channel-new:binding-01:telegram-update-9001');
  });
});
