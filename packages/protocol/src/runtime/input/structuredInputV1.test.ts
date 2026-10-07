import { describe, expect, it } from 'vitest';

import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1 } from '../../plugins/interactions/transientV1.js';
import {
  AgentDispatchStructuredInputV1Schema,
  HappierStructuredInputV1Schema,
  readSessionAttachmentEnvelopeRecordsV1,
  sanitizeHappierStructuredInputV1,
  sanitizeSessionStructuredInputMeta,
} from './structuredInputV1.js';
import { MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 } from './composerAttachmentV1.js';
import { SkillMentionV1Schema } from './skillMentionV1.js';

const validComposerAttachment = {
  v: 1,
  instanceId: 'attachment-1',
  attachment: { pluginId: 'example.composer', localId: 'issue' },
  key: 'issue-42',
  value: { issueId: '42' },
  presentation: { label: 'Issue 42', typeLabel: 'Issue' },
} as const;

describe('native skill identity admission', () => {
  it('preserves a supplied opaque ID in selected skill metadata and repeated admission', () => {
    const id = ' reviewer/α+skill= ';
    const mention = { id, name: ' reviewer ', origin: 'vendor', backendId: 'opencode' };
    expect(SkillMentionV1Schema.parse(mention).id).toBe(id);
    const admitted = sanitizeSessionStructuredInputMeta({ happierSkillMentions: [mention] });
    expect(admitted).toMatchObject({ happierStructuredInputV1: { skillMentions: [{ id, name: 'reviewer' }] } });
    expect(sanitizeSessionStructuredInputMeta(admitted)).toEqual(admitted);
  });
});

describe('browser context Message admission', () => {
  const context = {
    v: 1, kind: 'browserPageReference', contextId: 'page-1', sourceViewId: 'view-1',
    sourceAdapterKind: 'localPreview', fidelity: 'previewProxy', capturedAtMs: 100,
    navigationGeneration: 2, lifecycleState: 'available', redactionLevel: 'metadataOnly',
    url: 'https://example.test/page', title: 'Page',
  } as const;
  const attachment = {
    v: 1, attachmentId: 'attachment-1', contextId: context.contextId, sourceViewId: context.sourceViewId,
    capturedNavigationGeneration: 2, currentNavigationGeneration: 2, state: 'available',
    requiresReconfirmBeforeSend: false,
  } as const;
  const payload = { contexts: [context], attachments: [attachment] };

  it('consumes UI browser metadata once into the canonical structured envelope', () => {
    const admitted = sanitizeSessionStructuredInputMeta({
      happierBrowserContext: { kind: 'browser_context.v1', payload },
    });
    expect(admitted).toEqual({ happierStructuredInputV1: { v: 1, browserContext: payload } });
    expect(sanitizeSessionStructuredInputMeta(admitted)).toEqual(admitted);
  });

  it('refuses stale, uncorrelated, blocked or inline-byte browser data instead of silently losing it', () => {
    for (const invalidPayload of [
      { ...payload, attachments: [{ ...attachment, currentNavigationGeneration: 3 }] },
      { ...payload, attachments: [{ ...attachment, contextId: 'another-page' }] },
      { ...payload, contexts: [{ ...context, redactionLevel: 'blocked' }] },
      { ...payload, contexts: [{ ...context, redactionLevel: 'none' }] },
      { contexts: [{ ...context, redactionLevel: 'none' }, { ...context, contextId: 'group-member' }],
        attachments: [{ ...attachment, structuredBlock: { v: 1, kind: 'browser.annotation.v1',
          annotationId: 'annotation-1', sourceViewId: context.sourceViewId, contextIds: ['group-member'],
          elements: [], regions: [], strokes: [], screenshot: { media: [{ mediaId: 'shot', mediaKind: 'image', width: 1, height: 1, sizeBytes: 1 }] },
        } }] },
      { ...payload, contexts: [{ ...context, screenshotDataUri: 'data:image/png;base64,secret' }] },
    ]) {
      expect(() => sanitizeSessionStructuredInputMeta({
        happierBrowserContext: { kind: 'browser_context.v1', payload: invalidPayload },
      })).toThrow();
    }
  });
});

function canonicalJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(createCanonicalJsonSigningInput(value)).byteLength;
}

function buildComposerAttachmentAggregateAtByteLimit(): readonly Record<string, unknown>[] {
  const attachments = Array.from({ length: 64 }, (_, index) => ({
    ...validComposerAttachment,
    instanceId: `attachment-${index}`,
    key: `issue-${index}`,
    value: { payload: '' },
  }));
  const payloadLength = Math.floor(
    (MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1 - canonicalJsonByteLength(attachments)) / attachments.length,
  );
  const padded = attachments.map((attachment) => ({
    ...attachment,
    value: { payload: 'x'.repeat(payloadLength) },
  }));
  const remainingBytes = MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1 - canonicalJsonByteLength(padded);
  const atByteLimit = padded.map((attachment, index) => index === 0
    ? { ...attachment, value: { payload: `${attachment.value.payload}${'x'.repeat(remainingBytes)}` } }
    : attachment);

  expect(canonicalJsonByteLength(atByteLimit)).toBe(MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1);
  return atByteLimit;
}

