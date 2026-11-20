/** `sha256:` and the first 12 hex digits: enough to tell two catalog contents apart at a glance. */
export function formatContentDigestPrefix(digest: string): string {
  const [algorithm, hex] = digest.includes(':') ? digest.split(':', 2) as [string, string] : ['', digest];
  return `${algorithm ? `${algorithm}:` : ''}${hex.slice(0, 12)}`;
}
