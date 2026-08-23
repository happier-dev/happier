import type { ScmHostingProviderRef } from './pullRequests.js';

/**
 * The joinable identity of one repository on one forge deployment.
 *
 * It is derived from an already RESOLVED `ScmHostingProviderRef` — the SCM
 * owner's own answer for a working copy — and never from a git remote URL, a
 * local path, or a display label. Two observers that resolved the same
 * repository produce equal identities; nothing else does.
 */
export type ScmHostingRepositoryIdentityV1 = Readonly<{
  kind: ScmHostingProviderRef['kind'];
  /** The forge deployment: origin plus the deployment's own base path. */
  deployment: string;
  /** The forge's own repository path, compared case-insensitively. */
  repository: string;
}>;

function stripSurroundingSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Reads the joinable identity, or `null` when the ref cannot prove one.
 *
 * A ref without `nameWithOwner` is a forge binding that never resolved a
 * repository. It yields `null` rather than a deployment-only identity, because
 * a deployment-only identity would match every repository on that forge.
 */
export function readScmHostingRepositoryIdentity(
  hostingProvider: Readonly<{
    kind?: unknown;
    baseUrl?: unknown;
    nameWithOwner?: unknown;
  }> | null | undefined,
): ScmHostingRepositoryIdentityV1 | null {
  if (!hostingProvider) return null;
  const kind = typeof hostingProvider.kind === 'string' ? hostingProvider.kind.trim() : '';
  const baseUrl = typeof hostingProvider.baseUrl === 'string' ? hostingProvider.baseUrl.trim() : '';
  const nameWithOwner = typeof hostingProvider.nameWithOwner === 'string'
    ? stripSurroundingSlashes(hostingProvider.nameWithOwner.trim())
    : '';
  if (!kind || !baseUrl || !nameWithOwner) return null;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;

  const basePath = stripSurroundingSlashes(parsed.pathname);
  return Object.freeze({
    kind: kind as ScmHostingProviderRef['kind'],
    deployment: basePath ? `${parsed.origin}/${basePath}` : parsed.origin,
    repository: nameWithOwner,
  });
}

/**
 * Whether two resolved identities address the same repository.
 *
 * Repository paths are compared case-insensitively: every forge in the
 * `ScmHostingProviderKind` vocabulary treats owner/name as case-insensitive for
 * addressing, so a case difference between two observers is the same
 * repository. The deployment half is compared exactly, because it was already
 * canonicalized by `readScmHostingRepositoryIdentity` through `URL`.
 */
export function sameScmHostingRepositoryIdentity(
  left: ScmHostingRepositoryIdentityV1 | null | undefined,
  right: ScmHostingRepositoryIdentityV1 | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.kind === right.kind
    && left.deployment === right.deployment
    && left.repository.toLowerCase() === right.repository.toLowerCase();
}
