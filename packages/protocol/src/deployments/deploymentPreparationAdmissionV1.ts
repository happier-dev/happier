import * as managedSchemas from '../machines/managed/actionsV1.js';
import { MACHINE_REBOOT_ACTION_IDS } from '../machines/rebootActionIdsV1.js';
import * as managedActionIds from '../machines/managed/actionIdsV1.js';
import * as deploymentActionIds from './deploymentActionIdsV1.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentEnvironmentDeployerPrincipalsV1Schema } from './deploymentEnvironmentDeployerV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import { readDeploymentTemplateDeployIntentV1 } from './deploymentTemplateInstantiationV1.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { DeploymentEnvironmentCopySourceV1Schema } from './deploymentEnvironmentCopyV1.js';
import { DeploymentPreviewReferenceV1Schema } from './deploymentPreviewReferenceV1.js';
import { MachineSetupApplyInputV1Schema, MachineSetupCombinedPlanInputV1Schema, MachineSetupPlanInputV1Schema } from '../machines/managed/actionsV1.js';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '../machines/managed/actionIdsV1.js';
import { MACHINE_SERVICE_ADOPT_ACTION_ID } from '../local/services/actionIdsV1.js';
import { DeploymentNewProjectV1Schema, DeploymentCatalogAppDefinitionInputV1Schema, hasOneDeploymentProjectV1 } from './storedAppInputV1.js';

export function deploymentPreparationOperationForActionV1(value: string): 'prepare' | 'template' | 'catalog' | 'setup' | 'create' | undefined {
  // Adopting a watched service is an Environment-creating root: it spends Create's preparation admission.
  return value === deploymentActionIds.DEPLOYMENT_PREPARE_ACTION_ID_V1 ? 'prepare'
    : value === deploymentActionIds.DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 || value === MACHINE_SERVICE_ADOPT_ACTION_ID ? 'create'
    : value === deploymentActionIds.DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 ? 'catalog'
    : value === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 ? 'template'
      : value === managedActionIds.MACHINE_SETUP_PLAN_ACTION_ID_V1 || value === managedActionIds.MACHINE_SETUP_APPLY_ACTION_ID_V1
        || value === managedActionIds.MACHINE_SETUP_UPDATES_APPLY_ACTION_ID_V1
        || value === managedActionIds.MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1
        || MACHINE_REBOOT_ACTION_IDS.some(actionId => actionId === value) ? 'setup' : undefined;
}
/** These deployment roots require preparation; setup carries optional reviewed operands. */
export function isDeploymentPreparationActionIdV1(value: string): value is typeof deploymentActionIds.DEPLOYMENT_PREPARE_ACTION_ID_V1 | typeof deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 | typeof deploymentActionIds.DEPLOYMENT_PUBLISH_PREPARE_ACTION_ID_V1 {
  const operation = deploymentPreparationOperationForActionV1(value);
  return operation !== undefined && operation !== 'setup' && operation !== 'create';
}

