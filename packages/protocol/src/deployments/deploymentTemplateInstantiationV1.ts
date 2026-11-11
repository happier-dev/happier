import { RegistryAppMappingV1Schema } from '../registries/registryAppMappingV1.js';
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { readRecord } from '../inputs/inputRecords.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentTemplateRefV1Schema, DeploymentDigestV1Schema, DeploymentComposeSelectorsV1Schema, DeploymentStoredDefinitionV1Schema,
  StoredAppPresetInputV1Schema, StoredAppPresetBindingsV1Schema, EnvironmentVariableBindingV1Schema, DeploymentSecretBindingSourceV1Schema,
  DeploymentNewProjectV1Schema, hasOneDeploymentProjectV1, DeploymentTargetManagedRetentionV1Schema,
  DeploymentTextV1Schema, DeploymentStoredDefinitionInputV1Schema, DeploymentCatalogAppDefinitionInputV1Schema, DeploymentRepositoryComposeV1Schema } from './storedAppInputV1.js';
import { SharedSavedSecretCreateInputV1Schema } from '../account/settings/savedSecretResourceActionsV1.js';
import { DeploymentTemplateV1Schema, DeploymentTemplateSecretProfileV1Schema } from '../plugins/contributions/deploymentTemplates.js';
import { ResolvedDeploymentCreationDefaultsV1Schema, DeploymentRetainPreviousDeploymentsV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { DeploymentEnvironmentDeployerPrincipalsV1Schema } from './deploymentEnvironmentDeployerV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { DeploymentReceiptAcceptedResultV1Schema } from './deploymentReceiptResultV1.js';
import type { ActionApprovalRequestCreatedResult, ActionExecuteFailure, ActionExecuteResult } from '../actions/actionExecutionResult.js';
import { DeploymentBindingsPatchInputV1Schema } from './deploymentBindingPatchV1.js';
import { DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateBaseInputV1Schema, DeploymentOwnServerTargetMachinesV1Schema } from './deploymentEnvironmentCreateV1.js';
import { DeploymentPreviewReferenceV1Schema } from './deploymentPreviewReferenceV1.js';
import { DeploymentPreviewProvenanceV1Schema } from './deploymentPreviewProvenanceV1.js';
import { DeploymentEnvironmentCopyFromV1Schema } from './deploymentEnvironmentCopyV1.js';
import { DeploymentDomainFailureDetailsV1Schema } from './deploymentDomainFailureV1.js';
import { ProjectAccountWorkspaceRefKeyV1Schema } from '../projects/workspaceRefKeyV1.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';
import { ScmCommitOidSchema } from '../scm/commitPublication.js';
import { ScmRepositoryContainedSubdirV1Schema } from '../scm/repositoryClone.js';
import { ScmPullRequestSummarySchema } from '../scm/pullRequests.js';
import { ScmRepositoryFilesPullRequestResultV1Schema } from '../scm/repositoryFilesPullRequest.js';

const existingEnvironment = lazyZodSchema(() => z.strictObject({ kind: z.literal('existing'), environmentId: id, expectedRevision: revision }));
const createEnvironment = lazyZodSchema(() => z.strictObject({ kind: z.literal('create'), name: StoredAppPresetInputV1Schema.shape.name, requestKey: id,
  protection: z.enum(['production', 'nonProduction']), purpose: z.literal('standard'),
    deployerMode: z.enum(['managers', 'members', 'chosen']), deployerPrincipals: z.optional(DeploymentEnvironmentDeployerPrincipalsV1Schema), controllerMachineId: id, buildMachineId: z.optional(id),
    retainPreviousDeployments: z.optional(ResolvedDeploymentCreationDefaultsV1Schema.shape.values.shape.retainPreviousDeployments) }));
const existingTarget = lazyZodSchema(() => z.strictObject({ kind: z.literal('existing'), targetLinkId: id,
  expectedRevision: revision, installationId: id }));
const newTarget = lazyZodSchema(() => z.strictObject({ kind: z.literal('new'), installationId: id }));
const storedPin = lazyZodSchema(() => z.strictObject({ kind: z.literal('stored'), contentRevision: revision, composeDigest: DeploymentDigestV1Schema }));
const deploy = lazyZodSchema(() => z.strictObject({ requestKey: id }));
const repositoryDestination = lazyZodSchema(() => z.strictObject({ kind: z.literal('repositoryPullRequest'),
  workspace: ProjectAccountWorkspaceRefKeyV1Schema, sourceRevision: revision, repository: ScmHostingRepositoryIdentityV1Schema,
  baseCommit: ScmCommitOidSchema, baseBranch: id, branchName: id, composePath: ScmRepositoryContainedSubdirV1Schema, title: id }));

/** Selected Domains on a new Environment include its first deploy in the root intent. */
export function readDeploymentTemplateDeployIntentV1(input: unknown): z.infer<typeof deploy> | undefined {
  const value = readRecord(input);
  if (value.deploy !== undefined) return deploy.parse(value.deploy);
  const environment = readRecord(value.environment);
  return environment.kind === 'create' && Array.isArray(value.domainBindings) && value.domainBindings.length > 0
    ? deploy.parse({ requestKey: environment.requestKey }) : undefined;
}

/** Omission keeps generated credentials private to their creator; explicit grants are reviewed. */
export const DeploymentTemplateGeneratedSecretAudienceV1Schema = lazyZodSchema(() => z.pick(SharedSavedSecretCreateInputV1Schema,
  { accountGrants: true, teamGrants: true, groupGrants: true }));

/** A repository definition is changed only through its reviewed source pull request. */
export const DeploymentTemplateInstantiateInputV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.enum(['preview', 'apply']), serverId: id, machineId: id, projectSourceId: z.optional(id), newProject: z.optional(DeploymentNewProjectV1Schema),
  templateRef: DeploymentTemplateRefV1Schema,
  appMappingCorrection: z.optional(RegistryAppMappingV1Schema),
  /** Add another instance; omission preserves replacement/upgrade semantics. Names are owned by template preparation. */
  intent: z.optional(z.literal('add')),
  environment: z.discriminatedUnion('kind', [existingEnvironment, createEnvironment]),
  target: z.discriminatedUnion('kind', [existingTarget, newTarget]),
  managedRetention: z.optional(DeploymentTargetManagedRetentionV1Schema),
  destination: z.union([storedPin, z.strictObject({ kind: z.literal('stored') }), repositoryDestination]),
  bindings: StoredAppPresetBindingsV1Schema,
  generatedSecretAudience: z.optional(DeploymentTemplateGeneratedSecretAudienceV1Schema),
  connectTo: z.optional(z.strictObject({ service: id })), replace: z.optional(z.array(id)),
  domainBindings: z.optional(z.array(z.strictObject({ templateDomainId: id, hostname: id }))),
  volumeBindings: z.optional(z.array(z.strictObject({ templateVolumeId: id, source: id }))),
  /** Reviewed optional template companions (for example PostgreSQL's PgBouncer); omission selects none. */
  companions: z.optional(z.array(id)),
  deploy: z.optional(deploy),
}).check(z.superRefine((input, context) => {
  if (!hasOneDeploymentProjectV1(input.projectSourceId, input.newProject) || input.newProject && input.environment.kind !== 'create') {
    context.addIssue({ code: 'custom', path: ['newProject'], message: 'Select one Project; an existing Environment retains its Source.' });
  }
  if (input.environment.kind === 'create' && ('contentRevision' in input.destination || input.target.kind !== 'new')) {
    context.addIssue({ code: 'custom', path: ['destination'], message: 'A new Environment creates a new stored definition and target.' });
  }
  if (input.destination.kind === 'repositoryPullRequest' && (input.environment.kind !== 'existing' || input.deploy || input.domainBindings?.length)) {
    context.addIssue({ code: 'custom', path: ['destination'], message: 'Review a repository pull request for an existing Environment; merge and deploy separately.' });
  }
})));
export type DeploymentTemplateInstantiateInputV1 = z.infer<typeof DeploymentTemplateInstantiateInputV1Schema>;

