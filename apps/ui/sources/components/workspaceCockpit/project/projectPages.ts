/**
 * Built-in project page declarations. Leaf module (no imports): route registries
 * import it at load, so it must not pull in cockpit, plugin or navigation code.
 */
export const PROJECT_PAGES = ['overview', 'code', 'changes', 'scripts', 'services', 'deployments', 'context', 'memory', 'defaults'] as const;
export type ProjectPageV1 = typeof PROJECT_PAGES[number];
/** Expo and retained-workspace registrations project the same page declarations. */
export const PROJECT_PAGE_ROUTE_NAMES = PROJECT_PAGES.map(page => `projects/[workspaceRefId]/${page}` as const);
