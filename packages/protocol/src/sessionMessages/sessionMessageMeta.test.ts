import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('sessionMessages meta', () => {
  it('parses unknown sentFrom/permissionMode without throwing', () => {
    const parsed = (protocol as any).SessionMessageMetaSchema.parse({
      source: 'cli',
      sentFrom: '__future__',
      permissionMode: '__future__',
      extra: 'x',
    });

    expect(parsed.sentFrom).toBe('unknown');
    expect(parsed.permissionMode).toBe('default');
    expect((parsed as any).extra).toBe('x');
  });

  it('preserves payload-free internal markers through the canonical metadata envelope', () => {
    const marker = { kind: 'claude_jsonl_consumed_marker.v1' };
    expect(protocol.HappierMetaEnvelopeSchema.parse(marker)).toEqual(marker);
    expect(protocol.SessionMessageMetaSchema.parse({ happier: marker })).toEqual({ happier: marker });
    expect(protocol.SessionMessageMetaSchema.safeParse({ happier: { payload: null } }).success).toBe(false);
    expect(protocol.SessionMessageMetaSchema.safeParse({ happier: { kind: '', payload: null } }).success).toBe(false);
    expect(protocol.HappierMetaEnvelopeSchema.parse({ ...marker, payload: null })).toEqual({ ...marker, payload: null });
  });

  it('reads and writes the user-message delivery intent metadata', () => {
    const meta = protocol.withSessionUserMessageDeliveryIntentMeta(
      { source: 'ui', happierDeliveryIntentV1: 'caller-spoof' },
      'explicit_pending',
    );

    expect(protocol.readSessionUserMessageDeliveryIntentMeta(meta)).toBe('explicit_pending');
    expect((meta as any).happierDeliveryIntentV1).toBe('explicit_pending');
    expect(protocol.readSessionUserMessageDeliveryIntentMeta({
      happierDeliveryIntentV1: '__future__',
    })).toBeNull();
  });

  it('recognizes only the exact internal tool-answer delivery marker', () => {
    expect(protocol.isSessionToolAnswerDeliveryMeta({
      happier: { kind: protocol.SESSION_TOOL_ANSWER_DELIVERY_KIND, payload: { toolCallId: 'question-1' } },
    })).toBe(true);
    expect(protocol.isSessionToolAnswerDeliveryMeta({ happier: { kind: 'future-kind' } })).toBe(false);
    expect(protocol.isSessionToolAnswerDeliveryMeta(null)).toBe(false);
  });
});
