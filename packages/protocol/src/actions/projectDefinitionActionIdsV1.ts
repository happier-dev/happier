
/** Action identity leaf: schema modules and the registry share these constants. */
export const PROJECT_DEFINITION_ACTION_IDS = ['projects.inspect', 'projects.manifest.update'] as const;

/** One method vocabulary for Action declarations and signed RPC admission. */
export const PROJECT_DEFINITION_ACTION_RPC_METHODS_V1 = {
  'projects.inspect': 'daemon.projects.inspect.v1',
  'projects.manifest.update': 'daemon.projects.manifest.update.v1',
} as const satisfies Record<typeof PROJECT_DEFINITION_ACTION_IDS[number], string>;
