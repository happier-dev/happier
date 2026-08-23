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

const stagedMediaHandle = {
  v: 1,
  id: 'stage-1',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  owner: { pluginId: 'acme.media', localId: 'image' },
  mediaKind: 'image',
  mimeType: 'image/png',
  name: 'hero.png',
  sizeBytes: 42,
  sha256: 'a'.repeat(64),
} as const;

const stagedImageAttachment = {
  v: 1,
  instanceId: 'attachment-media-1',
  attachment: { pluginId: 'acme.media', localId: 'image' },
  key: 'hero-image',
  value: { alt: 'A mountain lake' },
  presentation: { label: 'Hero image', typeLabel: 'Image' },
  content: { kind: 'stagedMedia', handle: stagedMediaHandle },
} as const;

const stagedVideoAttachment = {
  ...stagedImageAttachment,
  instanceId: 'attachment-media-2',
  key: 'hero-clip',
  content: {
    kind: 'stagedMedia',
    handle: { ...stagedMediaHandle, id: 'stage-2', mediaKind: 'video', mimeType: 'video/webm', name: 'hero.webm' },
  },
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

  it('admits an attachment-only send whose staged media the daemon finalizer has not yet replaced', () => {
    for (const attachment of [stagedImageAttachment, stagedVideoAttachment]) {
      const parsed = SessionUserMessageSendRequestSchema.safeParse({
        text: '',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            composerAttachments: [attachment],
          },
        },
      });

      expect(parsed.success).toBe(true);
      // The raw ingress arm reaches the daemon finalizer intact; sanitizing it
      // through the persisted envelope here would delete the staged claim.
      expect(parsed.success && parsed.data.meta).toEqual({
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [attachment],
        },
      });
    }
  });

  it('rejects an attachment-only send whose staged media claim is not a readable ingress handle', () => {
    for (const brokenHandle of [
      { ...stagedMediaHandle, mimeType: 'application/pdf' },
      { ...stagedMediaHandle, mediaKind: 'video' },
      { ...stagedMediaHandle, sha256: 'nope' },
      { ...stagedMediaHandle, path: '/tmp/hero.png' },
    ]) {
      const parsed = SessionUserMessageSendRequestSchema.safeParse({
        text: '',
        meta: {
          happierStructuredInputV1: {
            v: 1,
            composerAttachments: [{ ...stagedImageAttachment, content: { kind: 'stagedMedia', handle: brokenHandle } }],
          },
        },
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('keeps a contentful send with staged media intact instead of stripping the attachment', () => {
    const parsed = SessionUserMessageSendRequestSchema.safeParse({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [stagedImageAttachment],
        },
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [stagedImageAttachment],
        },
      },
    });
  });

  it('rejects a durable SessionMedia reference supplied by an ingress caller', () => {
    expect(SessionUserMessageSendRequestSchema.safeParse({
      text: '',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{ ...pluginAttachment, content: { kind: 'sessionMedia', mediaId: 'media-1' } }],
        },
      },
    }).success).toBe(false);
  });

  it('never lets an ingress caller claim a dispatch resolution through the preserved arm', () => {
    const parsed = SessionUserMessageSendRequestSchema.safeParse({
      text: 'look at this',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [stagedImageAttachment],
          resolvedComposerAttachments: [{ ...pluginAttachment, data: { forged: true } }],
        },
      },
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.meta).toEqual({
      happierStructuredInputV1: {
        v: 1,
        composerAttachments: [stagedImageAttachment],
      },
    });
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
