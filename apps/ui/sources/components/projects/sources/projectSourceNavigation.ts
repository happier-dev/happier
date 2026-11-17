import { isAcceptedHappierUrlProtocol } from '@/utils/url/appScheme';

/** Projects › Sources, optionally opening one saved Source in the existing editor. */
export const PROJECT_SOURCES_ROUTE = '/projects/sources';

export function projectSourceRoute(sourceId: string | null): typeof PROJECT_SOURCES_ROUTE | `${typeof PROJECT_SOURCES_ROUTE}?source=${string}` {
  return sourceId
    ? `${PROJECT_SOURCES_ROUTE}?source=${encodeURIComponent(sourceId)}`
    : PROJECT_SOURCES_ROUTE;
}

/** Public import leaf. The Home carrier is an address, never a grant or content key. */
export const PROJECT_SOURCE_SETUP_ROUTE = '/projects/setup';

export type ProjectSourceSetupSelection = Readonly<{ sourceId: string; homeTarget: string }>;
export type ProjectSourceSetupLink = ProjectSourceSetupSelection & Readonly<{ path: `/projects/setup?${string}` }>;

/** Route params and external links enter the same selection parser before any Source read. */
export function readProjectSourceSetupSelection(params: Readonly<{
  source?: string | readonly string[] | null;
  target?: string | readonly string[] | null;
}>): ProjectSourceSetupSelection | null {
  if (typeof params.source !== 'string' || typeof params.target !== 'string') return null;
  const sourceId = params.source.trim();
  const homeTarget = params.target.trim();
  // `new` is the Source collection's creation sentinel, never a saved Source selection.
  return sourceId && sourceId !== 'new' && homeTarget ? { sourceId, homeTarget } : null;
}

export function projectSourceSetupRoute(selection: ProjectSourceSetupSelection): `/projects/setup?${string}` {
  const admitted = readProjectSourceSetupSelection({ source: selection.sourceId, target: selection.homeTarget });
  if (!admitted) throw new Error('Source setup link requires a saved Source and portable Home target');
  return `${PROJECT_SOURCE_SETUP_ROUTE}?source=${encodeURIComponent(admitted.sourceId)}&target=${encodeURIComponent(admitted.homeTarget)}`;
}

/** Uses the Home link producer's opaque carrier without inventing a second descriptor codec. */
export function buildProjectSourceSetupUrl(input: ProjectSourceSetupSelection & Readonly<{ applicationOrigin: string }>): string {
  const origin = new URL(input.applicationOrigin);
  if ((origin.protocol !== 'https:' && origin.protocol !== 'http:') || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('Source setup application origin must be an HTTP address without credentials, query or fragment');
  }
  return `${origin.origin}${origin.pathname.replace(/\/+$/, '')}${projectSourceSetupRoute(input)}`;
}

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
  const selection = readProjectSourceSetupSelection({ source: url.searchParams.get('source'), target: url.searchParams.get('target') });
  return selection ? { ...selection, path: projectSourceSetupRoute(selection) } : null;
}