/** Catalog defaults select declared generators and grant no additional access to their Saved Secrets. */
export function buildCatalogAppTemplateBindings(template: z.infer<typeof DeploymentTemplateV1Schema>,
  selected: DeploymentTemplateInstantiateInputV1['bindings'] = []): Pick<DeploymentTemplateInstantiateInputV1,
  'bindings' | 'generatedSecretAudience'> {
  const chosen = new Set(selected.map(binding => JSON.stringify([binding.phase, binding.name])));
  const bindings: DeploymentTemplateInstantiateInputV1['bindings'] = [...selected, ...template.generatedSecrets
    .filter(secret => !chosen.has(JSON.stringify(['runtime', secret.key])))
    .map(secret => ({ purpose: 'variable' as const, name: secret.key, phase: 'runtime' as const, source: { kind: 'generated' as const, key: secret.key } }))];
  return { bindings, ...(bindings.some(binding => binding.source.kind === 'generated') ? { generatedSecretAudience: { accountGrants: [], teamGrants: [], groupGrants: [] } } : {}) };
}

/** A template creation keeps its retained operation identity across transport retries. */
export function readDeploymentTemplateCreationOperationRequestIdV1(input: DeploymentTemplateInstantiateInputV1): string | undefined {
  if (input.mode !== 'apply' || input.environment.kind !== 'create') return undefined;
  return computeCanonicalDomainSeparatedDigest('happier-deployment-operation-request-v1', [
    // The parsed template requires exactly one existing Source or new Project.
    'template', input.serverId, input.projectSourceId ?? input.newProject!.requestKey, input.machineId,
    input.target.installationId, input.environment.requestKey,
  ]);
}

