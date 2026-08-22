import { describe, expect, it } from 'vitest';

import {
  ComposerAttachmentDraftV1Schema,
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  HappierStructuredInputV1Schema,
  MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
  SessionMediaMessageMetaV1Schema,
} from '@happier-dev/protocol';

import {
  SessionStructuredInputAdmissionError,
  admitSessionStructuredInputV1,
  preserveComposerAttachmentSelectionAcrossSessionInputTransformV1,
  validateSessionStructuredInputIngressV1,
} from './admitSessionStructuredInputV1';

const attachment = {
  v: 1,
  instanceId: 'review-instance-1',
  attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
  key: 'review-42',
  value: { reviewId: '42' },
  presentation: { label: 'Review #42', typeLabel: 'Review comment' },
} as const;

describe('admitSessionStructuredInputV1', () => {
  it('admits a fully prepared contentless attachment without legacy media verification state', () => {
    const result = admitSessionStructuredInputV1({
      text: '',
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [attachment],
        },
      },
      preparedComposerAttachments: [{
        ...attachment,
        value: { reviewId: '42', canonical: true },
      }],
    });

    expect(result.text).toBe('');
    expect(result.structuredInput).toEqual({
      v: 1,
      composerAttachments: [{
        ...attachment,
        value: { reviewId: '42', canonical: true },
      }],
    });
    expect(result.meta).toEqual({
      [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: result.structuredInput,
    });
  });

  it('rejects an attachment selection that has no complete preparation result', () => {
    expect(() => admitSessionStructuredInputV1({
      text: 'inspect this review',
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [attachment],
        },
      },
    })).toThrow(expect.objectContaining({
      code: 'session_structured_input_attachment_preparation_required',
    }));
  });

  it('rejects a session-media attachment reference that is not backed by one durable media item', () => {
    const mediaAttachment = {
      ...attachment,
      content: {
        kind: 'sessionMedia' as const,
        mediaId: 'session-media-image-1',
      },
    };

    expect(() => admitSessionStructuredInputV1({
      text: 'inspect this image',
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [attachment],
        },
      },
      preparedComposerAttachments: [mediaAttachment],
    })).toThrow(expect.objectContaining({
      code: 'session_structured_input_session_media_invalid',
    }));
  });

  it('rejects an incomplete prepared result rather than persisting a valid sibling', () => {
    expect(() => admitSessionStructuredInputV1({
      text: 'inspect both reviews',
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [
            attachment,
            { ...attachment, instanceId: 'review-instance-2', key: 'review-43' },
          ],
        },
      },
      preparedComposerAttachments: [attachment],
    })).toThrow(expect.objectContaining({
      code: 'session_structured_input_attachment_preparation_incomplete',
    }));
  });

  it('rejects duplicate attachment semantic identities before they can bypass document upsert semantics', () => {
    const duplicate = {
      ...attachment,
      instanceId: 'review-instance-2',
    };

    expect(() => admitSessionStructuredInputV1({
      text: 'inspect this review twice',
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [attachment, duplicate],
        },
      },
      preparedComposerAttachments: [attachment, duplicate],
    })).toThrow(expect.objectContaining({
      code: 'session_structured_input_attachment_invalid',
    }));
  });

  it('rejects raw malformed attachment state and caller-supplied dispatch resolution before persistence', () => {
    const malformed = () => admitSessionStructuredInputV1({
      text: 'inspect this review',
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: { forged: true },
        },
      },
    });
    const forgedDispatchResult = () => admitSessionStructuredInputV1({
      text: 'inspect this review',
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [attachment],
          resolvedComposerAttachments: [{ instanceId: attachment.instanceId }],
        },
      },
      preparedComposerAttachments: [attachment],
    });

    expect(malformed).toThrow(expect.objectContaining({
      code: 'session_structured_input_attachment_invalid',
    }));
    expect(forgedDispatchResult).toThrow(expect.objectContaining({
      code: 'session_structured_input_dispatch_resolution_forbidden',
    }));
  });

  it('rejects a malformed or aggregate-overbound supplied envelope before sanitization can omit it', () => {
    const malformed = () => validateSessionStructuredInputIngressV1({
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          mentions: { malformed: true },
        },
      },
    });
    const overbound = () => validateSessionStructuredInputIngressV1({
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: Array.from({ length: 64 }, (_, index) => ({
            ...attachment,
            instanceId: `review-instance-${index}`,
            key: `review-${index}`,
            value: { payload: 'x'.repeat(4_096) },
          })),
        },
      },
    });

    expect(malformed).toThrow(expect.objectContaining({
      code: 'session_structured_input_attachment_invalid',
    }));
    expect(overbound).toThrow(expect.objectContaining({
      code: 'session_structured_input_attachment_invalid',
    }));
  });

  it('retains the source attachment selection while preserving unrelated transform metadata', () => {
    const replacement = {
      ...attachment,
      instanceId: 'review-instance-2',
      key: 'review-99',
      value: { reviewId: '99' },
      presentation: { label: 'Review #99', typeLabel: 'Review comment' },
    };

    const result = preserveComposerAttachmentSelectionAcrossSessionInputTransformV1({
      sourceMeta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [attachment],
        },
      },
      transformedMeta: {
        transformedBy: 'fixture.plugin',
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          mentions: [{ kind: 'skill', ref: 'skill:review', token: '$review', start: 0, end: 7 }],
          composerAttachments: [replacement],
        },
      },
    });

    expect(result).toEqual({
      transformedBy: 'fixture.plugin',
      [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
        v: 1,
        mentions: [{ kind: 'skill', ref: 'skill:review', token: '$review', start: 0, end: 7 }],
        composerAttachments: [attachment],
      },
    });
  });

  it('rejects a dispatch-only Composer resolution injected by a generic transform', () => {
    expect(() => preserveComposerAttachmentSelectionAcrossSessionInputTransformV1({
      sourceMeta: {},
      transformedMeta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          resolvedComposerAttachments: [{ ...attachment, data: { forged: true } }],
        },
      },
    })).toThrow(expect.objectContaining({
      code: 'session_structured_input_dispatch_resolution_forbidden',
    }));
  });

  it('preserves the existing text-bound mention admission when no attachment is selected', () => {
    const result = admitSessionStructuredInputV1({
      text: 'run $review',
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          mentions: [{
            kind: 'skill',
            ref: 'skill:vendor:codex:review',
            token: '$review',
            start: 4,
            end: 11,
          }],
        },
      },
    });

    expect(result.structuredInput?.mentions).toEqual([{
      kind: 'skill',
      ref: 'skill:vendor:codex:review',
      token: '$review',
      start: 4,
      end: 11,
    }]);
  });

  it('surfaces a stable typed failure rather than a generic Zod error', () => {
    try {
      admitSessionStructuredInputV1({
        text: '',
        meta: {
          [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
            v: 1,
            composerAttachments: [attachment],
          },
        },
      });
      throw new Error('expected admission to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionStructuredInputAdmissionError);
      expect(error).toMatchObject({
        code: 'session_structured_input_attachment_preparation_required',
      });
    }
  });
});

