import { isAcceptedHappierUrlProtocol } from '@/utils/url/appScheme';
import { projectSourceSetupRouteV1, readProjectSourceSetupSelectionV1,
  type ProjectSourceSetupSelectionV1 } from '@happier-dev/protocol/projects/sources/projectSourceSetupLinkV1';

/** Projects › Sources, optionally opening one saved Source in the existing editor. */
export const PROJECT_SOURCES_ROUTE = '/projects/sources';

export function projectSourceRoute(sourceId: string | null): typeof PROJECT_SOURCES_ROUTE | `${typeof PROJECT_SOURCES_ROUTE}?source=${string}` {
  return sourceId
    ? `${PROJECT_SOURCES_ROUTE}?source=${encodeURIComponent(sourceId)}`
    : PROJECT_SOURCES_ROUTE;
}

export {
  PROJECT_SOURCE_SETUP_ROUTE_V1 as PROJECT_SOURCE_SETUP_ROUTE,
  readProjectSourceSetupSelectionV1 as readProjectSourceSetupSelection,
  projectSourceSetupRouteV1 as projectSourceSetupRoute,
  buildProjectSourceSetupUrlV1 as buildProjectSourceSetupUrl,
  type ProjectSourceSetupSelectionV1 as ProjectSourceSetupSelection,
} from '@happier-dev/protocol/projects/sources/projectSourceSetupLinkV1';
export type ProjectSourceSetupLink = ProjectSourceSetupSelectionV1 & Readonly<{ path: `/projects/setup?${string}` }>;

/** One codec for web universal links, native schemes and internal navigation. */
export function parseProjectSourceSetupLink(raw: string): ProjectSourceSetupLink | null {
  let url: URL;
  try { url = new URL(raw, 'https://source-setup.invalid'); } catch { return null; }
  let pathname = url.pathname;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    if (!isAcceptedHappierUrlProtocol(url.protocol)) return null;
    pathname = url.hostname ? `/${url.hostname}${pathname === '/' ? '' : pathname}` : pathname;
  }
  if (!/(?:^|\/)projects\/setup\/?$/u.test(pathname)) return null;
  if (url.searchParams.getAll('source').length !== 1 || url.searchParams.getAll('target').length !== 1) return null;
  const selection = readProjectSourceSetupSelectionV1({ source: url.searchParams.get('source'), target: url.searchParams.get('target') });
  return selection ? { ...selection, path: projectSourceSetupRouteV1(selection) } : null;
}
