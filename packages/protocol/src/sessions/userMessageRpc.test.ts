import { describe, expect, it } from 'vitest';

import {
  readAttachmentEnvelopeLocalImagePaths,
  sanitizeSessionUserMessageSendMeta,
  SessionUserMessageSendRequestSchema,
  SessionUserMessageSendResponseSchema,
} from './userMessageRpc.js';

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
          { name: 'review', path: '/skills/review/SKILL.md', origin: 'vendor' },
        ],
      },
    });
  });
});