const source = lazyZodSchema(() => z.strictObject({ id, revision }));
/** Only reviewed references; Home belongs to the signed binding and content stays sealed. */
export const DeploymentPreparationAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('create'), mode: z.enum(['preview', 'apply']), source: z.optional(z.strictObject({ id })),
    newProject: z.optional(DeploymentNewProjectV1Schema),
    catalogApp: z.optional(DeploymentCatalogAppDefinitionInputV1Schema.shape.templateRef),
    requestKey: id, protection: z.enum(['production', 'nonProduction']), purpose: z.enum(['standard', 'preview']),
    deployerMode: z.enum(['managers', 'members', 'chosen']), deployerPrincipals: z.optional(DeploymentEnvironmentDeployerPrincipalsV1Schema),
    copyFrom: z.optional(DeploymentEnvironmentCopySourceV1Schema),
    preview: z.optional(DeploymentPreviewReferenceV1Schema), previewCompanionOfEnvironmentId: z.optional(id),
    candidate: z.optional(DeploymentArtifactContentReferenceV1Schema) }),
  z.strictObject({ operation: z.literal('catalog'), source: z.optional(source), newProject: z.optional(DeploymentNewProjectV1Schema), machineId: id, installationId: id }),
  z.strictObject({ operation: z.literal('setup'), deployments: z.array(z.strictObject({ machineId: id,
    environment: z.strictObject({ id, revision }), target: z.strictObject({ id, revision }),
    candidate: DeploymentArtifactContentReferenceV1Schema,
  })), catalogSources: z.optional(z.array(z.strictObject({ machineId: id, source: z.strictObject({ id }) })).check(z.minLength(1))),
    connectorGrants: z.optional(z.array(z.strictObject({ machineId: id, grantRef: id })).check(z.minLength(1))),
    machineTargets: z.optional(z.array(id).check(z.minLength(1))) }),
  z.strictObject({ operation: z.literal('prepare'), source,
    environment: z.optional(z.strictObject({ id })), workspace: z.strictObject({ kind: z.literal('workspace-ref'), id }) }),
  z.strictObject({ operation: z.literal('template'), mode: z.enum(['preview', 'apply']), source: z.optional(z.strictObject({ id })),
    newProject: z.optional(DeploymentNewProjectV1Schema), machineId: id,
    workspace: z.optional(z.strictObject({ kind: z.literal('workspace-ref'), id })),
    deploy: z.optional(z.strictObject({ requestKey: id })),
    environment: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('existing'), environmentId: id, expectedRevision: revision }),
      z.strictObject({ kind: z.literal('create'), requestKey: id, protection: z.enum(['production', 'nonProduction']),
        purpose: z.literal('standard'), deployerMode: z.enum(['managers', 'members', 'chosen']),
        deployerPrincipals: z.optional(DeploymentEnvironmentDeployerPrincipalsV1Schema),
        controllerMachineId: id, buildMachineId: z.optional(id) }),
    ]),
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('existing'), targetLinkId: id, expectedRevision: revision, installationId: id }),
      z.strictObject({ kind: z.literal('new'), installationId: id }),
    ]),
  }),
]).check(z.refine(value => value.operation !== 'setup' || value.deployments.length > 0 || (value.catalogSources?.length ?? 0) > 0
  || (value.connectorGrants?.length ?? 0) > 0 || (value.machineTargets?.length ?? 0) > 0,
  { message: 'Setup preparation names a reviewed operand.' }),
z.refine(value => value.operation !== 'create' && value.operation !== 'catalog' && value.operation !== 'template'
  || hasOneDeploymentProjectV1(value.source, value.newProject), { message: 'Preparation names one Project authority.' })));
export type DeploymentPreparationAdmissionV1 = z.infer<typeof DeploymentPreparationAdmissionV1Schema>;

