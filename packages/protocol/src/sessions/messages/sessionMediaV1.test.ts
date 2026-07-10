import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

type ParseableSchema = Readonly<{
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
}>;

function readSchema(name: string): ParseableSchema {
  const value = Reflect.get(protocol, name);
  expect(value).toBeDefined();
  expect(typeof Reflect.get(value, 'parse')).toBe('function');
  expect(typeof Reflect.get(value, 'safeParse')).toBe('function');
  return value as ParseableSchema;
}

const validMediaItem = {
  id: 'media_1',
  role: 'output',
  category: 'generated',
  mediaKind: 'image',
  mimeType: 'image/png',
  name: 'generated-image.png',
  path: '.happier/uploads/generated/message-1/media_1.png',
  sizeBytes: 42,
  sha256: 'a'.repeat(64),
  width: 1024,
  height: 768,
  createdAtMs: 1710000000000,
  origin: {
    source: 'provider-generated',
    agentId: 'codex',
    toolCallId: 'call_1',
    generationId: 'gen_1',
    agentEventId: 'event_1',
    providerFileId: 'file_1',
  },
} as const;

const validVideoMediaItem = {
  id: 'recording_1',
  role: 'output',
  category: 'tool-artifact',
  mediaKind: 'video',
  mimeType: 'video/webm',
  name: 'recording.webm',
  path: '.happier/uploads/artifacts/session-1/message-1/recording.webm',
  sizeBytes: 2048,
  sha256: 'b'.repeat(64),
  createdAtMs: 1710000000000,
  origin: {
    source: 'tool-output',
    agentId: 'browser-agent',
    toolCallId: 'recording-call-1',
  },
} as const;