/** The original template root belongs to the Environment controller; machineId selects its runtime resource. */
export async function resolveDeploymentTemplateExecutionMachineIdV1(
  input: DeploymentTemplateInstantiateInputV1,
  readEnvironment: (request: Readonly<{ serverId: string; environmentId: string }>) => Promise<
    Readonly<{ ok: true; environment: Pick<z.infer<typeof DeploymentEnvironmentCreateInputV1Schema>, 'controllerMachineId'> }>
    | Readonly<{ ok: false; error: string }> | ActionExecuteFailure>,
  readRepositoryWorkspace?: (request: Readonly<{ serverId: string; workspace: z.infer<typeof ProjectAccountWorkspaceRefKeyV1Schema> }>) => Promise<Readonly<{ ok: true; machineId: string }> | ActionExecuteFailure>,
): Promise<Readonly<{ ok: true; machineId: string }> | ActionExecuteFailure> {
  if (input.destination.kind === 'repositoryPullRequest') return readRepositoryWorkspace
    ? readRepositoryWorkspace({ serverId: input.serverId, workspace: input.destination.workspace })
    : { ok: false, errorCode: 'workspace_unavailable', error: 'workspace_unavailable' };
  if (input.environment.kind === 'create') return { ok: true, machineId: input.environment.controllerMachineId };
  const loaded = await readEnvironment({ serverId: input.serverId, environmentId: input.environment.environmentId });
  if (!loaded.ok) return 'errorCode' in loaded ? loaded : { ok: false, errorCode: loaded.error, error: loaded.error };
  return { ok: true, machineId: loaded.environment.controllerMachineId };
}

export const DeploymentTemplateCapacityReviewV1Schema = lazyZodSchema(() => z.array(z.strictObject({
  resource: z.enum(['memoryBytes', 'freeDiskBytes']), minimumBytes: z.number().check(z.minimum(0)),
  observedBytes: z.nullable(z.number().check(z.minimum(0))), observedAt: z.nullable(z.number().check(z.minimum(0))),
  state: z.enum(['shortfall', 'meetsMinimum', 'unknown']),
})));
export type DeploymentTemplateCapacityReviewV1 = z.infer<typeof DeploymentTemplateCapacityReviewV1Schema>;
export const DeploymentTemplateInstantiationReviewV1Schema = lazyZodSchema(() => z.strictObject({
  templateRef: DeploymentTemplateRefV1Schema, ...DeploymentComposeSelectorsV1Schema.shape,
  document: z.optional(DeploymentStoredDefinitionV1Schema.shape.document),
  ...z.pick(DeploymentTemplateV1Schema.shape.compose, { publicFiles: true }).shape,
  bindings: z.array(EnvironmentVariableBindingV1Schema),
  connectToServices: z.optional(z.array(id)),
  generatedSecrets: z.array(z.strictObject({ name: id, phase: z.enum(['build', 'runtime']), key: id,
    profile: DeploymentTemplateSecretProfileV1Schema })),
  domains: z.array(z.extend(DeploymentTemplateV1Schema.shape.domains.def.element, { hostname: id })),
  minimumResources: DeploymentTemplateV1Schema.shape.minimumResources,
  firstRunSetup: DeploymentTemplateV1Schema.shape.firstRunSetup,
  creationDefaults: z.optional(ResolvedDeploymentCreationDefaultsV1Schema),
  creationDefaultsBasis: z.optional(z.strictObject({ projectSourceId: id, sourceRevision: revision,
    projectDefaultsRevision: z.number().check(z.int(), z.minimum(0)),
    content: z.nullable(DeploymentArtifactContentReferenceV1Schema) })),
  capacity: z.optional(DeploymentTemplateCapacityReviewV1Schema),
  deploy: z.optional(deploy),
  repositoryChange: z.optional(z.strictObject({ ...repositoryDestination.shape,
    files: z.array(z.strictObject({ path: ScmRepositoryContainedSubdirV1Schema, before: z.nullable(z.string()), content: z.nullable(z.string()) })) })),
}));
export type DeploymentTemplateInstantiationReviewV1 = z.infer<typeof DeploymentTemplateInstantiationReviewV1Schema>;