/** Project only the closed read-purpose fields, independently of Action catalog initialization. */
export function projectDeploymentPreparationAdmissionV1(actionId: string, input: unknown): DeploymentPreparationAdmissionV1 | undefined {
  const operation = deploymentPreparationOperationForActionV1(actionId);
  if (operation === undefined) return undefined;
  const value = readRecord(input);
  // Adoption binds its reviewed destination at apply; the review step creates nothing.
  if (actionId === MACHINE_SERVICE_ADOPT_ACTION_ID) {
    if (value.mode !== 'apply') return undefined;
    const destination = readRecord(value.destination);
    return DeploymentPreparationAdmissionV1Schema.parse({ operation, mode: 'apply',
      ...(destination.newProject ? { newProject: destination.newProject } : { source: { id: destination.projectSourceId } }),
      requestKey: value.requestKey, protection: destination.protection, purpose: destination.purpose,
      deployerMode: destination.deployerMode,
      ...(destination.deployerPrincipals === undefined ? {} : { deployerPrincipals: destination.deployerPrincipals }) });
  }
  // Ordinary prepared creates retain their existing root. Copy and preview
  // preparation capture their exact read references in the same finite carrier.
  if (operation === 'create') return value.preview === undefined && value.copyFrom === undefined && value.newProject === undefined
    && (value.contentArtifactId !== undefined || value.definition === undefined)
    ? undefined : DeploymentPreparationAdmissionV1Schema.parse({ operation, mode: value.mode ?? 'apply',
      ...(value.newProject ? { newProject: value.newProject } : { source: { id: value.projectSourceId } }),
      requestKey: value.requestKey, protection: value.protection, purpose: value.purpose, deployerMode: value.deployerMode,
      ...(readRecord(value.definition).from === 'catalogApp' ? { catalogApp: readRecord(value.definition).templateRef } : {}),
      ...(value.copyFrom === undefined ? {} : { copyFrom: { environmentId: readRecord(value.copyFrom).environmentId,
        expectedRevision: readRecord(value.copyFrom).expectedRevision } }),
      ...(value.preview === undefined ? {} : { preview: z.object(DeploymentPreviewReferenceV1Schema.shape).parse(value.preview) }),
      ...(value.previewCompanionOfEnvironmentId === undefined ? {} : { previewCompanionOfEnvironmentId: value.previewCompanionOfEnvironmentId }),
      ...(value.contentArtifactId === undefined ? {} : { candidate: { contentArtifactId: value.contentArtifactId,
        contentHeaderVersion: value.contentHeaderVersion, contentBodyVersion: value.contentBodyVersion } }),
      ...(value.deployerPrincipals === undefined ? {} : { deployerPrincipals: value.deployerPrincipals }) });
  if (operation === 'catalog') return DeploymentPreparationAdmissionV1Schema.parse({ operation,
    ...(value.newProject ? { newProject: value.newProject } : { source: { id: value.projectSourceId, revision: value.sourceRevision } }),
    machineId: value.machineId, installationId: value.installationId });
  if (operation === 'setup') {
    if (actionId === managedActionIds.MACHINE_SETUP_UPDATES_ROLLOUT_ACTION_ID_V1) {
      const rollout = managedSchemas.MachineSetupUpdatesRolloutInputV1Schema.parse(input);
      return { operation, machineTargets: rollout.batches.flat().map(target => target.machineId), deployments: [] };
    }
    if (actionId === managedActionIds.MACHINE_SETUP_UPDATES_APPLY_ACTION_ID_V1) {
      const updates = managedSchemas.MachineSetupUpdatesApplyInputV1Schema.parse(input);
      return { operation, machineTargets: [updates.machineId], deployments: [] };
    }
    if (MACHINE_REBOOT_ACTION_IDS.some(id => id === actionId))
      return DeploymentPreparationAdmissionV1Schema.parse({ operation, machineTargets: [value.machineId], deployments: [] });
    if (actionId === managedActionIds.MACHINE_SETUP_PLAN_ACTION_ID_V1 && value.updates !== undefined) {
      const check = managedSchemas.MachineSetupPlanInputV1Schema.parse(input);
      return { operation, machineTargets: [check.machineId], deployments: [] };
    }
    // The target schema owns app operands and exact credential references in
    // reviewed native plans; neither authored configuration nor secrets leave it.
    const candidates = Array.isArray(value.targets) ? value.targets : [input];
    if (actionId !== MACHINE_SETUP_APPLY_ACTION_ID_V1 && !candidates.some(target => {
      const candidate = readRecord(target);
      const children = candidate.appChildren;
      if (Array.isArray(children) && children.some(child => readRecord(child).actionId === deploymentActionIds.DEPLOYMENT_DEPLOY_ACTION_ID_V1
        || readRecord(child).actionId === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1)) return true;
      return false;
    })) return undefined;
    const root = actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1 ? MachineSetupApplyInputV1Schema.parse(input)
      : Array.isArray(value.targets) ? MachineSetupCombinedPlanInputV1Schema.parse(input) : MachineSetupPlanInputV1Schema.parse(input);
    const targets = 'targets' in root ? root.targets : [root];
    const deployments = targets.flatMap(target => {
      if (target.homeId !== root.homeId) throw new TypeError('Setup preparation Home mismatch');
      return (target.appChildren ?? []).flatMap(child => {
        if (child.actionId !== deploymentActionIds.DEPLOYMENT_DEPLOY_ACTION_ID_V1) return [];
        if (child.input.serverId !== root.homeId) throw new TypeError('Setup app preparation Home mismatch');
        return [{ machineId: target.machineId,
          environment: { id: child.input.environmentId, revision: child.input.expectedRevision },
          target: { id: child.input.targetLinkId, revision: child.input.expectedTargetLinkRevision },
          candidate: { contentArtifactId: child.input.contentArtifactId, contentHeaderVersion: child.input.contentHeaderVersion,
            contentBodyVersion: child.input.contentBodyVersion } }];
      });
    });
    const catalogSources = targets.flatMap(target => (target.appChildren ?? []).flatMap(child => {
      if (child.actionId !== deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 || child.input.projectSourceId === undefined) return [];
      if (child.input.serverId !== root.homeId) throw new TypeError('Setup app preparation Home mismatch');
      return [{ machineId: target.machineId, source: { id: child.input.projectSourceId } }];
    }));
    const connectorGrants = targets.flatMap(target => ('recipePlans' in target ? target.recipePlans : []).flatMap(({ plan }) =>
      plan.steps.flatMap(step => step.kind === 'file' && step.content?.kind === 'secretGrant'
        ? [{ machineId: target.machineId, grantRef: step.content.grantRef }] : [])));
    const machineTargets = actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1
      ? [...new Set(targets.map(target => target.machineId))] : undefined;
    if (!machineTargets && deployments.length === 0 && catalogSources.length === 0 && connectorGrants.length === 0) return undefined;
    return DeploymentPreparationAdmissionV1Schema.parse({ operation, deployments,
      ...(machineTargets ? { machineTargets } : {}),
      ...(catalogSources.length ? { catalogSources } : {}),
      ...(connectorGrants.length ? { connectorGrants } : {}) });
  }
  if (actionId === deploymentActionIds.DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) {
    const environment = readRecord(value.environment);
    const destination = readRecord(value.destination);
    const deploy = readDeploymentTemplateDeployIntentV1(value);
    return DeploymentPreparationAdmissionV1Schema.parse({ operation: 'template', mode: value.mode,
      ...(destination.kind === 'repositoryPullRequest' ? { workspace: {
        kind: readRecord(destination.workspace).kind, id: readRecord(destination.workspace).id,
      } } : {}),
      ...(deploy === undefined ? {} : { deploy }),
      ...(value.newProject ? { newProject: value.newProject } : { source: { id: value.projectSourceId } }), machineId: value.machineId, target: value.target,
      environment: environment.kind === 'existing' ? environment : {
        kind: environment.kind, requestKey: environment.requestKey, protection: environment.protection,
        purpose: environment.purpose, deployerMode: environment.deployerMode,
        ...(environment.deployerPrincipals === undefined ? {} : { deployerPrincipals: environment.deployerPrincipals }), controllerMachineId: environment.controllerMachineId,
        ...(environment.buildMachineId === undefined ? {} : { buildMachineId: environment.buildMachineId }),
      } });
  }
  if (actionId === deploymentActionIds.DEPLOYMENT_PREPARE_ACTION_ID_V1) {
    const workspace = readRecord(value.workspace);
    const environmentId = value.environmentId ?? readRecord(value.target).environmentId;
    return DeploymentPreparationAdmissionV1Schema.parse({ operation: 'prepare',
      source: { id: value.projectSourceId, revision: value.sourceRevision },
      workspace: { kind: workspace.kind, id: workspace.id },
      ...(environmentId === undefined ? {} : { environment: { id: environmentId } }) });
  }
  return undefined;
}
