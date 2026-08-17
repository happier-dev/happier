import { GITHUB_API_ORIGIN } from '../observations/githubProviderContracts.js';

import {
  MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
  MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
} from '@happier-dev/triage-protocol/v1';

import type { GithubTriageEntryLocatorV1 } from './types.js';

/**
 * Locator material. `routingToken` IS the repository key (`owner/name`, lowercased),
 * verbatim: no envelope, no version arm, nothing to decode, and therefore no accidental
 * second identity to read a field out of.
 *
 * Every value here is replaced by the next observation. None of it is ever compared for
 * identity, and none of it carries an origin, a credential, or a local path.
 */

/** One path segment of a GitHub owner or repository name. */
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;

export type GithubRepositoryRouteV1 = Readonly<{ owner: string; name: string }>;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Composes the locator half: `owner/name`, lowercased (§2.2.3). */
export function buildGithubRepositoryKey(input: Readonly<{
  owner: unknown;
  name: unknown;
}>): string | null {
  const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!REPOSITORY_SEGMENT_PATTERN.test(owner) || !REPOSITORY_SEGMENT_PATTERN.test(name)) {
    return null;
  }
  const key = `${owner}/${name}`.toLowerCase();
  return utf8ByteLength(key) <= MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1 ? key : null;
}

/**
 * Reads a stored routing token back into an API route. A missing, malformed, or
 * origin-bearing token yields `null`; the caller must then return `unresolved` rather
 * than synthesize a path from identity, display text, or a git remote.
 */
export function parseGithubRoutingToken(value: unknown): GithubRepositoryRouteV1 | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || utf8ByteLength(candidate) > MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1) {
    return null;
  }
  const segments = candidate.split('/');
  if (segments.length !== 2) return null;
  const [owner, name] = segments;
  if (owner === undefined || name === undefined) return null;
  if (!REPOSITORY_SEGMENT_PATTERN.test(owner) || !REPOSITORY_SEGMENT_PATTERN.test(name)) {
    return null;
  }
  return Object.freeze({ owner, name });
}

/**
 * A forge that returns a relative URL yields `null`, never a host-relative string a
 * consumer might resolve against the wrong origin.
 */
export function readGithubAbsoluteWebUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const absolute = parsed.toString();
  // A location is never truncated into a shorter destination: an over-bound URL is
  // omitted so the row keeps its identity instead of pointing somewhere else.
  return utf8ByteLength(absolute) <= MAX_TRIAGE_LOCATION_UTF8_BYTES_V1 ? absolute : null;
}

export function buildGithubEntryLocator(input: Readonly<{
  owner: unknown;
  name: unknown;
  /** Native item number; renders as the `owner/name#number` display path. */
  entryNumber: string;
  webUrl: unknown;
}>): GithubTriageEntryLocatorV1 | null {
  const repositoryKey = buildGithubRepositoryKey({ owner: input.owner, name: input.name });
  if (repositoryKey === null) return null;
  const displayPath = `${repositoryKey}#${input.entryNumber}`;
  // `displayPath` is bounded display text at the target. A row whose path does not fit
  // has no shorter honest form, so it is not emitted rather than shown truncated.
  if (utf8ByteLength(displayPath) > MAX_TRIAGE_TEXT_UTF8_BYTES_V1) return null;
  return Object.freeze({
    routingToken: repositoryKey,
    displayPath,
    webUrl: readGithubAbsoluteWebUrl(input.webUrl),
  });
}

/** Builds an `https://api.github.com` route from a validated repository route. */
export function buildGithubApiUrl(segments: readonly string[]): string {
  const path = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return `${GITHUB_API_ORIGIN}/${path}`;
}
