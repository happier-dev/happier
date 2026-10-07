import { describe, expect, it, vi } from 'vitest';

import { buildOpenCodePromptParts } from './promptParts.js';

describe('buildOpenCodePromptParts', () => {
  it('preserves text and safe OpenCode mentions without dereferencing structured paths', async () => {
    await expect(Promise.resolve().then(() => buildOpenCodePromptParts({
      text: 'Review this',
      structuredInput: {
        v: 1,
        vendorPluginMentions: [{
          vendorPluginRef: 'reviewer',
          label: 'Reviewer',
        }],
        skillMentions: [{
          id: 'skill-1',
          name: 'security-review',
          path: '/repo/.agents/skills/security-review/SKILL.md',
        }],
      },
    }))).resolves.toEqual([
      { type: 'text', text: 'Review this' },
      { type: 'agent', name: 'reviewer' },
      {
        type: 'skill',
        id: 'skill-1',
        name: 'security-review',
        path: '/repo/.agents/skills/security-review/SKILL.md',
        text: 'Use the security-review skill for this request.',
      },
    ]);
  });

  it('rejects malformed or unsafe structured image input instead of dropping it', async () => {
    await expect(Promise.resolve().then(() => buildOpenCodePromptParts({
      text: '',
      structuredInput: {
        v: 1,
        imageInputs: [{
          id: 'image-1',
          kind: 'image',
          url: 'javascript:alert(1)',
        }],
      },
    }))).rejects.toThrow('OpenCode server mode does not accept remote image references');
  });

  it('maps a host-verified upload to the exact OpenCode file-part contract', async () => {
    const readVerifiedImage = vi.fn(async () => ({
      url: 'data:image/png;base64,iVBORw0KGgo=',
      mimeType: 'image/png',
      filename: 'image.png',
    }));

    await expect(Promise.resolve().then(() => buildOpenCodePromptParts({
      text: 'Inspect this image',
      inputFiles: { readVerifiedImage },
      structuredInput: {
        v: 1,
        imageInputs: [{
          id: 'image-verified',
          kind: 'localImage',
          path: '.happier/uploads/messages/message-1/image.png',
          mimeType: 'image/png',
          sha256: 'a'.repeat(64),
          sizeBytes: 123,
          provenance: { kind: 'sessionAttachmentUpload' },
        }],
      },
    }))).resolves.toEqual([
      { type: 'text', text: 'Inspect this image' },
      {
        type: 'file',
        mime: 'image/png',
        filename: 'image.png',
        url: 'data:image/png;base64,iVBORw0KGgo=',
      },
    ]);
    expect(readVerifiedImage).toHaveBeenCalledWith(expect.objectContaining({
      path: '.happier/uploads/messages/message-1/image.png',
      sha256: 'a'.repeat(64),
      sizeBytes: 123,
    }), undefined);
  });

  it('fails closed when the host cannot verify an admitted upload', async () => {
    await expect(Promise.resolve().then(() => buildOpenCodePromptParts({
      text: 'Inspect this image',
      inputFiles: { readVerifiedImage: async () => null },
      structuredInput: {
        v: 1,
        imageInputs: [{
          id: 'image-verified',
          kind: 'localImage',
          path: '.happier/uploads/messages/message-1/image.png',
          mimeType: 'image/png',
          sha256: 'a'.repeat(64),
          sizeBytes: 123,
          provenance: { kind: 'sessionAttachmentUpload' },
        }],
      },
    }))).rejects.toMatchObject({ code: 'opencode_image_input_untrusted' });
  });

  it('accepts an additive mentions field and emits one part per reference (D-4, R-4)', async () => {
    // The envelope schema is `.passthrough()`, so `mentions[]` must not trip the
    // `opencode_structured_input_invalid` rejection at the top of the projection.
    await expect(Promise.resolve().then(() => buildOpenCodePromptParts({
      text: 'Review this',
      structuredInput: {
        v: 1,
        mentions: [{
          kind: 'happier.vendorPlugin',
          ref: 'vendorPlugin:reviewer',
          token: '@reviewer',
          start: 0,
          end: 9,
        }],
        vendorPluginMentions: [{ vendorPluginRef: 'reviewer', label: 'Reviewer' }],
      },
    }))).resolves.toEqual([{ type: 'text', text: 'Review this' }]);
  });
});
