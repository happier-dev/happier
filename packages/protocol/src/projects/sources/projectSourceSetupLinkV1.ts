/** Public import leaf. The Home carrier is an address, never a grant or content key. */
export const PROJECT_SOURCE_SETUP_ROUTE_V1 = '/projects/setup';

export type ProjectSourceSetupSelectionV1 = Readonly<{ sourceId: string; homeTarget: string }>;

/** Route params and external links enter the same selection parser before any Source read. */
export function readProjectSourceSetupSelectionV1(params: Readonly<{
  source?: string | readonly string[] | null;
  target?: string | readonly string[] | null;
}>): ProjectSourceSetupSelectionV1 | null {
  if (typeof params.source !== 'string' || typeof params.target !== 'string') return null;
  const sourceId = params.source.trim();
  const homeTarget = params.target.trim();
  // `new` is the Source collection's creation sentinel, never a saved Source selection.
  return sourceId && sourceId !== 'new' && homeTarget ? { sourceId, homeTarget } : null;
}

export function projectSourceSetupRouteV1(selection: ProjectSourceSetupSelectionV1): `/projects/setup?${string}` {
  const admitted = readProjectSourceSetupSelectionV1({ source: selection.sourceId, target: selection.homeTarget });
  if (!admitted) throw new Error('Source setup link requires a saved Source and portable Home target');
  return `${PROJECT_SOURCE_SETUP_ROUTE_V1}?source=${encodeURIComponent(admitted.sourceId)}&target=${encodeURIComponent(admitted.homeTarget)}`;
}

/** One link producer for the Home (Source reads) and the client: the Home's application origin and carrier. */
export function buildProjectSourceSetupUrlV1(input: ProjectSourceSetupSelectionV1 & Readonly<{ applicationOrigin: string }>): string {
  const origin = new URL(input.applicationOrigin);
  if ((origin.protocol !== 'https:' && origin.protocol !== 'http:') || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('Source setup application origin must be an HTTP address without credentials, query or fragment');
  }
  return `${origin.origin}${origin.pathname.replace(/\/+$/, '')}${projectSourceSetupRouteV1(input)}`;
}
