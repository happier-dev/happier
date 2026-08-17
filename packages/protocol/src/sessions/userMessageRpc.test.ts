import { describe, expect, it } from 'vitest';

import {
  readAttachmentEnvelopeLocalImagePaths,
  sanitizeSessionUserMessageSendMeta,
  SessionUserMessageSendRequestSchema,
  SessionUserMessageSendResponseSchema,
} from './userMessageRpc.js';

const pluginAttachment = {
  v: 1,
  instanceId: 'attachment-1',
  attachment: {
    pluginId: 'com.acme.review',
    localId: 'review',
  },
  key: 'review-42',
  value: { reviewId: '42' },
  presentation: { label: 'Review #42', typeLabel: 'Review comment', icon: 'info' },
} as const;

describe('SessionUserMessageSendResponseSchema', () => {
  it('accepts successful ACK payloads', () => {
    expect(SessionUserMessageSendResponseSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it('accepts runtime error ACK payloads', () => {
    expect(
      SessionUserMessageSendResponseSchema.parse({
        ok: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      }),
    ).toEqual({
      ok: false,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    });
  });
});

describe('SessionUserMessageSendRequestSchema', () => {
  it('permits attachment-only sends only after canonical structured-input admission', () => {
    const attachmentOnly = SessionUserMessageSendRequestSchema.safeParse({
      text: '',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [pluginAttachment],
        },
      },
    });

    expect(attachmentOnly.success).toBe(true);
    expect(attachmentOnly.success && attachmentOnly.data.meta).toMatchObject({
      happierStructuredInputV1: { composerAttachments: [pluginAttachment] },
    });
    expect(SessionUserMessageSendRequestSchema.safeParse({
      text: '',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{ malformed: true }],
        },
      },
    }).success).toBe(false);
    expect(SessionUserMessageSendRequestSchema.safeParse({
      text: '',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          mentions: [{
            kind: 'happier.file',
            ref: 'file:src/index.ts',
            token: '@src/index.ts',
            start: 0,
            end: 13,
          }],
        },
      },
    }).success).toBe(false);
    expect(SessionUserMessageSendRequestSchema.safeParse({ text: '', meta: {} }).success).toBe(false);
  });

  it('rejects whitespace-only text without an admitted composer attachment', () => {
    expect(SessionUserMessageSendRequestSchema.safeParse({
      text: '   ',
      meta: {},
    }).success).toBe(false);
  });

  it('drops untrusted structured local image input paths from RPC metadata', () => {
    expect(
      SessionUserMessageSendRequestSchema.parse({
        text: 'look at this',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            imageInputs: [
              {
                kind: 'localImage',
                path: '/tmp/private.png',
                mimeType: 'image/png',
              },
            ],
          },
        },
      }),
    ).toEqual({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
        },
      },
    });
  });

  it('drops malformed structured input envelopes from RPC metadata', () => {
    expect(
      SessionUserMessageSendRequestSchema.parse({
        text: 'look at this',
        meta: {
          happierStructuredInputV1: 'not-an-envelope',
        },
      }),
    ).toEqual({
      text: 'look at this',
      meta: {},
    });
  });

  it('preserves uploaded local image metadata as canonical image inputs when the caller supplies a trusted attachment allowlist', () => {
    const meta = {
      happier: {
        kind: 'attachments.v1',
        payload: {
          attachments: [
            {
              name: 'screen.png',
              path: '.happier/uploads/messages/m1/screen.png',
              mimeType: 'image/png',
              sizeBytes: 42,
            },
          ],
        },
      },
      happierStructuredInputV1: {
        v: 1,
        imageInputs: [
          {
            kind: 'localImage',
            path: '.happier/uploads/messages/m1/screen.png',
            mimeType: 'image/png',
            provenance: { kind: 'sessionAttachmentUpload' },
          },
        ],
      },
    };

    expect(readAttachmentEnvelopeLocalImagePaths(meta)).toEqual(new Set(['.happier/uploads/messages/m1/screen.png']));
    expect(sanitizeSessionUserMessageSendMeta(meta, {
      allowedLocalImagePaths: new Set(['.happier/uploads/messages/m1/screen.png']),
    })).toMatchObject({
      happierStructuredInputV1: {
        v: 1,
        imageInputs: [
          {
            kind: 'localImage',
            path: '.happier/uploads/messages/m1/screen.png',
            provenance: { kind: 'sessionAttachmentUpload' },
          },
        ],
      },
    });
  });

  it('folds Remote Dev structured-input alias keys into the canonical metadata envelope', () => {
    expect(sanitizeSessionUserMessageSendMeta({
      happierVendorPluginMentions: [
        { vendorPluginRef: 'plugin://gmail@openai-curated', label: 'Gmail' },
      ],
      happierSkillMentions: [
        { name: 'review', path: '/skills/review/SKILL.md', origin: 'codex_native' },
      ],
    })).toMatchObject({
      happierStructuredInputV1: {
        v: 1,
        vendorPluginMentions: [
          { vendorPluginRef: 'plugin://gmail@openai-curated', label: 'Gmail' },
        ],
        skillMentions: [
          { name: 'review', path: '/skills/review/SKILL.md', origin: 'vendor', backendId: 'codex' },
        ],
      },
    });
  });

  it('drops a malformed mention element without discarding its siblings or the request', () => {
    // INV-4: malformed elements drop individually. The sanitizer runs inside a zod
    // `.transform`, so a `parse` that throws inside it escapes `safeParse` itself and the
    // request boundary fails with a raw exception instead of rejecting the one bad element.
    const parsed = SessionUserMessageSendRequestSchema.safeParse({
      text: 'review this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          skillMentions: [
            { name: 'good', path: '/skills/good/SKILL.md', origin: 'vendor' },
            { name: 'unreadable-origin', path: '/skills/other/SKILL.md', origin: 'wat' },
            { name: 'unusable', path: '/skills/broken/SKILL.md', backendId: 7 },
          ],
          vendorPluginMentions: [
            { vendorPluginRef: 'plugin://gmail@openai-curated', label: 'Gmail' },
            { vendorPluginRef: 'plugin://drive@openai-curated', agentId: 7 },
          ],
        },
      },
    });

    expect(parsed.success).toBe(true);
    const envelope = parsed.success
      ? (parsed.data.meta as Record<string, unknown>).happierStructuredInputV1 as Record<string, unknown>
      : null;
    expect(envelope?.skillMentions).toEqual([
      { id: '/skills/good/SKILL.md', name: 'good', path: '/skills/good/SKILL.md', origin: 'vendor' },
      { id: '/skills/other/SKILL.md', name: 'unreadable-origin', path: '/skills/other/SKILL.md' },
    ]);
    expect(envelope?.vendorPluginMentions).toEqual([
      { vendorPluginRef: 'plugin://gmail@openai-curated', label: 'Gmail' },
    ]);
  });
});
