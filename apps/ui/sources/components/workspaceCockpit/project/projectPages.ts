/**
 * Route registries import this leaf at load. Its Protocol vocabulary is import-free,
 * so it does not pull in cockpit, plugin or navigation code.
 */
import { PROJECT_PAGES } from '@happier-dev/protocol/workspaces/projectPagesV1';
export { PROJECT_PAGES, type ProjectPageV1 } from '@happier-dev/protocol/workspaces/projectPagesV1';
/** Expo and retained-workspace registrations project the same page declarations. */
export const PROJECT_PAGE_ROUTE_NAMES = PROJECT_PAGES.map(page => `projects/[workspaceRefId]/${page}` as const);
