import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { computePromptBundleDigestV1, computePromptDocDigestV1 } from './promptLibraryDigests.js';

describe('promptLibraryDigests', () => {
  it('computes a stable prompt doc digest', () => {
    expect(computePromptDocDigestV1('# hello')).toBe(computePromptDocDigestV1('# hello'));
    expect(computePromptDocDigestV1('# hello')).not.toBe(computePromptDocDigestV1('# hello there'));
  });

  it('computes a stable prompt bundle digest independent of entry order', () => {
    const left = computePromptBundleDigestV1({
      v: 1,
      createdAtMs: 1,
      updatedAtMs: 1,
      entries: [
        { path: 'b.txt', contentBase64: 'Yg==', contentKind: 'utf8' },
        { path: 'a.txt', contentBase64: 'YQ==', contentKind: 'utf8' },
      ],
    });
    const right = computePromptBundleDigestV1({
      v: 1,
      createdAtMs: 2,
      updatedAtMs: 2,
      entries: [
        { path: 'a.txt', contentBase64: 'YQ==', contentKind: 'utf8' },
        { path: 'b.txt', contentBase64: 'Yg==', contentKind: 'utf8' },
      ],
    });

    expect(left).toBe(right);
  });

  it('emits a dist module that does not depend on node crypto builtins', async () => {
    const distPath = new URL('../../dist/promptLibrary/promptLibraryDigests.js', import.meta.url);
    const distSource = await readFile(distPath, 'utf8');

    expect(distSource).not.toContain('node:crypto');
  });
});
