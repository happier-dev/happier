import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { computePromptBundleDigestV1, computePromptDocDigestV1 } from './promptLibraryDigests.js';

describe('promptLibraryDigests', () => {
  it('hashes exact prompt text with SHA-256', () => {
    expect(computePromptDocDigestV1('# hello'))
      .toBe('sha256:ea67f39f2a707e536439ee31e49fdd586b4a8437d3408f0466112d040cd06681');
    expect(computePromptDocDigestV1('# hello')).not.toBe(computePromptDocDigestV1('# hello there'));
  });

  it('binds bundle contents independently of timestamps and entry order', () => {
    const bundle = {
      v: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      entries: [
        { path: 'b.txt', contentBase64: 'Yg==', contentKind: 'utf8' },
        { path: 'a.txt', contentBase64: 'YQ==', contentKind: 'utf8' },
      ],
    } satisfies Parameters<typeof computePromptBundleDigestV1>[0];
    const left = computePromptBundleDigestV1(bundle);
    const right = computePromptBundleDigestV1({
      ...bundle,
      createdAtMs: 2,
      updatedAtMs: 2,
      entries: [...bundle.entries].reverse(),
    });

    expect(left).toBe(right);
    expect(computePromptBundleDigestV1({
      ...bundle,
      entries: bundle.entries.map(entry => ({ ...entry, contentBase64: 'Yw==' })),
    })).not.toBe(left);
  });

  it('emits a dist module that does not depend on node crypto builtins', async () => {
    const distPath = new URL('../../../dist/prompts/library/promptLibraryDigests.js', import.meta.url);
    const distSource = await readFile(distPath, 'utf8');

    expect(distSource).not.toContain('node:crypto');
  });
});
