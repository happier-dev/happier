/**
 * The ONE GitLab identity builder.
 *
 * Scan, get, detail and every mutation route through this module, so one merge
 * request can never acquire two identities. It never reads GitLab's instance-global
 * item id: every project-scoped endpoint is addressed by `(project, iid)`, and keying
 * on the global id would invent a translation step that can fail.
 */

import type { GitlabConfiguredOrigin } from './origin.js';
import { gitlabRepositoryEventSourceInstanceId } from '@happier-dev/plugin-sdk/scm';
import { encodeGitlabConfiguredOriginScope } from './origin.js';
import type { GitlabEntryIdentity, GitlabEntryLocator, GitlabKindId } from './types.js';

const KIND_REFERENCE_SEPARATOR: Readonly<Record<GitlabKindId, string>> = {
  'merge-request': '!',
  issue: '#',
};

const KIND_WEB_SEGMENT: Readonly<Record<GitlabKindId, string>> = {
  'merge-request': 'merge_requests',
  issue: 'issues',
};

export type GitlabIdentityInput = Readonly<{
  kindId: GitlabKindId;
  origin: GitlabConfiguredOrigin;
  row: Readonly<Record<string, unknown>>;
}>;

export type GitlabIdentityResult =
  | Readonly<{ kind: 'built'; identity: GitlabEntryIdentity; locator: GitlabEntryLocator }>
  | Readonly<{ kind: 'undecodable'; reason: string }>;

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The full project path, from GitLab's own `references.full` (`group/sub/project!7`).
 * `web_url` is a display fallback only: GitLab has shipped both `/-/issues/7` and
 * `/issues/7` spellings, and `_links.self` addresses the global id rather than the
 * iid — neither is a locator contract.
 */
export function readGitlabProjectPath(
  kindId: GitlabKindId,
  row: Readonly<Record<string, unknown>>,
): string | null {
  const references = readRecord(row.references);
  const full = references ? readNonEmptyString(references.full) : null;
  if (full) {
    const separatorIndex = full.lastIndexOf(KIND_REFERENCE_SEPARATOR[kindId]);
    if (separatorIndex > 0) {
      const path = full.slice(0, separatorIndex);
      if (path.includes('/')) return path.toLowerCase();
    }
  }

  const webUrl = readNonEmptyString(row.web_url);
  if (!webUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(webUrl);
  } catch {
    return null;
  }
  const segment = KIND_WEB_SEGMENT[kindId];
  const match = new RegExp(`^/(.+?)(?:/-)?/${segment}/`, 'u').exec(parsed.pathname);
  const path = match?.[1];
  return path && path.includes('/') ? path.toLowerCase() : null;
}

export function buildGitlabEntryIdentity(input: GitlabIdentityInput): GitlabIdentityResult {
  const projectId = readPositiveInteger(input.row.project_id);
  if (projectId === null) {
    return { kind: 'undecodable', reason: 'missing-project-id' };
  }

  const iid = readPositiveInteger(input.row.iid);
  if (iid === null) {
    return { kind: 'undecodable', reason: 'missing-iid' };
  }
  const entryId = String(iid);

  const repositoryKey = readGitlabProjectPath(input.kindId, input.row);
  if (!repositoryKey) {
    return { kind: 'undecodable', reason: 'missing-project-path' };
  }

  const webUrl = readNonEmptyString(input.row.web_url);
  const absoluteWebUrl = webUrl && /^https?:\/\//iu.test(webUrl) ? webUrl : null;

  return {
    kind: 'built',
    identity: {
      kindId: input.kindId,
      collisionScope: buildGitlabProjectCollisionScope(input.origin, String(projectId)),
      entryId,
    },
    locator: {
      forgeHostId: input.origin.forgeHostId,
      deploymentBaseUrl: input.origin.normalized,
      repositoryKey,
      displayPath: `${repositoryKey}${KIND_REFERENCE_SEPARATOR[input.kindId]}${entryId}`,
      // The routing token is the repository key, verbatim. There is no envelope,
      // no version arm, and nothing a consumer could read a field out of.
      routingToken: repositoryKey,
      webUrl: absoluteWebUrl,
    },
  };
}

/** Project selection and entry identity share this exact immutable project namespace. */
export function buildGitlabProjectCollisionScope(origin: GitlabConfiguredOrigin, projectId: string): string {
  return gitlabRepositoryEventSourceInstanceId(origin.normalized, projectId);
}

/** Comparison repository identity includes the deployment, as native entry identity does. */
export function buildGitlabComparisonRepositoryKey(origin: GitlabConfiguredOrigin, repositoryKey: string): string {
  return `${origin.normalized}/${repositoryKey}`;
}

/**
 * Rejects an identity that did not come from the exact invoked binding. A read
 * answered by another origin is a confidently wrong list, and a scope built from a
 * different origin would silently merge two deployments' entries.
 */
export function isGitlabIdentityWithinOrigin(
  identity: Readonly<{ collisionScope: string }>,
  origin: GitlabConfiguredOrigin,
): boolean {
  const prefix = `gitlab:${encodeGitlabConfiguredOriginScope(origin)}:`;
  if (!identity.collisionScope.startsWith(prefix)) return false;
  return /^[1-9][0-9]*$/u.test(identity.collisionScope.slice(prefix.length));
}

/**
 * Admits the opaque routing token this identity owner mints. The token is the
 * full repository path and is the provider-supported project locator; the
 * collision scope remains identity evidence and is never decoded into a route.
 */
export function readGitlabRepositoryRoutingToken(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) return null;
  if (value !== value.toLowerCase() || value.includes('\\')) return null;
  const segments = value.split('/');
  if (segments.length < 2 || segments.some((segment) => (
    segment === '' || segment === '.' || segment === '..'
  ))) return null;
  return value;
}
