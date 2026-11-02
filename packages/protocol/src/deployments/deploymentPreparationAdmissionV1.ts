import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentEnvironmentDeployerPrincipalsV1Schema } from './deploymentEnvironmentDeployerV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { DeploymentEnvironmentCopySourceV1Schema } from './deploymentEnvironmentCopyV1.js';
import { DeploymentPreviewReferenceV1Schema } from './deploymentPreviewReferenceV1.js';
import { MachineSetupApplyInputV1Schema, MachineSetupCombinedPlanInputV1Schema, MachineSetupPlanInputV1Schema } from '../machines/managed/actionsV1.js';
import { DeploymentNewProjectV1Schema, DeploymentCatalogAppDefinitionInputV1Schema, hasOneDeploymentProjectV1 } from './storedAppInputV1.js';

export function deploymentPreparationOperationForActionV1(value: string): 'publish' | 'prepare' | 'template' | 'catalog' | 'setup' | 'create' | undefined {
  return value === 'deployments.publish' ? 'publish' : value === 'deployments.prepare' ? 'prepare'
    : value === 'deployments.environments.create' ? 'create'
    : value === 'deployments.publish.prepare' ? 'catalog'
    : value === 'deployments.templates.instantiate' ? 'template'
      : value === 'machines.setup.plan' || value === 'machines.setup.apply' ? 'setup' : undefined;
}
/** These deployment roots require preparation; setup only carries optional app reads. */
export function isDeploymentPreparationActionIdV1(value: string): value is 'deployments.publish' | 'deployments.prepare' | 'deployments.templates.instantiate' | 'deployments.publish.prepare' {
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
    preview: z.optional(DeploymentPreviewReferenceV1Schema), candidate: z.optional(DeploymentArtifactContentReferenceV1Schema) }),
  z.strictObject({ operation: z.literal('catalog'), source: z.optional(source), newProject: z.optional(DeploymentNewProjectV1Schema), machineId: id, installationId: id }),
  z.strictObject({ operation: z.literal('setup'), deployments: z.array(z.strictObject({ machineId: id,
    environment: z.strictObject({ id, revision }), target: z.strictObject({ id, revision }),
    candidate: DeploymentArtifactContentReferenceV1Schema,
  })), catalogSources: z.optional(z.array(z.strictObject({ machineId: id, source: z.strictObject({ id }) })).check(z.minLength(1))) }),
  z.strictObject({ operation: z.literal('publish'), source: z.optional(source),
    environment: z.optional(z.strictObject({ id, revision })), candidate: DeploymentArtifactContentReferenceV1Schema }),
  z.strictObject({ operation: z.literal('prepare'), source,
    environment: z.optional(z.strictObject({ id })), workspace: z.strictObject({ kind: z.literal('workspace-ref'), id }) }),
  z.strictObject({ operation: z.literal('template'), mode: z.enum(['preview', 'apply']), source: z.optional(z.strictObject({ id })),
    newProject: z.optional(DeploymentNewProjectV1Schema), machineId: id,
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
]).check(z.refine(value => value.operation !== 'setup' || value.deployments.length > 0 || (value.catalogSources?.length ?? 0) > 0,
  { message: 'Setup preparation names a reviewed app operand.' }),
z.refine(value => value.operation !== 'create' && value.operation !== 'catalog' && value.operation !== 'template'
  || hasOneDeploymentProjectV1(value.source, value.newProject), { message: 'Preparation names one Project authority.' })));
export type DeploymentPreparationAdmissionV1 = z.infer<typeof DeploymentPreparationAdmissionV1Schema>;

