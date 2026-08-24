import {
  ScmHostingProviderKindSchema,
  type ScmHostingProviderRef,
} from './pullRequests.js';

/**
 * The joinable identity of one repository on one forge deployment.
 *
 * It is derived from an already RESOLVED `ScmHostingProviderRef` — the SCM
 * owner's own answer for a working copy — and never from a git remote URL, a
 * local path, or a display label. Two observers that resolved the same
 * repository produce equal identities; nothing else does.
 */
export type ScmHostingRepositoryIdentityV1<
  TKind extends ScmHostingProviderRef['kind'] = ScmHostingProviderRef['kind'],
> = Readonly<{
  kind: TKind;
  /** The forge deployment: origin plus the deployment's own base path. */
  deployment: string;
  /** The forge's source-canonical comparable repository identity. */
  repository: string;
}>;

const CASE_INSENSITIVE_REPOSITORY_KINDS = new Set<ScmHostingProviderRef['kind']>([
  'github',
  'gitlab',
  'bitbucket',
]);

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
export function normalizeScmHostingRepositoryIdentity<TKind extends ScmHostingProviderRef['kind']>(
  value: Readonly<{
    kind: TKind;
    deployment?: unknown;
    repository?: unknown;
  }>,
): ScmHostingRepositoryIdentityV1<TKind> | null;
export function normalizeScmHostingRepositoryIdentity(
  value: Readonly<{
    kind?: unknown;
    deployment?: unknown;
    repository?: unknown;
  }> | null | undefined,
): ScmHostingRepositoryIdentityV1 | null;
export function normalizeScmHostingRepositoryIdentity(
  value: Readonly<{
    kind?: unknown;
    deployment?: unknown;
    repository?: unknown;
  }> | null | undefined,
): ScmHostingRepositoryIdentityV1 | null {
  if (!value) return null;
  const kind = ScmHostingProviderKindSchema.safeParse(value.kind);
  const deployment = typeof value.deployment === 'string' ? value.deployment.trim() : '';
  const repository = typeof value.repository === 'string'
    ? stripSurroundingSlashes(value.repository.trim())
    : '';
  if (!kind.success || !deployment || !repository) return null;

  let parsed: URL;
  try {
    parsed = new URL(deployment);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;

  const basePath = stripSurroundingSlashes(parsed.pathname);
  return Object.freeze({
    kind: kind.data,
    deployment: basePath ? `${parsed.origin}/${basePath}` : parsed.origin,
    repository: CASE_INSENSITIVE_REPOSITORY_KINDS.has(kind.data)
      ? repository.toLowerCase()
      : repository,
  });
}

export function readScmHostingRepositoryIdentity(
  hostingProvider: Readonly<{
    kind?: unknown;
    baseUrl?: unknown;
    nameWithOwner?: unknown;
  }> | null | undefined,
): ScmHostingRepositoryIdentityV1 | null {
  return normalizeScmHostingRepositoryIdentity(hostingProvider
    ? {
        kind: hostingProvider.kind,
        deployment: hostingProvider.baseUrl,
        repository: hostingProvider.nameWithOwner,
      }
    : hostingProvider);
}

/**
 * Whether two resolved identities address the same repository.
 *
 * Every component is compared exactly. Repository case rules are source-owned:
 * the source publishes its canonical comparable repository identity and the
 * working snapshot publishes the corresponding canonical identity. Applying a
 * universal case fold here would silently apply one forge's addressing rules to
 * every other forge, including custom/self-hosted deployments whose repository
 * paths may be case-sensitive.
 */
export function sameScmHostingRepositoryIdentity(
  left: ScmHostingRepositoryIdentityV1 | null | undefined,
  right: ScmHostingRepositoryIdentityV1 | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.kind === right.kind
    && left.deployment === right.deployment
    && left.repository === right.repository;
}
