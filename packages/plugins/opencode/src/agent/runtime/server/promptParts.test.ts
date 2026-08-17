import { describe, expect, it } from 'vitest';

import { buildOpenCodePromptParts } from './promptParts.js';

describe('buildOpenCodePromptParts', () => {
  it('preserves text and safe OpenCode mentions without dereferencing structured paths', () => {
    expect(buildOpenCodePromptParts({
      cwd: '/repo',
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
    })).toEqual([
      { type: 'text', text: 'Review this' },
      { type: 'agent', name: 'reviewer' },
      {
        type: 'text',
        text: 'Use the security-review skill for this request.',
      },
    ]);
  });

  it('rejects malformed or unsafe structured image input instead of dropping it', () => {
    expect(() => buildOpenCodePromptParts({
      cwd: '/repo',
      text: '',
      structuredInput: {
        v: 1,
        imageInputs: [{
          id: 'image-1',
          kind: 'image',
          url: 'javascript:alert(1)',
        }],
      },
    })).toThrow('OpenCode server mode does not accept remote image references');
  });

  it('returns typed unsupported for an authorized upload rather than bypassing media verification', () => {
    expect(() => buildOpenCodePromptParts({
      cwd: '/repo',
      text: 'Inspect this image',
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
    })).toThrow('OpenCode server mode cannot consume verified image uploads safely');
  });

  it('accepts an additive mentions field and emits one part per reference (D-4, R-4)', () => {
    // The envelope schema is `.passthrough()`, so `mentions[]` must not trip the
    // `opencode_structured_input_invalid` rejection at the top of the projection.
    expect(buildOpenCodePromptParts({
      cwd: '/repo',
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
    })).toEqual([{ type: 'text', text: 'Review this' }]);
  });
});
