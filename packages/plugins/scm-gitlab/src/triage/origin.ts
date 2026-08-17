/**
 * Configured-origin normalization and V1 deployment admission.
 *
 * Every GitLab read reaches an origin that came from the connected account's binding,
 * verbatim. It is never derived from a git remote's authority, never re-spelled, and
 * never defaulted to gitlab.com because a host looked familiar.
 */

import type { GitlabFailure } from './types.js';

/** The one deployment V1 admits. */
export const GITLAB_V1_ADMITTED_ORIGIN = 'https://gitlab.com';

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

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'https:': '443',
  'http:': '80',
  'ssh:': '22',
};

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
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }

  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const defaultPort = DEFAULT_PORTS[scheme];
  const keepPort = parsed.port !== '' && parsed.port !== defaultPort;
  const forgeHostId = keepPort ? `${host}:${parsed.port}` : host;
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
 * V1 admits GitLab.com and nothing else. Every other normalized origin — including
 * every self-managed deployment — is rejected here, before any item call. No
 * `/version` read, edition inference, feature probe, or per-endpoint fallback runs.
 */
export function admitGitlabV1Deployment(baseUrl: string): GitlabDeploymentAdmission {
  const origin = normalizeGitlabConfiguredBaseUrl(baseUrl);
  if (!origin) {
    return {
      kind: 'rejected',
      failure: {
        class: 'unsupportedContract',
        code: 'self-managed-floor-unset',
        detail: 'The configured GitLab base URL is not a usable origin.',
      },
    };
  }
  if (origin.normalized !== GITLAB_V1_ADMITTED_ORIGIN) {
    return {
      kind: 'rejected',
      failure: {
        class: 'unsupportedContract',
        code: 'self-managed-floor-unset',
        detail: 'Only the gitlab.com deployment is available.',
      },
    };
  }
  return { kind: 'admitted', origin };
}

/** `base64url` of the normalized configured origin — the identity scope component. */
export function encodeGitlabConfiguredOriginScope(origin: GitlabConfiguredOrigin): string {
  return Buffer.from(origin.normalized, 'utf8').toString('base64url');
}