describe('readSessionAttachmentEnvelopeRecordsV1', () => {
  it('retains a bounded Discussion selection source and rejects Run-only correlation', () => {
    const source = {
      kind: 'session_discussion' as const,
      sessionId: 'session-a',
      discussionId: 'discussion-a',
      messageIds: ['message-a'],
    };
    expect(HappierStructuredInputV1Schema.parse({
      v: 1,
      sessionDiscussionSelectionSourceV1: source,
    }).sessionDiscussionSelectionSourceV1).toEqual(source);
    expect(HappierStructuredInputV1Schema.safeParse({
      v: 1,
      sessionDiscussionSelectionSourceV1: { ...source, draftCorrelationId: 'draft-a' },
    }).success).toBe(false);
  });

  it('preserves both incumbent attachment envelopes for one downstream trust decision', () => {
    expect(readSessionAttachmentEnvelopeRecordsV1({
      happier: {
        kind: 'attachments.v1',
        payload: { attachments: [{ path: '.happier/uploads/messages/one.png' }] },
      },
      happierAttachments: {
        kind: 'attachments.v1',
        payload: { attachments: [{ path: '.happier/uploads/messages/two.png' }] },
      },
    })).toEqual([
      { path: '.happier/uploads/messages/one.png' },
      { path: '.happier/uploads/messages/two.png' },
    ]);
  });

  it('does not validate or reinterpret malformed incumbent records', () => {
    expect(readSessionAttachmentEnvelopeRecordsV1({
      happier: { kind: 'attachments.v1', payload: { attachments: [{ unknown: true }] } },
      happierAttachments: { kind: 'other', payload: { attachments: [{ path: 'ignored' }] } },
    })).toEqual([{ unknown: true }]);
  });

  it('preserves supported attachment siblings and additive fields while removing malformed or dispatch-only data', () => {
    const malformed = {
      ...validComposerAttachment,
      instanceId: 'attachment-2',
      content: { handle: 'held-content' },
    };
    const raw = {
      v: 1,
      futureField: { retained: true },
      composerAttachments: [validComposerAttachment, malformed],
      resolvedComposerAttachments: [validComposerAttachment],
    };

    expect(HappierStructuredInputV1Schema.safeParse(raw).success).toBe(false);

    expect(sanitizeHappierStructuredInputV1(raw)).toEqual({
      v: 1,
      futureField: { retained: true },
      composerAttachments: [validComposerAttachment],
    });
  });

  it('admits raw attachments only before dispatch and rejects them from dispatch input', () => {
    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: [validComposerAttachment],
    }).success).toBe(false);
    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      resolvedComposerAttachments: [validComposerAttachment],
    }).success).toBe(true);
  });
});

describe('sanitizeHappierStructuredInputV1 composer attachment cardinality', () => {
  it('derives the retained attachment boundary from the canonical Composer limit', () => {
    const composerAttachments = Array.from(
      { length: MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 + 1 },
      (_, index) => ({
        ...validComposerAttachment,
        instanceId: `attachment-${index}`,
        key: `issue-${index}`,
      }),
    );

    expect(sanitizeHappierStructuredInputV1({
      v: 1,
      composerAttachments,
    }).composerAttachments).toHaveLength(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1);
  });
});

describe('Composer attachment aggregate structured-input bounds', () => {
  it('accepts the exact 256 KiB attachment envelope and rejects one byte over across raw, resolved, and mixed arrays', () => {
    const atByteLimit = buildComposerAttachmentAggregateAtByteLimit();
    const oneByteOver = atByteLimit.map((attachment, index) => index === 0
      ? {
        ...attachment,
        value: { payload: `${(attachment.value as { payload: string }).payload}x` },
      }
      : attachment);

    expect(HappierStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: atByteLimit,
    }).success).toBe(true);
    expect(HappierStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: oneByteOver,
    }).success).toBe(false);

    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      resolvedComposerAttachments: atByteLimit,
    }).success).toBe(true);
    expect(AgentDispatchStructuredInputV1Schema.safeParse({
      v: 1,
      resolvedComposerAttachments: oneByteOver,
    }).success).toBe(false);

    expect(HappierStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: atByteLimit.slice(0, 32),
      resolvedComposerAttachments: atByteLimit.slice(32),
    }).success).toBe(true);
    expect(HappierStructuredInputV1Schema.safeParse({
      v: 1,
      composerAttachments: oneByteOver.slice(0, 32),
      resolvedComposerAttachments: oneByteOver.slice(32),
    }).success).toBe(false);
  });
});
