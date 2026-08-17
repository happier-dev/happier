import { describe, expect, it } from 'vitest';

import {
  ComposerAttachmentMessageAcceptedV1Schema,
  ComposerAttachmentPrepareRequestV1Schema,
  ComposerAttachmentPrepareResultV1Schema,
  ComposerAttachmentResolveRequestV1Schema,
  ComposerAttachmentResolveResultV1Schema,
} from './composerAttachmentRuntimeV1.js';

describe('composer attachment runtime V1', () => {
  it('uses sessionId and localId as the sole attachment-runtime identity', () => {
    const attachments = [{
      instanceId: 'attachment-1',
      key: 'issue',
      value: { issueId: '42', summary: 'Ready' },
    }];

    expect(ComposerAttachmentResolveRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments,
    }).success).toBe(true);
    expect(ComposerAttachmentResolveRequestV1Schema.safeParse({
      sessionId: 'session-1',
      messageId: 'message-1',
      localId: 'local-1',
      attachments,
    }).success).toBe(false);
    expect(ComposerAttachmentResolveRequestV1Schema.safeParse({
      sessionId: 'session-1',
      messageLocalId: 'local-1',
      attachments,
    }).success).toBe(false);

    expect(ComposerAttachmentPrepareRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments,
    }).success).toBe(true);
    expect(ComposerAttachmentPrepareRequestV1Schema.safeParse({
      sessionId: 'session-1',
      messageLocalId: 'local-1',
      attachments,
    }).success).toBe(false);

    expect(ComposerAttachmentMessageAcceptedV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments,
    }).success).toBe(true);
    expect(ComposerAttachmentMessageAcceptedV1Schema.safeParse({
      sessionId: 'session-1',
      messageId: 'message-1',
      localId: 'local-1',
      attachments,
    }).success).toBe(false);
    expect(ComposerAttachmentMessageAcceptedV1Schema.safeParse({
      sessionId: 'session-1',
      messageLocalId: 'local-1',
      attachments,
    }).success).toBe(false);
  });

  it('keeps each lifecycle payload closed and permits only opaque staged media during preparation', () => {
    expect(ComposerAttachmentPrepareRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42' },
      }],
    }).success).toBe(true);

    const stagedContent = {
      kind: 'stagedMedia',
      handle: {
        v: 1,
        id: 'stage-1',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        owner: { pluginId: 'acme.media', localId: 'image' },
        mediaKind: 'image',
        mimeType: 'image/png',
        name: 'hero.png',
        sizeBytes: 42,
        sha256: 'a'.repeat(64),
      },
    } as const;

    expect(ComposerAttachmentPrepareRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42' },
        content: stagedContent,
      }],
    }).success).toBe(true);

    expect(ComposerAttachmentPrepareResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'ready',
        value: { issueId: '42', summary: 'Ready' },
        content: stagedContent,
      }],
    }).success).toBe(true);
    expect(ComposerAttachmentPrepareResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'ready',
        value: { issueId: '42', summary: 'Ready' },
        mediaIds: ['media-1'],
      }],
    }).success).toBe(false);
    expect(ComposerAttachmentPrepareResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'ready',
        value: { issueId: '42', summary: 'Ready' },
        media: [{ id: 'media-1' }],
      }],
    }).success).toBe(false);
    expect(ComposerAttachmentPrepareResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'failed',
        retryable: true,
        unexpected: true,
      }],
    }).success).toBe(false);

    expect(ComposerAttachmentResolveRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42', summary: 'Ready' },
      }],
    }).success).toBe(true);
    expect(ComposerAttachmentResolveRequestV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42', summary: 'Ready' },
        mediaIds: ['media-1'],
      }],
    }).success).toBe(false);

    expect(ComposerAttachmentResolveResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'ready',
        context: 'Issue 42 is open.',
        data: { severity: 'high' },
      }],
    }).success).toBe(true);
    expect(ComposerAttachmentResolveResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'ready',
        mediaIds: ['media-1'],
      }],
    }).success).toBe(false);

    expect(ComposerAttachmentMessageAcceptedV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42', summary: 'Ready' },
      }],
    }).success).toBe(true);
    expect(ComposerAttachmentMessageAcceptedV1Schema.safeParse({
      sessionId: 'session-1',
      localId: 'local-1',
      attachments: [{
        instanceId: 'attachment-1',
        key: 'issue',
        value: { issueId: '42', summary: 'Ready' },
        mediaIds: ['media-1'],
      }],
    }).success).toBe(false);
  });

  it('accepts only the approved r1.0 non-ready outcomes', () => {
    expect(ComposerAttachmentResolveResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'cancelled',
        retryable: true,
      }],
    }).success).toBe(false);
    expect(ComposerAttachmentResolveResultV1Schema.safeParse({
      attachments: [{
        instanceId: 'attachment-1',
        status: 'unsupported',
        retryable: true,
      }],
    }).success).toBe(false);
  });
});
