/**
 * Case-insensitive response-header reading.
 *
 * HTTP header names are case-insensitive and GitLab's own documentation spells the
 * same header two ways across pages, so every read in this corridor goes through here.
 */
export interface GitlabResponseHeaders {
  get(name: string): string | null;
}

/** Wraps a plain record — used by fixtures and by any fetcher that returns one. */
export function createGitlabResponseHeaders(
  record: Readonly<Record<string, string>>,
): GitlabResponseHeaders {
  const lowered = new Map<string, string>();
  for (const [name, value] of Object.entries(record)) {
    lowered.set(name.toLowerCase(), value);
  }
  return { get: (name: string) => lowered.get(name.toLowerCase()) ?? null };
}
