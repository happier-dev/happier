import { describe, expect, it } from 'vitest';

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
    expect(normalizeConversationPairingToken('ABCDU234')).toBeNull();
  });

  it('uses the approved deterministic /new creation key literal', () => {
    expect(createConversationNewSessionCreationKey({
      bindingId: 'binding-01',
      commandOccurrenceId: 'telegram-update-9001',
    })).toBe('channel-new:binding-01:telegram-update-9001');
  });
});
