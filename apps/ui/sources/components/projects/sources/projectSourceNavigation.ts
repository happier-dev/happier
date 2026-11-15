/** Projects › Sources, optionally opening one saved Source in the existing editor. */
export const PROJECT_SOURCES_ROUTE = '/projects/sources';

export function projectSourceRoute(sourceId: string | null): typeof PROJECT_SOURCES_ROUTE | `${typeof PROJECT_SOURCES_ROUTE}?source=${string}` {
  return sourceId
    ? `${PROJECT_SOURCES_ROUTE}?source=${encodeURIComponent(sourceId)}`
    : PROJECT_SOURCES_ROUTE;
}
