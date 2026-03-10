import { createHash } from 'node:crypto';

import type { PromptBundleBodyV1 } from './promptBundleSchemas.js';

export function computePromptDocDigestV1(markdown: string): string {
  const hash = createHash('sha256');
  hash.update(markdown, 'utf8');
  return `sha256:${hash.digest('hex')}`;
}

export function computePromptBundleDigestV1(bundleBody: PromptBundleBodyV1): string {
  const hash = createHash('sha256');
  const normalizedEntries = [...bundleBody.entries]
    .map((entry) => ({
      path: entry.path,
      contentBase64: entry.contentBase64,
      contentKind: entry.contentKind,
      unixMode: entry.unixMode ?? null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  hash.update(JSON.stringify({
    v: bundleBody.v,
    entries: normalizedEntries,
  }));
  return `sha256:${hash.digest('hex')}`;
}
