import type { ExternalActionExecutionAuthorizationBindingV1, ReviewedActionChildHttpProofV1 } from '../externalActionApi.js';
import type { DeploymentPreparationAdmissionV1 } from '../../deployments/deploymentPreparationAdmissionV1.js';
import { isDeploymentEnvironmentUpdateNativeAdmissionV1 } from '../../deployments/deploymentCandidatePublicationV1.js';
import * as ids from '../../deployments/deploymentActionIdsV1.js';
import { PROJECT_SOURCE_READ_ACTION_ID_V1, PROJECT_SOURCE_UPDATE_ACTION_ID_V1 } from './projectSourcesActionIdsV1.js';
import { DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1 } from '../../scm/repositoryFilesPullRequestActionIds.js';
import { ACTION_INVOKE_ACTION_ID_V1, SESSION_MESSAGE_SEND_ACTION_ID_V1, SESSION_SPAWN_NEW_ACTION_ID_V1 } from '../actionIds.js';
import { MANAGED_RETENTION_UPDATE_ACTION_ID_V1 } from '../../machines/managed/actionIdsV1.js';
import { MACHINE_SERVICE_ADOPT_ACTION_ID, MACHINE_SERVICE_ADOPT_BINDINGS_ROLE_V1,
  MACHINE_SERVICE_ADOPT_CREATE_ROLE_V1 } from '../../local/services/actionIdsV1.js';
import { parseQualifiedPluginActionId } from '../../plugins/actions/qualifiedActionId.js';
import { RPC_METHODS } from '../../rpc/methods.js';

/** Contributed teardown preview: a read-only provider child of the teardown root (runtime target). */
export const DEPLOYMENT_TEARDOWN_PREVIEW_CHILD_ROLE_V1 = 'teardownPreview';
/** The same read-only preview for a contributed data project removal. */
export const DEPLOYMENT_DATA_PROJECT_TEARDOWN_PREVIEW_CHILD_ROLE_V1 = 'projects.teardownPreview';
export const DEPLOYMENT_PREVIEW_SETUP_CHILD_ROLE_V1 = 'preview.setup';
export const DEPLOYMENT_BACKUP_BINDINGS_CHILD_ROLE_V1 = 'backup.bindings';
/** A role ending in ':' names a family; the child's role carries a non-empty operand after it. */
const TEMPLATE_DOMAIN_CHILD_ROLE_FAMILY_V1 = 'template.domain:';
const TARGET_RETENTION_CHILD_ROLE_FAMILY_V1 = 'target-retention:';

type ReviewedChildRootV1 = Readonly<{ actionId: string; deploymentPreparationAdmission?: DeploymentPreparationAdmissionV1 }>;
/** One declared row: this root may run this reviewed child, and only for this effect. */
export type DeploymentReviewedChildRowV1 = Readonly<{
  root: string;
  /** The root's own signed admission must select this child (for example a preview Create). */
  when?: (admission: DeploymentPreparationAdmissionV1 | undefined) => boolean;
  /** Exact role, or a role family ending in ':'. */
  role: string;
  /** The child's own Action id; `plugin` is the target descriptor's qualified provider Action. */
  action: string | 'plugin';
  /** The Home effect the child spends, when it differs from its own Action. */
  effect?: string;
  /** A read child spends only GET requests without a body. */
  access: 'read' | 'write';
}>;
export type DeploymentReviewedChildV1 = Readonly<{ row: DeploymentReviewedChildRowV1; roleOperand?: string }>;

const applyCreate = (admission: DeploymentPreparationAdmissionV1 | undefined) =>
  admission?.operation === 'create' && admission.mode === 'apply' ? admission : undefined;
const previewCreate = (admission: DeploymentPreparationAdmissionV1 | undefined) => applyCreate(admission)?.preview !== undefined;
const catalogCreate = (admission: DeploymentPreparationAdmissionV1 | undefined) => {
  const create = applyCreate(admission);
  return create !== undefined && create.preview === undefined && create.catalogApp !== undefined;
};
const copyCreate = (admission: DeploymentPreparationAdmissionV1 | undefined) => {
  const create = applyCreate(admission);
  return create !== undefined && create.preview === undefined && create.copyFrom !== undefined;
};
const childCreate = (admission: DeploymentPreparationAdmissionV1 | undefined) => {
  const create = applyCreate(admission);
  return create !== undefined && Boolean(create.copyFrom || create.catalogApp || create.preview);
};
const templateDeploy = (admission: DeploymentPreparationAdmissionV1 | undefined) =>
  admission?.operation === 'template' && admission.mode === 'apply' && admission.deploy !== undefined;
