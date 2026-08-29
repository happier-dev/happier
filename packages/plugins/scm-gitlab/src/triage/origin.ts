/**
 * Configured-origin normalization and V1 deployment admission.
 *
 * Every GitLab read reaches an origin that came from the connected account's binding,
 * verbatim. It is never derived from a git remote's authority, never re-spelled, and
 * never defaulted to gitlab.com because a host looked familiar.
 */

import type { GitlabFailure } from './types.js';

/** The public SaaS deployment, separately granted without private-network reach. */
export const GITLAB_PUBLIC_ORIGIN = 'https://gitlab.com';

export type GitlabConfiguredOrigin = Readonly<{
  /** Scheme + host + non-default port, lowercased. */
  origin: string;
  /** Optional path prefix, case preserved, no trailing slash. Empty when absent. */
  pathPrefix: string;
  /** `origin + pathPrefix` — the value identity and API routes are built from. */
  normalized: string;
  /** Host plus non-default port. */
  forgeHostId: string;
}>;

/**
 * Returns `null` rather than throwing or guessing for an unusable base URL: an empty
 * host, embedded userinfo, or a port outside 1..65535.
 */
export function normalizeGitlabConfiguredBaseUrl(baseUrl: string): GitlabConfiguredOrigin | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!parsed.hostname || parsed.protocol.toLowerCase() !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }

  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  // WHATWG URL parsing already erases HTTPS's default port.
  const forgeHostId = parsed.port === '' ? host : `${host}:${parsed.port}`;
  const origin = `${scheme}//${forgeHostId}`;

  // The prefix is a real deployment configuration and is NOT lowercased: only the
  // scheme and host are case-insensitive.
  const rawPath = parsed.pathname.replace(/\/+$/u, '');
  const pathPrefix = rawPath === '/' ? '' : rawPath;

  return { origin, pathPrefix, normalized: `${origin}${pathPrefix}`, forgeHostId };
}

export type GitlabDeploymentAdmission =
  | Readonly<{ kind: 'admitted'; origin: GitlabConfiguredOrigin }>
  | Readonly<{ kind: 'rejected'; failure: GitlabFailure }>;

/**
 * Admits the exact configured HTTPS base. Deployment version and edition are not
 * guessed or probed: unsupported provider behavior remains a typed operation
 * failure from the endpoint that actually owns it.
 */
export function admitGitlabV1Deployment(baseUrl: string): GitlabDeploymentAdmission {
  const origin = normalizeGitlabConfiguredBaseUrl(baseUrl);
  if (!origin) {
    return {
      kind: 'rejected',
      failure: {
        class: 'unsupportedContract',
        code: 'configured-base-unusable',
        detail: 'The configured GitLab base URL must be an HTTPS base without credentials, query, or fragment.',
      },
    };
  }
  return { kind: 'admitted', origin };
}

/** `base64url` of the normalized configured origin — the identity scope component. */
export function encodeGitlabConfiguredOriginScope(origin: GitlabConfiguredOrigin): string {
  return Buffer.from(origin.normalized, 'utf8').toString('base64url');
}
