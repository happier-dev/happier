import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPENABLE_CONTENT_MAX_BYTES_V1,
  HARD_OPENABLE_CONTENT_MAX_BYTES_V1,
  OpenableContentReadRequestV1Schema,
  OpenableContentReadResultV1Schema,
  OpenableContentRefV1Schema,
  OpenableContentStatRequestV1Schema,
  PluginOpenableContentViewerContributionV1Schema,
  compareOpenableContentViewerMatchesV1,
  matchOpenableContentViewerV1,
  normalizeOpenableContentViewerSelectorV1,
  normalizeOpenableContentPreferenceSelectorsV1,
  serializeOpenableContentPreferenceSelectorV1,
} from './openableContent.js';

describe('openable workspace content contract', () => {
  it('uses an opaque workspace-file handle rather than a plugin path or raw filename', () => {
    expect(OpenableContentRefV1Schema.parse({ kind: 'workspaceFile', handle: 'm_ABC-123' }))
      .toEqual({ kind: 'workspaceFile', handle: 'm_ABC-123' });
    expect(OpenableContentRefV1Schema.safeParse({
      kind: 'workspaceFile',
      handle: '/workspace/private.txt',
    }).success).toBe(false);
  });

  it('accepts only strict opaque stat requests', () => {
    const ref = { kind: 'workspaceFile' as const, handle: 'm_ABC-123' };
    expect(OpenableContentStatRequestV1Schema.parse({ ref })).toEqual({ ref });
    expect(OpenableContentStatRequestV1Schema.safeParse(ref).success).toBe(false);
    expect(OpenableContentStatRequestV1Schema.safeParse({ ref, extra: true }).success).toBe(false);
  });

  it('accepts only bounded opaque read requests and JSON-safe ready content', () => {
    const ref = { kind: 'workspaceFile' as const, handle: 'm_ABC-123' };
    expect(OpenableContentReadRequestV1Schema.parse({
      ref,
      expectedRevision: 'revision-1',
      maxBytes: 64,
    })).toEqual({
      ref,
      expectedRevision: 'revision-1',
      maxBytes: 64,
    });
    expect(OpenableContentReadRequestV1Schema.parse({
      ref,
      expectedRevision: 'revision-1',
    })).toEqual({
      ref,
      expectedRevision: 'revision-1',
      maxBytes: DEFAULT_OPENABLE_CONTENT_MAX_BYTES_V1,
    });
    expect(OpenableContentReadRequestV1Schema.parse({
      ref,
      expectedRevision: 'revision-1',
      maxBytes: 10_000_000,
    })).toMatchObject({
      ref,
      expectedRevision: 'revision-1',
      maxBytes: 10_000_000,
    });
    expect(OpenableContentReadRequestV1Schema.safeParse({
      ref: { kind: 'workspaceFile', handle: '/private/workspace.txt' },
      expectedRevision: 'revision-1',
      maxBytes: 64,
    }).success).toBe(false);
    expect(OpenableContentReadRequestV1Schema.safeParse({
      ref,
      expectedRevision: 'revision-1',
      maxBytes: 10_000_001,
    }).success).toBe(false);
    expect(HARD_OPENABLE_CONTENT_MAX_BYTES_V1).toBe(10_000_000);

    expect(OpenableContentReadResultV1Schema.parse({
      status: 'ready',
      content: { kind: 'utf8', text: 'hello' },
      revision: 'revision-1',
    })).toEqual({
      status: 'ready',
      content: { kind: 'utf8', text: 'hello' },
      revision: 'revision-1',
    });
    expect(OpenableContentReadResultV1Schema.parse({
      status: 'ready',
      content: { kind: 'base64', base64: 'AAE=' },
      revision: 'revision-1',
    })).toEqual({
      status: 'ready',
      content: { kind: 'base64', base64: 'AAE=' },
      revision: 'revision-1',
    });
    expect(OpenableContentReadResultV1Schema.safeParse({
      status: 'ready',
      bytes: new Uint8Array([0, 1]),
      revision: 'revision-1',
    }).success).toBe(false);
  });

  it('normalizes selectors and uses semantic specificity plus identity, not installation order', () => {
    const markdown = PluginOpenableContentViewerContributionV1Schema.parse({
      id: 'markdown',
      destination: 'markdown-view',
      contentClasses: ['text'],
      mimeTypes: [' TEXT/Markdown '],
      extensions: ['.MD'],
    });
    const text = PluginOpenableContentViewerContributionV1Schema.parse({
      id: 'text',
      destination: 'text-view',
      contentClasses: ['text'],
      mimeTypes: ['text/*'],
    });
    const metadata = { contentClass: 'text' as const, mimeType: 'text/markdown', extension: '.md' };

    const exact = matchOpenableContentViewerV1(markdown, metadata);
    const wildcard = matchOpenableContentViewerV1(text, metadata);
    expect(exact).not.toBeNull();
    expect(wildcard).not.toBeNull();
    expect(compareOpenableContentViewerMatchesV1(
      { identity: { pluginId: 'acme.docs', localId: 'markdown' }, match: exact! },
      { identity: { pluginId: 'acme.docs', localId: 'text' }, match: wildcard! },
    )).toBeLessThan(0);
    expect(markdown.mimeTypes).toEqual(['text/markdown']);
    expect(markdown.extensions).toEqual(['.md']);
    expect(markdown.destination).toBe('markdown-view');
    expect(normalizeOpenableContentViewerSelectorV1({
      contentClasses: ['text'],
      mimeTypes: [' TEXT/Markdown '],
      extensions: ['.MD'],
    })).toEqual({
      contentClasses: ['text'],
      mimeTypes: ['text/markdown'],
      extensions: ['.md'],
    });
    expect(() => normalizeOpenableContentViewerSelectorV1({
      contentClasses: ['text'],
      mimeTypes: ['text/markdown', ' TEXT/MARKDOWN '],
    })).toThrow(/duplicate/i);
  });

  it('requires every viewer to name its direct V2 UI view destination', () => {
    expect(PluginOpenableContentViewerContributionV1Schema.parse({
      id: 'source',
      destination: 'source-view',
      contentClasses: ['text'],
    })).toEqual({
      id: 'source',
      destination: 'source-view',
      contentClasses: ['text'],
    });
    expect(PluginOpenableContentViewerContributionV1Schema.safeParse({
      id: 'missing-destination',
      contentClasses: ['text'],
    }).success).toBe(false);
  });

  it('serializes persisted preference selectors through the same canonical MIME, extension, and class owner', () => {
    expect(serializeOpenableContentPreferenceSelectorV1({
      kind: 'mime', value: ' TEXT/Markdown ',
    })).toBe('mime:text/markdown');
    expect(serializeOpenableContentPreferenceSelectorV1({
      kind: 'extension', value: '.MD',
    })).toBe('extension:.md');
    expect(normalizeOpenableContentPreferenceSelectorsV1([
      { kind: 'class', value: 'text' },
      { kind: 'mime', value: 'text/markdown' },
    ])).toEqual([
      { kind: 'class', value: 'text' },
      { kind: 'mime', value: 'text/markdown' },
    ]);
    expect(() => normalizeOpenableContentPreferenceSelectorsV1([
      { kind: 'mime', value: 'text/markdown' },
      { kind: 'mime', value: ' TEXT/MARKDOWN ' },
    ])).toThrow(/duplicate/i);
  });
});