/** Project only the closed read-purpose fields, independently of Action catalog initialization. */
export function projectDeploymentPreparationAdmissionV1(actionId: string, input: unknown): DeploymentPreparationAdmissionV1 | undefined {
  const operation = deploymentPreparationOperationForActionV1(actionId);
  if (operation === undefined) return undefined;
  const value = readRecord(input);
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
      ...(value.preview === undefined ? {} : { preview: value.preview }),
      ...(value.contentArtifactId === undefined ? {} : { candidate: { contentArtifactId: value.contentArtifactId,
        contentHeaderVersion: value.contentHeaderVersion, contentBodyVersion: value.contentBodyVersion } }),
      ...(value.deployerPrincipals === undefined ? {} : { deployerPrincipals: value.deployerPrincipals }) });
  if (operation === 'catalog') return DeploymentPreparationAdmissionV1Schema.parse({ operation,
    ...(value.newProject ? { newProject: value.newProject } : { source: { id: value.projectSourceId, revision: value.sourceRevision } }),
    machineId: value.machineId, installationId: value.installationId });
  if (operation === 'setup') {
    // The existing target schemas own both literal catalog children and stored
    // candidates. No-app setup keeps its unchanged admission.
    const candidates = Array.isArray(value.targets) ? value.targets : [input];
    if (!candidates.some(target => {
      const children = readRecord(target).appChildren;
      return Array.isArray(children) && children.some(child => readRecord(child).actionId === 'deployments.deploy'
        || readRecord(child).actionId === 'deployments.templates.instantiate');
    })) return undefined;
    const root = actionId === 'machines.setup.apply' ? MachineSetupApplyInputV1Schema.parse(input)
      : Array.isArray(value.targets) ? MachineSetupCombinedPlanInputV1Schema.parse(input) : MachineSetupPlanInputV1Schema.parse(input);
    const targets = 'targets' in root ? root.targets : [root];
    const deployments = targets.flatMap(target => {
      if (target.homeId !== root.homeId) throw new TypeError('Setup preparation Home mismatch');
      return (target.appChildren ?? []).flatMap(child => {
        if (child.actionId !== 'deployments.deploy') return [];
        if (child.input.serverId !== root.homeId) throw new TypeError('Setup app preparation Home mismatch');
        return [{ machineId: target.machineId,
          environment: { id: child.input.environmentId, revision: child.input.expectedRevision },
          target: { id: child.input.targetLinkId, revision: child.input.expectedTargetLinkRevision },
          candidate: { contentArtifactId: child.input.contentArtifactId, contentHeaderVersion: child.input.contentHeaderVersion,
            contentBodyVersion: child.input.contentBodyVersion } }];
      });
    });
    const catalogSources = targets.flatMap(target => (target.appChildren ?? []).flatMap(child => {
      if (child.actionId !== 'deployments.templates.instantiate' || child.input.projectSourceId === undefined) return [];
      if (child.input.serverId !== root.homeId) throw new TypeError('Setup app preparation Home mismatch');
      return [{ machineId: target.machineId, source: { id: child.input.projectSourceId } }];
    }));
    if (deployments.length === 0 && catalogSources.length === 0) return undefined;
    return DeploymentPreparationAdmissionV1Schema.parse({ operation, deployments,
      ...(catalogSources.length ? { catalogSources } : {}) });
  }
  if (actionId === 'deployments.templates.instantiate') {
    const environment = readRecord(value.environment);
    return DeploymentPreparationAdmissionV1Schema.parse({ operation: 'template', mode: value.mode,
      ...(value.deploy === undefined ? {} : { deploy: value.deploy }),
      ...(value.newProject ? { newProject: value.newProject } : { source: { id: value.projectSourceId } }), machineId: value.machineId, target: value.target,
      environment: environment.kind === 'existing' ? environment : {
        kind: environment.kind, requestKey: environment.requestKey, protection: environment.protection,
        purpose: environment.purpose, deployerMode: environment.deployerMode,
        ...(environment.deployerPrincipals === undefined ? {} : { deployerPrincipals: environment.deployerPrincipals }), controllerMachineId: environment.controllerMachineId,
        ...(environment.buildMachineId === undefined ? {} : { buildMachineId: environment.buildMachineId }),
      } });
  }
  if (actionId === 'deployments.prepare') {
    const workspace = readRecord(value.workspace);
    const environmentId = value.environmentId ?? readRecord(value.target).environmentId;
    return DeploymentPreparationAdmissionV1Schema.parse({ operation: 'prepare',
      source: { id: value.projectSourceId, revision: value.sourceRevision },
      workspace: { kind: workspace.kind, id: workspace.id },
      ...(environmentId === undefined ? {} : { environment: { id: environmentId } }) });
  }
  const project = readRecord(value.project);
  const environment = readRecord(value.environment);
  const candidate = readRecord(readRecord(value.preparedChildren).deploy);
  return DeploymentPreparationAdmissionV1Schema.parse({ operation: 'publish',
    ...(project.kind === 'existing' ? { source: { id: project.projectSourceId, revision: project.sourceRevision } } : {}),
    ...(environment.kind === 'existing' ? { environment: { id: environment.environmentId, revision: environment.expectedRevision } } : {}),
    candidate: { contentArtifactId: candidate.contentArtifactId,
      contentHeaderVersion: candidate.contentHeaderVersion, contentBodyVersion: candidate.contentBodyVersion } });
}
