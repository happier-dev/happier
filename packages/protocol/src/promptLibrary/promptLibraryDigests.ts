import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import type { PromptBundleBodyV1 } from './promptBundleSchemas.js';

function computeSha256Digest(value: string): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(value)))}`;
}

export function computePromptDocDigestV1(markdown: string): string {
  return computeSha256Digest(markdown);
}

export function computePromptBundleDigestV1(bundleBody: PromptBundleBodyV1): string {
  const normalizedEntries = [...bundleBody.entries]
    .map((entry) => ({
      path: entry.path,
      contentBase64: entry.contentBase64,
      contentKind: entry.contentKind,
      unixMode: entry.unixMode ?? null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return computeSha256Digest(JSON.stringify({
    v: bundleBody.v,
    entries: normalizedEntries,
  }));
}
