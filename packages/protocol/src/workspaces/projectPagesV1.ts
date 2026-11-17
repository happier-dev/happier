/** Built-in Project pages shared by route declarations and closed origin schemas. */
export const PROJECT_PAGES = ['overview', 'code', 'changes', 'scripts', 'services', 'deployments', 'context', 'memory', 'defaults'] as const;
export type ProjectPageV1 = typeof PROJECT_PAGES[number];
