import type { AzureDevOpsOrigin, AzureDevOpsOriginResult } from './types.js';

/**
 * Normalize the explicitly configured Azure DevOps base.
 *
 * `baseUrl` may carry a base path — `https://dev.azure.com/acme` on the service, and an
 * arbitrary host plus collection path on Azure DevOps Server. The scheme and host are
 * normalized because they are case-insensitive by RFC 3986; **the path is not**, because a
 * collection path is case-significant and lowercasing it would collapse distinct deployments
 * into one identity.
 *
 * Nothing here classifies the deployment. Services-versus-Server is an observed fact read
 * from the provider, never a guess made from a hostname.
 */
export function normalizeAzureDevOpsBaseUrl(raw: string): AzureDevOpsOriginResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'invalid_url' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'https:') return { ok: false, reason: 'insecure_scheme' };
  // A credential embedded in the configured base would become a second credential owner.
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, reason: 'unsupported_url_form' };
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    return { ok: false, reason: 'unsupported_url_form' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0) return { ok: false, reason: 'invalid_url' };

  const port = parsed.port === '' || parsed.port === '443' ? '' : `:${parsed.port}`;
  const forgeHostId = `${hostname}${port}`;
  const requestOrigin = `https://${forgeHostId}`;

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  const path = segments.length > 0 ? `/${segments.join('/')}` : '';
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] ?? null : null;

  return {
    ok: true,
    origin: {
      baseUrl: `${requestOrigin}${path}`,
      requestOrigin,
      forgeHostId,
      organizationOrCollection: lastSegment === null ? null : decodePathSegment(lastSegment),
    },
  };
}

/**
 * `organization/project/repo`, case preserved.
 *
 * This is a locator, never identity: Azure project and repository names are mutable and old
 * names keep resolving indefinitely, so a name that reached a scope would silently key one
 * repository as two things.
 */
export function buildAzureRepositoryKey(input: Readonly<{
  organizationOrCollection: string | null;
  forgeHostId: string;
  projectName: string;
  repositoryName: string;
}>): string {
  const organization = input.organizationOrCollection ?? input.forgeHostId;
  return `${organization}/${input.projectName}/${input.repositoryName}`;
}

/** One Azure source-owned decoding of its opaque `repositoryKey` locator token. */
export function parseAzureRepositoryKey(input: Readonly<{
  origin: AzureDevOpsOrigin;
  repositoryKey: string;
}>): Readonly<{ projectName: string; repositoryName: string }> | null {
  const organization = input.origin.organizationOrCollection ?? input.origin.forgeHostId;
  const prefix = `${organization}/`;
  if (!input.repositoryKey.startsWith(prefix)) return null;

  const segments = input.repositoryKey.slice(prefix.length).split('/');
  if (segments.length !== 2) return null;
  const [projectName, repositoryName] = segments;
  if (projectName === undefined || projectName.length === 0) return null;
  if (repositoryName === undefined || repositoryName.length === 0) return null;

  // Rebuild through the one encoder before using the values in a provider route. A locator that
  // is merely similar to our source-minted key is stale or foreign, not an alternate grammar.
  return buildAzureRepositoryKey({
    organizationOrCollection: input.origin.organizationOrCollection,
    forgeHostId: input.origin.forgeHostId,
    projectName,
    repositoryName,
  }) === input.repositoryKey
    ? { projectName, repositoryName }
    : null;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