const rolloutCreate = (admission: DeploymentPreparationAdmissionV1 | undefined) => previewCreate(admission) || catalogCreate(admission);
const prepare = (admission: DeploymentPreparationAdmissionV1 | undefined) => admission?.operation === 'prepare';
const targetRetentionRoots = [ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, MACHINE_SERVICE_ADOPT_ACTION_ID,
  ids.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1, ids.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1] as const;
const referenceRoots = [[ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1, undefined], [ids.DEPLOYMENT_ROLLBACK_ACTION_ID_V1, undefined],
  [ids.DEPLOYMENT_PROMOTE_ACTION_ID_V1, undefined], [ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, rolloutCreate],
  [ids.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, templateDeploy]] as const;

let plan: readonly DeploymentReviewedChildRowV1[] | undefined;
/**
 * Root × reviewed child role → the child's Action and Home effect. Home admits a
 * reviewed child only through a row here; readers keep the operand checks that need
 * transport parsing or current state. Built on first use so id modules finish loading.
 */
export function readDeploymentReviewedChildPlanV1(): readonly DeploymentReviewedChildRowV1[] {
  return plan ??= Object.freeze([
    { root: ids.DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, role: DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1,
      action: ids.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, access: 'write' },
    { root: ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, when: previewCreate, role: 'preview.backup',
      action: ids.DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, access: 'write' },
    { root: ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, when: childCreate, role: DEPLOYMENT_BACKUP_BINDINGS_CHILD_ROLE_V1,
      action: ids.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, access: 'write' },
    { root: ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, when: previewCreate, role: 'preview.bindings',
      action: ids.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, access: 'write' },
    { root: ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, when: previewCreate, role: 'preview.deploy',
      action: ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1, access: 'write' },
    { root: ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, when: previewCreate, role: `${TEMPLATE_DOMAIN_CHILD_ROLE_FAMILY_V1}preview`,
      action: ids.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1, access: 'write' },
    { root: ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, when: catalogCreate, role: 'template.deploy',
      action: ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1, access: 'write' },
    { root: ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, when: catalogCreate, role: TEMPLATE_DOMAIN_CHILD_ROLE_FAMILY_V1,
      action: ids.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1, access: 'write' },
    { root: ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, when: copyCreate, role: ids.deploymentCopyDataLinkChildRoleV1(''),
      action: ids.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1, access: 'write' },
    { root: ids.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, when: templateDeploy, role: 'template.deploy',
      action: ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1, access: 'write' },
    { root: ids.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, when: templateDeploy, role: TEMPLATE_DOMAIN_CHILD_ROLE_FAMILY_V1,
      action: ids.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1, access: 'write' },
    { root: MACHINE_SERVICE_ADOPT_ACTION_ID, role: MACHINE_SERVICE_ADOPT_CREATE_ROLE_V1,
      action: ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, access: 'write' },
    { root: MACHINE_SERVICE_ADOPT_ACTION_ID, role: MACHINE_SERVICE_ADOPT_BINDINGS_ROLE_V1,
      action: ids.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, access: 'write' },
    ...targetRetentionRoots.map(root => ({ root, role: TARGET_RETENTION_CHILD_ROLE_FAMILY_V1,
      action: MANAGED_RETENTION_UPDATE_ACTION_ID_V1, access: 'write' as const })),
    { root: ids.DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, role: DEPLOYMENT_BACKUP_BINDINGS_CHILD_ROLE_V1,
      action: ids.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, access: 'write' },
    { root: ids.DEPLOYMENT_ENVIRONMENT_TELEMETRY_SET_ACTION_ID_V1, role: ids.DEPLOYMENT_TELEMETRY_BINDINGS_CHILD_ROLE_V1,
      action: ids.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, access: 'write' },
    { root: ACTION_INVOKE_ACTION_ID_V1, role: ids.DEPLOYMENT_DATABASE_READ_ACCESS_BINDINGS_CHILD_ROLE_V1,
      action: ids.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, access: 'write' },
    ...referenceRoots.map(([root, when]) => ({ root, ...(when ? { when } : {}), role: ids.DEPLOYMENT_REFERENCE_READ_CHILD_ROLE_V1,
      action: ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, access: 'read' as const })),
    // The reviewed Deploy may also read service inventory for its saved-reference Environment.
    { root: ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1, role: ids.DEPLOYMENT_REFERENCE_READ_CHILD_ROLE_V1,
      action: ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, effect: RPC_METHODS.MACHINES_SERVICE_LIST, access: 'read' },
    { root: ids.DEPLOYMENT_PREPARE_ACTION_ID_V1, when: prepare, role: ids.DEPLOYMENT_PREPARE_SESSION_CHILD_ROLE_V1,
      action: SESSION_SPAWN_NEW_ACTION_ID_V1, access: 'read' },
    { root: ids.DEPLOYMENT_PREPARE_ACTION_ID_V1, when: prepare, role: ids.DEPLOYMENT_PREPARE_SESSION_CHILD_ROLE_V1,
      action: SESSION_MESSAGE_SEND_ACTION_ID_V1, access: 'read' },
    { root: ids.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, role: DEPLOYMENT_PREVIEW_SETUP_CHILD_ROLE_V1, action: 'plugin', access: 'read' },
    { root: ids.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1, role: ids.PLATFORM_FAILURE_SETUP_ROLE, action: 'plugin', access: 'read' },
    // The teardown preview also opens the root Environment's content and its own Links' content (Home reader).
    { root: ids.DEPLOYMENT_TEARDOWN_ACTION_ID_V1, role: DEPLOYMENT_TEARDOWN_PREVIEW_CHILD_ROLE_V1, action: 'plugin', access: 'read' },
    { root: ids.DEPLOYMENT_TEARDOWN_ACTION_ID_V1, role: DEPLOYMENT_DATA_PROJECT_TEARDOWN_PREVIEW_CHILD_ROLE_V1, action: 'plugin', access: 'read' },
  ] satisfies readonly DeploymentReviewedChildRowV1[]);
}

