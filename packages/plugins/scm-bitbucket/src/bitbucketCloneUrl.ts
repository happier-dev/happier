import { isRecord, readTrimmedString } from '@happier-dev/plugin-sdk';

/**
 * Reads one provider-published clone link without deriving a URL from mutable
 * repository presentation. Both the repository operations adapter and the
 * Triage source consume Bitbucket's same `links.clone` shape, so this is the
 * one raw boundary decoder for that provider fact.
 */
export function readBitbucketCloneUrl(
  raw: unknown,
  transport: 'https' | 'ssh',
): string | null {
  const cloneLinks = isRecord(raw) && isRecord(raw.links) ? raw.links.clone : undefined;
  if (!Array.isArray(cloneLinks)) return null;

  for (const link of cloneLinks) {
    if (!isRecord(link) || readTrimmedString(link.name)?.toLowerCase() !== transport) continue;
    const href = readTrimmedString(link.href);
    if (href !== null) return href;
  }
  return null;
}
