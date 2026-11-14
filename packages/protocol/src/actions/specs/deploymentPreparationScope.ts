import type { ExternalActionExecutionAuthorizationBindingV1, ReviewedActionChildHttpProofV1 } from '../externalActionApi.js';
import { isDeploymentEnvironmentUpdateNativeAdmissionV1 } from '../../deployments/deploymentCandidatePublicationV1.js';
import * as ids from '../../deployments/deploymentActionIdsV1.js';
import { PROJECT_SOURCE_READ_ACTION_ID_V1, PROJECT_SOURCE_UPDATE_ACTION_ID_V1 } from './projectSourcesActionIdsV1.js';
import { DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1 } from '../../scm/repositoryFilesPullRequestActionIds.js';

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
export type DeploymentPreparationKindV1 = 'root' | 'create' | 'adopt' | 'template' | 'setup' | 'move' | 'update' | 'link' | 'membership';
export const declareDeploymentPreparationScopeV1 = (kind: DeploymentPreparationKindV1): DeploymentPreparationScopeDeclarationV1 => (binding, child, effectActionId) => {
  const actionId = binding.actionId;
  const admission = binding.deploymentPreparationAdmission;
  const previewReads = kind === 'update'
    && isDeploymentEnvironmentUpdateNativeAdmissionV1(binding.deploymentNativeAdmission)
    && binding.deploymentNativeAdmission.defaultsFor === undefined
    ? [ids.DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1, ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1]
    : kind === 'create' && admission?.operation === 'create' && admission.preview
      ? [ids.DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1, ids.DEPLOYMENT_DOMAIN_GET_ACTION_ID_V1] : [];
  const createEffects = (kind === 'create' || kind === 'adopt') && admission?.operation === 'create'
    ? [actionId, ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, PROJECT_SOURCE_READ_ACTION_ID_V1,
      ids.DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, ids.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1, ...previewReads,
      ...(admission.preview && admission.mode === 'apply' ? [ids.DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1] : []),
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
      ...(child?.actionId === ids.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 && child.role === DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1
        ? [ids.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1] : [])] : [];
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
    storageEffects: kind === 'template' ? [ids.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, ids.DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1,
      ids.DEPLOYMENT_TARGET_LINK_ACTION_ID_V1, ids.DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1] : [],
    templateDeployEffects: kind === 'template' && deployIntent ? [ids.DEPLOYMENT_DEPLOY_ACTION_ID_V1,
      ids.DEPLOYMENT_RECEIPT_GET_ACTION_ID_V1, ids.DEPLOYMENT_RECEIPT_LIST_ACTION_ID_V1] : [] };
};