const stagedMediaHandle = {
  v: 1,
  id: 'staged-content-1',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  owner: { pluginId: 'acme.review-comments', localId: 'review-comment' },
  mediaKind: 'image',
  mimeType: 'image/png',
  name: 'photo.png',
  sizeBytes: 2048,
  sha256: 'a'.repeat(64),
} as const;

const sessionMediaEnvelope = {
  kind: 'session_media.v1',
  payload: {
    media: [{
      id: 'session-media-42',
      role: 'input',
      category: 'attachment',
      mediaKind: 'image',
      mimeType: 'image/png',
      name: 'photo.png',
      path: '.happier/media/messages/msg-1/photo.png',
      sizeBytes: 2048,
      sha256: 'a'.repeat(64),
      origin: { source: 'user-upload' },
    }],
  },
} as const;

const stagedAttachment = {
  v: 1,
  instanceId: 'staged-instance-1',
  attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
  key: 'staged-image-1',
  value: { source: 'picker' },
  presentation: { label: 'photo.png', typeLabel: 'Image' },
  content: { kind: 'stagedMedia', handle: stagedMediaHandle },
} as const;

/** Exactly what the daemon's SessionMedia finalizer returns for the staged draft. */
const finalizedStagedAttachment = {
  v: 1,
  instanceId: stagedAttachment.instanceId,
  attachment: stagedAttachment.attachment,
  key: stagedAttachment.key,
  value: stagedAttachment.value,
  presentation: stagedAttachment.presentation,
  content: { kind: 'sessionMedia', mediaId: 'session-media-42' },
} as const;

