import { describe, expect, it } from 'vitest';

import {
  ComposerAttachmentDraftV1Schema,
  ComposerAttachmentInputV1Schema,
  ComposerAttachmentViewV1Schema,
} from './composerAttachmentV1.js';

const attachment = {
  v: 1,
  instanceId: 'attachment-1',
  attachment: { pluginId: 'acme.media', localId: 'image' },
  key: 'hero-image',
  value: { alt: 'A mountain lake' },
  presentation: { label: 'Hero image', typeLabel: 'Image' },
} as const;

const stagedMediaContent = {
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

describe('composer attachment content V1', () => {
  it('admits only opaque staged media in drafts and durable SessionMedia references after admission', () => {
    expect(ComposerAttachmentDraftV1Schema.safeParse({
      ...attachment,
      content: stagedMediaContent,
    }).success).toBe(true);

    expect(ComposerAttachmentInputV1Schema.safeParse({
      ...attachment,
      content: { kind: 'sessionMedia', mediaId: 'media-1' },
    }).success).toBe(true);

    expect(ComposerAttachmentDraftV1Schema.safeParse({
      ...attachment,
      content: { kind: 'sessionMedia', mediaId: 'media-1' },
    }).success).toBe(false);
    expect(ComposerAttachmentInputV1Schema.safeParse({
      ...attachment,
      content: stagedMediaContent,
    }).success).toBe(false);
    expect(ComposerAttachmentInputV1Schema.safeParse({
      ...attachment,
      content: { kind: 'sessionMedia', mediaId: 'media-1', handle: stagedMediaContent.handle },
    }).success).toBe(false);
  });

  it('projects a staged handle through draft snapshots without admitting durable media references', () => {
    expect(ComposerAttachmentViewV1Schema.safeParse({
      ...attachment,
      availability: { status: 'ready' },
      content: stagedMediaContent,
    }).success).toBe(true);

    expect(ComposerAttachmentViewV1Schema.safeParse({
      ...attachment,
      availability: { status: 'ready' },
      content: { kind: 'sessionMedia', mediaId: 'media-1' },
    }).success).toBe(false);
  });

  it('never admits transport or source details through a staged content handle', () => {
    const invalidHandles = [
      { ...stagedMediaContent.handle, path: '/tmp/hero.png' },
      { ...stagedMediaContent.handle, uri: 'file:///tmp/hero.png' },
      { ...stagedMediaContent.handle, base64: 'cHJpdmF0ZQ==' },
      { ...stagedMediaContent.handle, bytes: [0x89, 0x50] },
      { ...stagedMediaContent.handle, credential: 'secret' },
      { ...stagedMediaContent.handle, sessionId: 'transfer-session-1' },
      { ...stagedMediaContent.handle, transferSessionId: 'upload-1' },
      { ...stagedMediaContent.handle, name: '/tmp/hero.png' },
      { ...stagedMediaContent.handle, name: 'https://example.test/hero.png' },
      { ...stagedMediaContent.handle, mimeType: 'application/pdf' },
      { ...stagedMediaContent.handle, mediaKind: 'audio' },
    ];

    for (const handle of invalidHandles) {
      expect(ComposerAttachmentDraftV1Schema.safeParse({
        ...attachment,
        content: { kind: 'stagedMedia', handle },
      }).success).toBe(false);
    }
  });
});
