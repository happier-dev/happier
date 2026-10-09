import {
  normalizeProjectSourceSubdirV1,
  type ProjectSourceRepositorySelectorV1,
  type ProjectSourceV1,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { t } from '@/text';

/**
 * The repository address a person reads and types on a Source ("github.com/happier-dev/happier").
 *
 * A Source stores a resolved repository selector (forge deployment + owner/name). This is the one
 * text form of it: the rail's subtitle, the detail's meta line and the Address field all format
 * through here. Address resolution belongs to the Machine's SCM hosting provider registry.
 */
type ProviderValue = ProjectSourceRepositorySelectorV1['provider'];

function readProviderHost(provider: ProviderValue): string | null {
  try {
    const base = new URL(provider.baseUrl);
    return `${base.host}${base.pathname.replace(/\/+$/u, '')}`;
  } catch { return null; }
}

/** "github.com/happier-dev/happier", or the owner/name alone when the deployment is unknown. */
export function formatProjectSourceAddress(
  selector: ProjectSourceRepositorySelectorV1,
): string {
  const host = readProviderHost(selector.provider);
  const name = selector.repository.nameWithOwner;
  return host ? `${host}/${name}` : name;
}

/** "happier-dev/happier · v0.3 · apps/ios": the facts a list row needs to tell Sources apart. */
export function describeProjectSourceRow(
  source: Pick<ProjectSourceV1, 'repository' | 'defaultRef' | 'subdir'>,
  wholeRepositoryLabel = t('projects.sources.wholeRepository'),
): string {
  return [
    source.repository.repository.nameWithOwner,
    source.defaultRef,
    normalizeProjectSourceSubdirV1(source.subdir) ?? wholeRepositoryLabel,
  ]
    .filter(Boolean)
    .join(' · ');
}