describe('staged composer media at ingress', () => {
  it('admits a staged-media draft attachment at the raw ingress boundary', () => {
    const selected = validateSessionStructuredInputIngressV1({
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [stagedAttachment],
        },
      },
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]?.content).toEqual({ kind: 'stagedMedia', handle: stagedMediaHandle });
  });

  // The fixtures above/below are the exact shapes the two owners disagree about.
  // Asserting their validity here stops this suite from silently passing on a
  // record that neither schema would ever accept in production.
  it('uses fixtures the draft schema accepts and the persisted schema refuses', () => {
    expect(ComposerAttachmentDraftV1Schema.safeParse(stagedAttachment).success).toBe(true);
    expect(HappierStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: [stagedAttachment],
    }).success).toBe(false);
    expect(SessionMediaMessageMetaV1Schema.safeParse(sessionMediaEnvelope).success).toBe(true);
  });

  it('persists the finalized SessionMedia reference and never the staged claim', () => {
    const result = admitSessionStructuredInputV1({
      text: 'look at this photo',
      meta: {
        happierMedia: sessionMediaEnvelope,
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [stagedAttachment],
        },
      },
      preparedComposerAttachments: [finalizedStagedAttachment],
    });

    expect(result.structuredInput?.composerAttachments).toEqual([finalizedStagedAttachment]);
    // The persisted envelope is finalized-only: no staged handle survives.
    expect(JSON.stringify(result.structuredInput)).not.toContain('stagedMedia');
    expect(HappierStructuredInputV1Schema.safeParse(result.structuredInput).success).toBe(true);
  });

  it('reports the existing typed preparation failure when the finalizer did not run', () => {
    expect(() => admitSessionStructuredInputV1({
      text: 'look at this photo',
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [stagedAttachment],
        },
      },
    })).toThrow(expect.objectContaining({
      code: 'session_structured_input_attachment_preparation_required',
    }));
  });

  it('keeps the shared instance and handle bounds at the raw ingress boundary', () => {
    const overCap = Array.from(
      { length: MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 + 1 },
      (_unused, index) => ({
        ...stagedAttachment,
        instanceId: `staged-instance-${index}`,
        key: `staged-image-${index}`,
      }),
    );
    expect(() => validateSessionStructuredInputIngressV1({
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { v: 1, composerAttachments: overCap },
      },
    })).toThrow(expect.objectContaining({
      code: 'session_structured_input_attachment_invalid',
    }));

    expect(() => validateSessionStructuredInputIngressV1({
      meta: {
        [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
          v: 1,
          composerAttachments: [{
            ...stagedAttachment,
            // A video MIME type on an image claim is the handle owner's refusal.
            content: {
              kind: 'stagedMedia',
              handle: { ...stagedMediaHandle, mimeType: 'video/mp4' },
            },
          }],
        },
      },
    })).toThrow(expect.objectContaining({
      code: 'session_structured_input_attachment_invalid',
    }));
  });
});
