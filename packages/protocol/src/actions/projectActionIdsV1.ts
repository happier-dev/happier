import { RPC_METHODS } from '../rpc/methods.js';
import { PROJECT_DEFINITION_ACTION_RPC_METHODS_V1, PROJECT_DEFINITION_INSPECT_ACTION_ID } from './projectDefinitionActionIdsV1.js';
import { PROJECT_SOURCE_READ_ACTION_ID_V1 } from './specs/projectSourcesActionIdsV1.js';

export const PROJECT_SETUP_SET_ACTION_ID_V1 = 'projects.setup.set' as const;
export const PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1 = {
  sourceRead: PROJECT_SOURCE_READ_ACTION_ID_V1, artifactRead: 'artifact.get', artifactCreate: 'artifact.create', inspect: PROJECT_DEFINITION_INSPECT_ACTION_ID,
} as const;
export function isProjectSetupSetChildActionIdV1(actionId: string): actionId is typeof PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1[keyof typeof PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1] {
  return Object.values(PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1).some(childId => childId === actionId);
}
export function readProjectSetupSetChildRpcEffectV1(rootActionId: string, method: string): typeof PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.inspect | null {
  return rootActionId === PROJECT_SETUP_SET_ACTION_ID_V1
    && method === PROJECT_DEFINITION_ACTION_RPC_METHODS_V1[PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.inspect]
    ? PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.inspect : null;
}

export const PROJECT_PREPARE_ACTION_ID_V1 = 'projects.prepare' as const;

/** Destructive checkout owners retain cleanup review and Stop in their own operation. */
export function isProjectCheckoutRemovalActionIdV1(actionId: string): actionId is
  'scm.worktree.remove' | 'machines.storage.trash.move' | 'machines.storage.deleteNow' | 'projects.worker.copy.retire' | 'session.delete' {
  return actionId === 'scm.worktree.remove' || actionId === 'machines.storage.trash.move' || actionId === 'machines.storage.deleteNow'
    || actionId === 'projects.worker.copy.retire' || actionId === 'session.delete';
}

/** Pure vocabulary keeps Action identity admission independent of completion/catalog loading. */
export const PROJECT_ACTION_IDS_V1 = [
  'projects.pages.list',
  'projects.trust.list', 'projects.trust.revoke', PROJECT_PREPARE_ACTION_ID_V1, 'projects.script.run', 'projects.compute.exec',
] as const;
export type ProjectActionIdV1 = typeof PROJECT_ACTION_IDS_V1[number];
export const PROJECT_FINITE_ACTION_RPC_METHODS_V1 = {
  'projects.prepare': RPC_METHODS.DAEMON_PROJECTS_PREPARE,
  'projects.script.run': RPC_METHODS.DAEMON_PROJECTS_SCRIPT_RUN,
  'projects.compute.exec': RPC_METHODS.DAEMON_PROJECTS_COMPUTE_EXEC,
} as const;
export function isProjectActionIdV1(value: string): value is ProjectActionIdV1 {
  return (PROJECT_ACTION_IDS_V1 as readonly string[]).includes(value);
}

/** The Open root's Sync purpose is distinct from finite preparation roots. */
export function isProjectWorkspaceSyncOpenActionV1(value: string | undefined): value is 'projects.open' {
  return value === 'projects.open';
}

/** Invocation roots allowed to prepare their Project's linked worker copy.
 * This classifies the purpose only; each receiver still verifies its signed
 * root, requester custody, original input and current source/target refs.
 */
export function isProjectWorkspaceSyncPreparationActionV1(value: string | undefined): value is
  'projects.script.run' | 'projects.compute.exec' | 'projects.service.relocate' | 'localServices.launcher.start' {
  return value === 'projects.script.run' || value === 'projects.compute.exec'
    || value === 'projects.service.relocate' || value === 'localServices.launcher.start';
}