describe('session media v1 schemas', () => {
  it('accepts persisted generated image metadata with dimensions', () => {
    const schema = readSchema('SessionMediaItemV1Schema');

    expect(schema.parse(validMediaItem)).toEqual(validMediaItem);
  });

  it('accepts safe persisted video metadata by reference without image dimensions', () => {
    const itemSchema = readSchema('SessionMediaItemV1Schema');
    const envelopeSchema = readSchema('SessionMediaMessageMetaV1Schema');

    expect(itemSchema.parse(validVideoMediaItem)).toEqual(validVideoMediaItem);
    expect(envelopeSchema.parse({
      kind: 'session_media.v1',
      payload: { media: [validVideoMediaItem] },
    })).toEqual({
      kind: 'session_media.v1',
      payload: { media: [validVideoMediaItem] },
    });
  });

  it('rejects unsafe persisted video metadata and image-only dimensions', () => {
    const schema = readSchema('SessionMediaItemV1Schema');
    const invalidItems = [
      { ...validVideoMediaItem, data: 'GkXfo0AgQoaBAUL3gQFC8oEEQvOB' },
      { ...validVideoMediaItem, base64: 'GkXfo0AgQoaBAUL3gQFC8oEEQvOB' },
      { ...validVideoMediaItem, url: 'https://provider.example/recording.webm' },
      { ...validVideoMediaItem, uri: 'file:///tmp/recording.webm' },
      { ...validVideoMediaItem, inlineData: { mimeType: 'video/webm', data: 'GkXfo0AgQoaBAUL3gQFC8oEEQvOB' } },
      { ...validVideoMediaItem, path: '/tmp/recording.webm' },
      { ...validVideoMediaItem, path: 'file:///tmp/recording.webm' },
      { ...validVideoMediaItem, path: 'https://provider.example/recording.webm' },
      { ...validVideoMediaItem, path: 'data:video/webm;base64,GkXfo0AgQoaBAUL3gQFC8oEEQvOB' },
      { ...validVideoMediaItem, path: '$HOME/.happier/recording.webm' },
      { ...validVideoMediaItem, mimeType: 'video/mp4' },
      { ...validVideoMediaItem, width: 1280 },
      { ...validVideoMediaItem, height: 720 },
    ];

    for (const item of invalidItems) {
      expect(schema.safeParse(item).success).toBe(false);
    }
  });

  it('keeps session media metadata forward-compatible while rejecting known unsafe fields', () => {
    const schema = readSchema('SessionMediaItemV1Schema');

    expect(schema.safeParse({
      ...validMediaItem,
      futureRendererHint: { density: 2 },
      origin: {
        ...validMediaItem.origin,
        futureProviderHint: 'ok',
      },
    }).success).toBe(true);
  });

  it('accepts the canonical session_media.v1 meta envelope', () => {
    const schema = readSchema('SessionMediaMessageMetaV1Schema');

    expect(schema.parse({
      kind: 'session_media.v1',
      payload: { media: [validMediaItem] },
    })).toEqual({
      kind: 'session_media.v1',
      payload: { media: [validMediaItem] },
    });
  });

  it('accepts durable failure-only session_media.v1 metadata without inline source details', () => {
    const schema = readSchema('SessionMediaMessageMetaV1Schema');

    expect(schema.parse({
      kind: 'session_media.v1',
      payload: {
        media: [],
        failures: [{
          index: 0,
          code: 'invalid_source_file',
          role: 'output',
          category: 'generated',
          mediaKind: 'image',
          name: 'generated-image.png',
          mimeType: 'image/png',
          origin: {
            source: 'provider-generated',
            agentId: 'codex-agent',
            toolCallId: 'call_1',
            generationId: 'gen_1',
            agentEventId: 'event_1',
            providerFileId: 'file_1',
          },
        }],
      },
    })).toEqual({
      kind: 'session_media.v1',
      payload: {
        media: [],
        failures: [{
          index: 0,
          code: 'invalid_source_file',
          role: 'output',
          category: 'generated',
          mediaKind: 'image',
          name: 'generated-image.png',
          mimeType: 'image/png',
          origin: {
            source: 'provider-generated',
            agentId: 'codex-agent',
            toolCallId: 'call_1',
            generationId: 'gen_1',
            agentEventId: 'event_1',
            providerFileId: 'file_1',
          },
        }],
      },
    });
  });

  it('requires session media failures to carry renderable media identity', () => {
    const schema = readSchema('SessionMediaMessageMetaV1Schema');

    expect(schema.safeParse({
      kind: 'session_media.v1',
      payload: {
        media: [],
        failures: [{
          index: 0,
          code: 'invalid_source_file',
          role: 'output',
          category: 'generated',
          name: 'generated-image.png',
          origin: { source: 'provider-generated' },
        }],
      },
    }).success).toBe(false);
  });

  it('rejects transient or unsafe persisted shapes', () => {
    const schema = readSchema('SessionMediaItemV1Schema');
    const unsafeBase64Id = 'aW1hZ2VCeXRlcw==';
    const invalidItems = [
      { ...validMediaItem, id: unsafeBase64Id },
      { ...validMediaItem, name: 'data:image/png;base64,iVBORw0KGgo=' },
      { ...validMediaItem, name: 'https://provider.example/generated.png' },
      { ...validMediaItem, data: 'iVBORw0KGgo=' },
      { ...validMediaItem, url: 'https://provider.example/generated.png' },
      { ...validMediaItem, b64: 'iVBORw0KGgo=' },
      { ...validMediaItem, inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
      { ...validMediaItem, backendId: 'codex' },
      { ...validMediaItem, summary: 'a generated image' },
      { ...validMediaItem, path: 'file:///tmp/generated.png' },
      { ...validMediaItem, path: '/tmp/generated.png' },
      { ...validMediaItem, path: 'C:\\Users\\alice\\generated.png' },
      { ...validMediaItem, path: 'https://provider.example/generated.png' },
      { ...validMediaItem, path: 'data:image/png;base64,iVBORw0KGgo=' },
      { ...validMediaItem, path: '$HOME/.codex/generated.png' },
      { ...validMediaItem, path: '$CODEX_HOME/generated-images/generated.png' },
      { ...validMediaItem, path: '.happier/uploads/generated/../secret.png' },
      { ...validMediaItem, path: '.happier\\uploads\\generated\\message-1\\media.png' },
      { ...validMediaItem, mimeType: 'image/svg+xml' },
      { ...validMediaItem, width: 0 },
      { ...validMediaItem, height: -1 },
      {
        ...validMediaItem,
        origin: {
          ...validMediaItem.origin,
          backendId: 'codex',
        },
      },
      {
        ...validMediaItem,
        origin: {
          ...validMediaItem.origin,
          agentId: 'file:///tmp/agent',
        },
      },
      {
        ...validMediaItem,
        origin: {
          ...validMediaItem.origin,
          generationId: '/tmp/provider/generated.png',
        },
      },
      {
        ...validMediaItem,
        origin: {
          ...validMediaItem.origin,
          agentEventId: 'https://provider.example/events/secret',
        },
      },
      {
        ...validMediaItem,
        origin: {
          ...validMediaItem.origin,
          providerFileId: unsafeBase64Id,
        },
      },
    ];

    for (const item of invalidItems) {
      expect(schema.safeParse(item).success).toBe(false);
    }
  });

  it('rejects unsafe persisted fields on the origin, payload, and envelope passthrough surfaces', () => {
    const schema = readSchema('SessionMediaMessageMetaV1Schema');
    const inlineDataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const shortBase64Name = 'aW1hZ2VCeXRlcw==';
    const shortBase64UrlName = 'aW1hZ2VCeXRlcw';
    const invalidEnvelopes = [
      {
        kind: 'session_media.v1',
        url: 'https://provider.example/image.png',
        payload: { media: [validMediaItem] },
      },
      {
        kind: 'session_media.v1',
        provider: 'codex',
        payload: { media: [validMediaItem] },
      },
      {
        kind: 'session_media.v1',
        payload: {
          providerId: 'codex',
          media: [validMediaItem],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          futureRendererHint: {
            preview: inlineDataUri,
          },
          media: [validMediaItem],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          futureRendererHint: {
            cachePath: '$CODEX_HOME/generated-images/generated-image.png',
          },
          media: [validMediaItem],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          summary: 'generated image',
          media: [validMediaItem],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          futureRendererHint: {
            inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          },
          media: [validMediaItem],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [],
          failures: [{
            index: 0,
            code: 'invalid_source_file',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            name: 'generated-image.png',
            data: 'iVBORw0KGgo=',
            origin: { source: 'provider-generated' },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [],
          failures: [{
            index: 0,
            code: 'invalid_source_file',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            name: inlineDataUri,
            origin: { source: 'provider-generated' },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [],
          failures: [{
            index: 0,
            code: 'invalid_source_file',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            name: '/tmp/provider/generated-image.png',
            origin: { source: 'provider-generated' },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [],
          failures: [{
            index: 0,
            code: 'invalid_source_file',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            name: shortBase64Name,
            origin: { source: 'provider-generated' },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [],
          failures: [{
            index: 0,
            code: 'invalid_source_file',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            name: shortBase64UrlName,
            origin: { source: 'provider-generated' },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [],
          failures: [{
            index: 0,
            code: 'invalid_source_file',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            name: 'generated-image.png',
            path: '/tmp/provider/generated-image.png',
            origin: { source: 'provider-generated' },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [],
          failures: [{
            index: 0,
            code: 'invalid_source_file',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            name: 'generated-image.png',
            sourcePath: '/tmp/provider/generated-image.png',
            origin: { source: 'provider-generated' },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [],
          failures: [{
            index: 0,
            code: 'invalid_source_file',
            role: 'output',
            category: 'generated',
            mediaKind: 'image',
            name: 'generated-image.png',
            futureProviderField: 'must not passthrough on failures',
            origin: { source: 'provider-generated' },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [{
            ...validMediaItem,
            futureRendererHint: {
              preview: inlineDataUri,
            },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [{
            ...validMediaItem,
            futureRendererHint: {
              cachePath: '/tmp/provider/generated-image.png',
            },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [{
            ...validMediaItem,
            providerId: 'codex',
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [{
            ...validMediaItem,
            origin: {
              ...validMediaItem.origin,
              providerSummary: 'generated image',
            },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [{
            ...validMediaItem,
            origin: {
              ...validMediaItem.origin,
              futureProviderHint: '/tmp/provider/generated-image.png',
            },
          }],
        },
      },
      {
        kind: 'session_media.v1',
        payload: {
          media: [{
            ...validMediaItem,
            origin: {
              ...validMediaItem.origin,
              providerId: 'codex',
            },
          }],
        },
      },
    ];

    for (const envelope of invalidEnvelopes) {
      expect(schema.safeParse(envelope).success).toBe(false);
    }
  });
});
