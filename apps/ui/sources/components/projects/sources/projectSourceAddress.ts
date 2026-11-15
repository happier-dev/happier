import {
  normalizeProjectSourceSubdirV1,
  type ProjectSourceRepositorySelectorV1,
  type ProjectSourceV1,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';

/**
 * The repository address a person reads and types on a Source ("github.com/happier-dev/happier").
 *
 * A Source stores a resolved repository selector (forge deployment + owner/name). This is the one
 * text form of it: the rail's subtitle, the detail's meta line and the Address field all format
 * through here. Address resolution belongs to the Machine's SCM hosting provider registry.
 */
type ProviderValue = ProjectSourceRepositorySelectorV1['provider'];

function readDeploymentHost(baseUrl: string): string | null {
  try {
    const base = new URL(baseUrl);
    return `${base.host}${base.pathname.replace(/\/+$/u, '')}`;
  } catch { return null; }
}

function readProviderHost(provider: ProviderValue): string | null {
  return readDeploymentHost(provider.baseUrl);
}

/**
 * Whether typed text reads as a repository link — a web address, a host path like this file's own
 * "github.com/owner/name", or an scp-style "git@host:owner/name" — rather than search words. Only such text
 * is sent to a Machine's hosting owner, which alone decides what it names.
 */
export function isRepositoryAddressCandidate(text: string): boolean {
  const value = text.trim();
  if (!value || /\s/u.test(value)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/[^/]+\/[^/]+/iu.test(value)
    || /^[^@/:]+@[^/:]+\.[^/:]+:[^/]+\/[^/]+/u.test(value)
    || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/[^/]+\/[^/]+/iu.test(value);
}

/** "github.com/happier-dev/happier", or the owner/name alone when the deployment is unknown. */
export function formatProjectSourceAddress(
  selector: ProjectSourceRepositorySelectorV1,
): string {
  const host = readProviderHost(selector.provider);
  const name = selector.repository.nameWithOwner;
  return host ? `${host}/${name}` : name;
}

/**
 * The same text form for a checkout whose repository the SCM owner already resolved (its accepted ref's
 * `repositoryIdentity`), so saving that checkout as a Source starts on its own address. Null when the
 * forge deployment is not a readable web address.
 */
export function formatRepositoryIdentityAddress(
  identity: Readonly<{ deployment: string; repository: string }>,
): string | null {
  const host = readDeploymentHost(identity.deployment);
  return host ? `${host}/${identity.repository}` : null;
}

/**
 * "happier-dev/happier · v0.3 · apps/ios": the facts a list row needs to tell Sources apart. The whole
 * repository is the quiet default and stays unsaid; a folder is named only when one is chosen.
 */
export function describeProjectSourceRow(
  source: Pick<ProjectSourceV1, 'repository' | 'defaultRef' | 'subdir'> & Partial<Pick<ProjectSourceV1, 'name'>>,
): string {
  if (!source.repository) return source.name ?? '';
  return [
    source.repository.repository.nameWithOwner,
    source.defaultRef,
    normalizeProjectSourceSubdirV1(source.subdir),
  ]
    .filter(Boolean)
    .join(' · ');
}
