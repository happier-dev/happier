import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

describe('sessionMessages meta', () => {
  it('parses unknown sentFrom/permissionMode without throwing', () => {
    const parsed = (protocol as any).SessionMessageMetaSchema.parse({
      source: '__future_source__',
      sentFrom: '__future__',
      permissionMode: '__future__',
      extra: 'x',
    });

    expect(parsed.source).toBe('__future_source__');
    expect(parsed.sentFrom).toBe('unknown');
    expect(parsed.permissionMode).toBe('default');
    expect((parsed as any).extra).toBe('x');
  });

  it('accepts session media in primary and secondary Happier metadata slots', () => {
    const media = {
      id: 'media_1',
      role: 'output',
      category: 'generated',
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'generated.png',
      path: '.happier/uploads/generated/message-1/generated.png',
      sizeBytes: 42,
      width: 1,
      height: 1,
      origin: { source: 'provider-generated' },
    };

    const parsed = protocol.SessionMessageMetaSchema.parse({
      happier: {
        kind: 'session_media.v1',
        payload: { media: [media] },
      },
      happierMedia: {
        kind: 'session_media.v1',
        payload: { media: [media] },
      },
    });

    expect(parsed.happier).toMatchObject({ kind: 'session_media.v1' });
    expect(parsed.happierMedia).toMatchObject({ kind: 'session_media.v1' });
  });

  it('rejects invalid session_media.v1 payloads in the primary Happier metadata slot', () => {
    expect(protocol.SessionMessageMetaSchema.safeParse({
      happier: {
        kind: 'session_media.v1',
        payload: {
          media: [{
            id: 'media_1',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'generated.png',
            path: '.happier/uploads/generated/session-1/message-1/generated.png',
            sizeBytes: 42,
            origin: { source: 'provider-generated' },
            data: 'iVBORw0KGgo=',
          }],
        },
      },
    }).success).toBe(false);
  });

  it('reads and writes user-message delivery intent metadata', () => {
    const meta = protocol.withSessionUserMessageDeliveryIntentMeta(
      { source: 'ui', happierDeliveryIntentV1: 'caller-spoof' },
      'explicit_pending',
    );

    expect(protocol.readSessionUserMessageDeliveryIntentMeta(meta)).toBe('explicit_pending');
    expect(meta.happierDeliveryIntentV1).toBe('explicit_pending');
    expect(protocol.readSessionUserMessageDeliveryIntentMeta({
      happierDeliveryIntentV1: '__future__',
    })).toBeNull();
    expect(protocol.readSessionUserMessageDeliveryIntentMeta(null)).toBeNull();
  });
});
