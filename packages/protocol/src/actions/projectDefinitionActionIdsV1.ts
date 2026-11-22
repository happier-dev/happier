
/** Action identity leaf: schema modules and the registry share these constants. */
export const PROJECT_DEFINITION_INSPECT_ACTION_ID = 'projects.inspect' as const;
export const PROJECT_WORKTREE_PORTS_REASSIGN_ACTION_ID = 'projects.worktree.ports.reassign' as const;
export const PROJECT_DEFINITION_ACTION_IDS = [PROJECT_DEFINITION_INSPECT_ACTION_ID, 'projects.manifest.update', PROJECT_WORKTREE_PORTS_REASSIGN_ACTION_ID] as const;

/** Signed requester Actions use the accepted member checkout; private raw RPCs do not. */
export function isRequesterProjectDefinitionActionIdV1(actionId: unknown): actionId is
  typeof PROJECT_DEFINITION_INSPECT_ACTION_ID | typeof PROJECT_WORKTREE_PORTS_REASSIGN_ACTION_ID {
  return actionId === PROJECT_DEFINITION_INSPECT_ACTION_ID || actionId === PROJECT_WORKTREE_PORTS_REASSIGN_ACTION_ID;
}

/** One method vocabulary for Action declarations and signed RPC admission. */
export const PROJECT_DEFINITION_ACTION_RPC_METHODS_V1 = {
  'projects.inspect': 'daemon.projects.inspect.v1',
  'projects.manifest.update': 'daemon.projects.manifest.update.v1',
  'projects.worktree.ports.reassign': 'daemon.projects.worktree.ports.reassign.v1',
} as const satisfies Record<typeof PROJECT_DEFINITION_ACTION_IDS[number], string>;