/**
 * The one decision "may this reviewed child run under this root for this effect".
 * A read row refuses any request that is not a body-less GET.
 */
export function readDeploymentReviewedChildV1(root: ReviewedChildRootV1,
  child: Pick<ReviewedActionChildHttpProofV1, 'actionId' | 'role'> | undefined, effectActionId: string,
  request?: Readonly<{ method: string; body?: unknown }>): DeploymentReviewedChildV1 | undefined {
  if (!child) return undefined;
  for (const row of readDeploymentReviewedChildPlanV1()) {
    if (row.root !== root.actionId || row.when && !row.when(root.deploymentPreparationAdmission)) continue;
    if (row.action === 'plugin' ? !parseQualifiedPluginActionId(child.actionId) : child.actionId !== row.action) continue;
    if ((row.effect ?? child.actionId) !== effectActionId) continue;
    const family = row.role.endsWith(':');
    if (family ? !child.role.startsWith(row.role) || child.role.length === row.role.length : child.role !== row.role) continue;
    if (row.access === 'read' && request && (request.method.toUpperCase() !== 'GET' || request.body !== undefined)) return undefined;
    return { row, ...(family ? { roleOperand: child.role.slice(row.role.length) } : {}) };
  }
  return undefined;
}

/** The reviewed Deploy may read inventory for its saved-reference Environment. */
export function readDeploymentReferenceServiceListEnvironmentIdV1(
  rootActionId: string | undefined,
  effectActionId: string | undefined,
  child: Pick<ReviewedActionChildHttpProofV1, 'actionId' | 'role' | 'environmentId'> | undefined,
): string | undefined {
  if (rootActionId === undefined || effectActionId !== RPC_METHODS.MACHINES_SERVICE_LIST
    || !readDeploymentReviewedChildV1({ actionId: rootActionId }, child, effectActionId)) return undefined;
  return child?.environmentId || undefined;
}

/** Local Action declaration; operands still come exclusively from the signed admission. */
export type DeploymentPreparationScopeV1 = Readonly<{
  createEffects: readonly string[];
  previewReads: readonly string[];
  candidateEffects: readonly string[];
  setupReads: readonly string[];
  moveEffects: readonly string[];
  httpReads: readonly (typeof ids.DEPLOYMENT_PREPARATION_READ_ACTION_IDS_V1[number] | ids.DeploymentDomainMetadataReadActionIdV1)[];
  environment: 'create' | 'template' | 'admitted';
  targetRetention: boolean;
  storageEffects: readonly string[];
  templateDeployEffects: readonly string[];
}>;
export type DeploymentPreparationScopeDeclarationV1 = (
  binding: ExternalActionExecutionAuthorizationBindingV1,
  child?: ReviewedActionChildHttpProofV1,
  effectActionId?: string,
) => DeploymentPreparationScopeV1;