/** A newer sample of equal capacity is the same reviewed fact, not new consent. */
export function areDeploymentTemplateReviewFactsEqualV1(left: unknown, right: unknown): boolean {
  const before = DeploymentTemplateInstantiationReviewV1Schema.safeParse(left);
  const after = DeploymentTemplateInstantiationReviewV1Schema.safeParse(right);
  if (!before.success || !after.success) return false;
  const facts = ({ capacity, ...review }: DeploymentTemplateInstantiationReviewV1) => ({ ...review,
    ...(capacity ? { capacity: capacity.map(({ observedAt: _observedAt, ...value }) => value) } : {}) });
  return sameStrictJsonValue(facts(before.data), facts(after.data));
}
const savedSecrets = lazyZodSchema(() => z.array(z.strictObject({ name: id, phase: z.enum(['build', 'runtime']),
  source: DeploymentSecretBindingSourceV1Schema })));
export const DeploymentTemplateInstantiationPartialV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('partial'), environmentId: z.optional(id), revision: z.optional(revision),
  targetLinkId: z.optional(id), definition: z.optional(storedPin), savedSecrets,
  phase: z.enum(['generation', 'repository', 'environment', 'target', 'bindings', 'metadata', 'domains', 'deploy']), errorCode: id,
  repositoryChange: z.optional(ScmRepositoryFilesPullRequestResultV1Schema),
  requiredFact: z.optional(z.string()), remedy: z.optional(z.string()),
  failure: z.optional(DeploymentDomainFailureDetailsV1Schema),
  deployment: z.optional(DeploymentReceiptAcceptedResultV1Schema),
  continuation: z.optional(z.discriminatedUnion('actionId', [
    z.strictObject({ actionId: z.literal('deployments.environments.create'), input: DeploymentEnvironmentCreateInputV1Schema }),
    z.strictObject({ actionId: z.literal('deployments.bindings.set'), input: DeploymentBindingsPatchInputV1Schema }),
  ])),
  unknownSecret: z.optional(z.strictObject({ name: id, phase: z.enum(['build', 'runtime']), ref: DeploymentSecretBindingSourceV1Schema.shape.ref })),
}));
/** Acknowledged effects survive later failure; ambiguous create refs never masquerade as saved credentials. */
export const DeploymentTemplateInstantiateResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('preview'), review: DeploymentTemplateInstantiationReviewV1Schema }),
  z.strictObject({ kind: z.literal('pullRequest'), environmentId: id, revision, savedSecrets,
    pullRequest: ScmPullRequestSummarySchema, headCommit: ScmCommitOidSchema, branchName: id }),
  z.strictObject({ kind: z.literal('applied'), environmentId: id, revision, targetLinkId: id,
    definition: storedPin, savedSecrets, deployment: z.optional(DeploymentReceiptAcceptedResultV1Schema) }).check(z.refine(value =>
      value.deployment === undefined || 'deploymentId' in value.deployment
        && (value.deployment.state === 'succeeded' || value.deployment.state === 'running_unverified'),
    { message: 'An applied template deployment must have settled successfully.' })),
  DeploymentTemplateInstantiationPartialV1Schema,
]));
export type DeploymentTemplateInstantiateResultV1 = z.infer<typeof DeploymentTemplateInstantiateResultV1Schema>;

/** A returned partial settles the root invocation while preserving recovery for its failed step. */
export function readDeploymentTemplateInstantiationPartialV1(
  failure: ActionExecuteFailure,
): z.infer<typeof DeploymentTemplateInstantiationPartialV1Schema> | undefined {
  const parsed = DeploymentTemplateInstantiationPartialV1Schema.safeParse(failure.details);
  return parsed.success && parsed.data.errorCode === failure.errorCode ? parsed.data : undefined;
}

