import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

describe('sessionMessages meta', () => {
  it('retains predecessor Claude execution choices without retaining arbitrary metadata', () => {
    // ../0.2 HEAD 639a32ec0e832dedb35d5a5809c36717c568225f (clean):
    // buildClaudeRemoteOutgoingMessageMetaExtras writes this family, and
    // applyClaudeRemoteMetaState reads it to choose SDK, sources and thinking.
    const reader = createStoredReadSchema(protocol.SessionMessageMetaSchema);
    const metadata = {
      source: 'ui',
      claudeRemoteAgentSdkEnabled: false,
      claudeRemoteSettingSourcesV2: ['project'],
      claudeRemoteSettingSources: 'project',
      claudeRemoteMaxThinkingTokens: 4096,
      reasoningEffort: 'low',
    };
    expect(reader.parse({ ...metadata, arbitraryMetadata: 'drop' })).toEqual(metadata);
    expect(reader.parse({ claudeRemoteMaxThinkingTokens: null })).toEqual({ claudeRemoteMaxThinkingTokens: null });
    expect(reader.safeParse({ claudeRemoteAgentSdkEnabled: 'false' }).success).toBe(false);
    expect(reader.safeParse({ claudeRemoteSettingSourcesV2: ['unknown'] }).success).toBe(false);
    expect(reader.safeParse({ claudeRemoteMaxThinkingTokens: '4096' }).success).toBe(false);
    expect(reader.safeParse({ reasoningEffort: 1 }).success).toBe(false);
  });

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

  it('accepts the 0.2 untyped Automation pending-queue meta without inventing typed provenance', () => {
    // Provenance-pinned 0.2 shape from ../0.2 apps/cli/src/daemon/automation/automationPendingQueueClient.ts
    // (HEAD ac30c50856abd2265c14459e77ee3384da1698ad, clean): meta { sentFrom: 'cli', source: 'automation' }
    // with no automationId or typed provenance keys, in both plain and E2EE ciphertext paths.
    const parsed = protocol.SessionMessageMetaSchema.parse({
      sentFrom: 'cli',
      source: 'automation',
    });

    expect(parsed.sentFrom).toBe('cli');
    expect(parsed.source).toBe('automation');
    expect(protocol.readSessionMessageProvenanceV1(parsed)).toBeNull();
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

  it('validates canonical conversation-turn provenance while preserving the additive envelope', () => {
    const parsed = protocol.SessionMessageMetaSchema.parse({
      happier: {
        kind: 'conversation_turn.v1',
        payload: { v: 1 },
        conversationTurnOriginV1: {
          v: 1,
          channel: 'realtime_conversation',
          modality: 'voice',
        },
      },
    });

    expect(parsed.happier?.conversationTurnOriginV1).toEqual({
      v: 1,
      channel: 'realtime_conversation',
      modality: 'voice',
    });
    expect(protocol.SessionMessageMetaSchema.safeParse({
      happier: {
        kind: 'conversation_turn.v1',
        payload: { v: 1 },
        conversationTurnOriginV1: {
          v: 1,
          channel: 'agent_thread',
          modality: 'voice',
        },
      },
    }).success).toBe(false);
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