/** Declared by the ActionSpec itself; this builder only binds its signed operands. */
export type DeploymentPreparationKindV1 = 'root' | 'create' | 'adopt' | 'template' | 'setup' | 'move' | 'update' | 'link' | 'membership' | 'targetCheck';
export const declareDeploymentPreparationScopeV1 = (kind: DeploymentPreparationKindV1): DeploymentPreparationScopeDeclarationV1 => (binding, child, effectActionId) => {
  const actionId = binding.actionId;
  const admission = binding.deploymentPreparationAdmission;
  const previewReads = kind === 'update'
    && isDeploymentEnvironmentUpdateNativeAdmissionV1(binding.deploymentNativeAdmission)
    && binding.deploymentNativeAdmission.defaultsFor === undefined
    ? [ids.DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1, ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1]
    : kind === 'create' && admission?.operation === 'create' && admission.preview
      ? [ids.DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1, ids.DEPLOYMENT_DOMAIN_GET_ACTION_ID_V1] : [];
  const targetCheck = kind === 'targetCheck' && admission?.operation === 'targetCheck';
  const createEffects = targetCheck ? [ids.DEPLOYMENT_TARGET_CHECK_ACTION_ID_V1] : (kind === 'create' || kind === 'adopt') && admission?.operation === 'create'
    ? [actionId, ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, PROJECT_SOURCE_READ_ACTION_ID_V1,
      ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, ids.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, ...previewReads,
      ...(admission.preview && admission.mode === 'apply' ? [ids.DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1] : []),
      // Duplicate links each reviewed data copy to the Environment it creates.
      ...(admission.copyFrom && admission.mode === 'apply' ? [ids.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1] : []),
      ...((admission.catalogApp || admission.preview) && admission.mode === 'apply'
        ? [ids.DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1, ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1,
          ids.DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1, ids.DEPLOYMENT_RECEIPT_LIST_ACTION_ID_V1] : [])] : [];
  const deployIntent = kind === 'template' && admission?.operation === 'template' && admission.mode === 'apply' && admission.deploy !== undefined
    || kind === 'create' && admission?.operation === 'create' && admission.mode === 'apply' && Boolean(admission.catalogApp || admission.preview);
  const candidateEffects = [
    ...(binding.deploymentCandidatePublication ? [actionId] : []),
    ...(deployIntent ? [ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1] : []),
  ];
  const setupReads = kind === 'setup' && admission?.operation === 'setup'
    ? [ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1,
      ...(admission.catalogSources !== undefined ? [PROJECT_SOURCE_READ_ACTION_ID_V1, ids.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1] : [])] : [];
  const moveEffects = kind === 'move'
    ? [actionId, ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, PROJECT_SOURCE_READ_ACTION_ID_V1, PROJECT_SOURCE_UPDATE_ACTION_ID_V1,
      ...(child && readDeploymentReviewedChildV1(binding, child, child.actionId) ? [child.actionId] : [])] : [];
  const domainRead = effectActionId !== undefined && ids.isDeploymentDomainMetadataReadActionIdV1(effectActionId) ? effectActionId
    : effectActionId === ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1 ? ids.DEPLOYMENT_DOMAIN_LIST_ACTION_ID_V1 : undefined;
  const nativeRootRead = effectActionId === actionId
    && ids.deploymentOperationForRootActionV1(actionId, admission) !== undefined;
  const httpReads = [
    ...(kind === 'link' && effectActionId === actionId ? [ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1] as const : []),
    ...(domainRead && (kind === 'membership' || deployIntent) ? [domainRead] : []),
    ...ids.DEPLOYMENT_PREPARATION_READ_ACTION_IDS_V1.filter(id => nativeRootRead
      || effectActionId === ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1 || effectActionId === id),
  ];
  return { createEffects, previewReads, candidateEffects, setupReads, moveEffects, httpReads,
    environment: kind === 'create' ? 'create' : kind === 'template' ? 'template' : 'admitted',
    targetRetention: (kind === 'create' || kind === 'adopt') || kind === 'link' || kind === 'template',
    storageEffects: targetCheck ? [PROJECT_SOURCE_READ_ACTION_ID_V1, ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1]
      : kind === 'template' ? [ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, ids.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1,
      ids.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1, ids.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1] : [],
    templateDeployEffects: kind === 'template' && deployIntent ? [ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1,
      ids.DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1, ids.DEPLOYMENT_RECEIPT_LIST_ACTION_ID_V1] : [] };
};