/** Preserve the producer's failure evidence while exposing partial progress as a failure. */
export function projectDeploymentTemplateInstantiationResultV1(
  result: DeploymentTemplateInstantiateResultV1 | ActionApprovalRequestCreatedResult | ActionExecuteFailure,
): ActionExecuteResult {
  if ('ok' in result) return result;
  if (result.kind === 'partial') {
    return { ok: false, errorCode: result.errorCode, error: result.errorCode, details: result };
  }
  return { ok: true, result };
}

/** Authored create is resolved for review by the host; Home still accepts only the prepared CreateInput. */
export const DeploymentEnvironmentCreateIntentInputV1Schema = lazyZodSchema(() => z.extend(z.omit(DeploymentEnvironmentCreateBaseInputV1Schema, {
  contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true, firstTargetLink: true,
  controllerMachineId: true, buildMachineId: true,
  preview: true, previewDataTargetLinks: true,
}), {
  /** Preview derives its name; the normalized omission must survive review parsing. */
  name: z._default(z.union([DeploymentTextV1Schema, z.literal('')]), ''),
  /** Authored PR intent; the controller reads the selected template and protects child content. */
  preview: z.optional(z.extend(DeploymentPreviewReferenceV1Schema, {
    provenance: DeploymentPreviewProvenanceV1Schema, headSha: ScmCommitOidSchema,
  })),
  mode: z.optional(z.enum(['preview', 'apply'])),
  definition: z.optional(z.union([DeploymentStoredDefinitionInputV1Schema, DeploymentCatalogAppDefinitionInputV1Schema,
    z.strictObject({ from: z.literal('repository'), ref: DeploymentTextV1Schema, compose: z.optional(DeploymentRepositoryComposeV1Schema) })])),
  copyFrom: z.optional(DeploymentEnvironmentCopyFromV1Schema),
  controllerMachineId: z.optional(id), buildMachineId: z.optional(id),
  retainPreviousDeployments: z.optional(DeploymentRetainPreviousDeploymentsV1Schema),
  bindings: z.optional(DeploymentTemplateInstantiateInputV1Schema.shape.bindings),
  generatedSecretAudience: DeploymentTemplateInstantiateInputV1Schema.shape.generatedSecretAudience,
  domainBindings: DeploymentTemplateInstantiateInputV1Schema.shape.domainBindings,
  firstTargetLink: z.optional(z.strictObject({ machines: DeploymentOwnServerTargetMachinesV1Schema })),
}).check(z.refine(input => hasOneDeploymentProjectV1(input.projectSourceId, input.newProject), { message: 'Select an existing or reviewed new Project.' }),
  z.refine(input => input.purpose === 'preview' || input.previewCompanionOfEnvironmentId !== undefined
    ? (input.purpose !== 'preview' || input.previewCompanionOfEnvironmentId === undefined)
    && input.preview !== undefined && input.projectSourceId !== undefined
    && input.newProject === undefined && input.copyFrom === undefined && input.definition === undefined && input.firstTargetLink === undefined
    && input.protection === 'nonProduction' : input.preview === undefined && input.name.trim().length > 0,
    { message: 'A preview or its named companion derives from one template and existing Source; ordinary creation requires a name.' }),
  z.refine(input => input.newProject === undefined || input.definition?.from !== 'repository', { message: 'A new repository-free Project needs a stored definition.' }),
  z.refine(input => input.newProject === undefined || input.copyFrom === undefined, { message: 'A new repository-free Project selects its stored definition.' }),
  z.refine(input => input.definition?.from === 'catalogApp'
    || input.bindings === undefined && input.generatedSecretAudience === undefined && input.domainBindings === undefined,
    { message: 'Catalog variables and generation are prepared by the template owner.' }),
  z.refine(input => input.firstTargetLink === undefined || input.definition?.from !== 'repository' || input.definition.compose !== undefined,
    { message: 'An own-server first target requires repository Compose selectors.' }),
  z.refine(input => input.preview !== undefined || input.copyFrom !== undefined || input.definition !== undefined,
  { message: 'Create selects an authored definition or an exact source copy.' })));
export type DeploymentEnvironmentCreateIntentInputV1 = z.infer<typeof DeploymentEnvironmentCreateIntentInputV1Schema>;
