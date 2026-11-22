import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { QualifiedProjectKeyV1Schema, WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';
import { ProjectManifestV1Schema } from '../workspaces/projectSetup/projectManifestV1.js';
import { ProjectEffectiveDefinitionV1Schema, resolveProjectDefinitionV1 } from '../workspaces/projectSetup/projectDefinitionCompositionV1.js';
import { ProjectAccountOrganizationActionViewV1Schema, ProjectAccountOrganizationV1Schema, ProjectAccountRowExpectedRevisionV1Schema, projectProjectAccountOrganizationActionViewV1 } from './projectAccountRowsV1.js';
import { ProjectSetupContentV1Schema, ProjectSetupSelectionV1Schema, projectSetupSelectionV1,
  PROJECT_SETUP_ARTIFACT_KIND_V1, readAcceptedProjectSetupV1 } from './projectSetupV1.js';
import { readPublishedProjectSetupV1 } from './projectSetupChangeV1.js';
import { ProjectSourcesReadInputV1Schema, ProjectSourcesReadOutputV1Schema } from './sources/projectSourceV1.js';
import { ArtifactActionInputSchemasV1, ArtifactActionOutputSchemasV1 } from '../artifacts/artifactActionsV1.js';
import { ProjectDefinitionInspectInputSchema, ProjectDefinitionInspectOutputSchema } from '../actions/projectDefinitionActionFamily.js';
import { PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1 } from '../actions/projectActionIdsV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import type { ActionId } from '../actions/actionIds.js';
import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';
import { ActionExecuteFailureSchema, ActionFailureCauseV1Schema, projectActionFailureCauseV1 } from '../actions/actionExecutionResult.js';
import type { ProjectContextActionOwnerDepsV1 } from './projectContextV1.js';

export const ProjectSetupSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  projectRef: QualifiedProjectKeyV1Schema, workspace: WorkspaceAddressV1Schema,
  expectedRevision: ProjectAccountRowExpectedRevisionV1Schema,
  intent: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('accept'), sourceId: z.string().check(z.minLength(1)),
      expectedSelection: z.optional(ProjectSetupSelectionV1Schema) }),
    z.strictObject({ kind: z.literal('detach') }),
    z.strictObject({ kind: z.literal('personal'), setupOverrides: z.nullable(ProjectManifestV1Schema) }),
  ]),
}));
export type ProjectSetupSetInputV1 = z.infer<typeof ProjectSetupSetInputV1Schema>;
export const ProjectSetupSetOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), row: ProjectAccountOrganizationActionViewV1Schema,
    revision: z.number().check(z.int(), z.nonnegative()), effectiveDefinition: ProjectEffectiveDefinitionV1Schema }),
  z.strictObject({ ok: z.literal(false), errorCode: z.string().check(z.minLength(1)),
    currentRevision: z.optional(ProjectAccountRowExpectedRevisionV1Schema), details: ActionExecuteFailureSchema.shape.details, failureCause: z.optional(ActionFailureCauseV1Schema) }),
]));
export type ProjectSetupSetOutputV1 = z.infer<typeof ProjectSetupSetOutputV1Schema>;

/** The host and signed receivers share one finite purpose grammar; domain access still applies. */
export function isProjectSetupSetChildInputV1(root: ProjectSetupSetInputV1, actionId: string, input: unknown,
  canonicalHomeId?: string): boolean {
  if (actionId === PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.sourceRead) {
    const child = ProjectSourcesReadInputV1Schema.safeParse(input);
    return child.success && root.intent.kind === 'accept'
      && (child.data.serverId === root.projectRef.serverId || child.data.serverId === canonicalHomeId)
      && child.data.sourceId === root.intent.sourceId;
  }
  if (actionId === PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.artifactRead) {
    const child = ArtifactActionInputSchemasV1['artifact.get'].safeParse(input);
    return child.success && (child.data.projectSourceId === undefined
      || root.intent.kind === 'accept' && child.data.projectSourceId === root.intent.sourceId);
  }
  if (actionId === PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.inspect) {
    const child = ProjectDefinitionInspectInputSchema.safeParse(input);
    return child.success && child.data.read?.kind === 'editor' && child.data.reviewSharedSetup === undefined
      && child.data.reviewSetupConsent === undefined && child.data.ifRevision === undefined
      && (child.data.workspace.serverId === root.workspace.serverId || child.data.workspace.serverId === canonicalHomeId)
      && createCanonicalJsonSigningInput({ ...child.data.workspace, serverId: root.workspace.serverId })
        === createCanonicalJsonSigningInput(root.workspace);
  }
  if (actionId === PROJECT_SETUP_SET_CHILD_ACTION_IDS_V1.artifactCreate) {
    const child = ArtifactActionInputSchemasV1['artifact.create'].safeParse(input);
    if (!child.success || child.data.header.kind !== PROJECT_SETUP_ARTIFACT_KIND_V1 || !('body' in child.data) || typeof child.data.body !== 'string'
      || Object.keys(child.data).some(key => key !== 'header' && key !== 'body')) return false;
    try { return ProjectSetupContentV1Schema.safeParse(JSON.parse(child.data.body) as unknown).success; } catch { return false; }
  }
  return false;
}
export type ProjectSetupSetOwnerDepsV1 = Readonly<{
  mutateOrganization(input: Omit<Parameters<ProjectContextActionOwnerDepsV1['mutateOrganization']>[0], 'mutate'> & {
    mutate(value: z.infer<typeof ProjectAccountOrganizationV1Schema>): Promise<z.infer<typeof ProjectAccountOrganizationV1Schema>>;
  }): ReturnType<ProjectContextActionOwnerDepsV1['mutateOrganization']>;
  execute(actionId: ActionId, input: unknown): Promise<ActionExecuteResult>;
}>;

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** One accepted-copy writer: selected Source reads, protected detail, then the existing row CAS.
 * A fresh detail per changed intent leaves the incumbent intact when the final row CAS loses.
 * This reversible edit never grants execution consent; projects.prepare remains its human owner.
 */
export async function setProjectSetupV1(deps: ProjectSetupSetOwnerDepsV1, input: ProjectSetupSetInputV1,
  options?: Readonly<{ signal?: AbortSignal }>): Promise<ProjectSetupSetOutputV1> {
  options?.signal?.throwIfAborted();
  if (input.projectRef.serverId !== input.workspace.serverId) return { ok: false, errorCode: 'project_workspace_association_mismatch' };
  const execute = async (actionId: ActionId, request: unknown) => {
    const result = await deps.execute(actionId, request);
    if (!result.ok) throw Object.assign(new Error(result.errorCode), result, { code: result.errorCode });
    return result.result;
  };
  let effectiveDefinition: z.infer<typeof ProjectEffectiveDefinitionV1Schema> | undefined;
  try {
    const result = await deps.mutateOrganization({ ...input.projectRef, expectedRevision: input.expectedRevision,
      signal: options?.signal, mutate: async organization => {
        const accepted = await readAcceptedProjectSetupV1({ ...organization, signal: options?.signal,
          readArtifact: async artifactId => ArtifactActionOutputSchemasV1['artifact.get'].parse(
            await execute('artifact.get', { artifactId })).artifact });
        if (accepted.kind === 'unavailable') return fail(accepted.code);
        const { kind: _kind, ...before } = accepted;
        const content = { ...before };
        if (input.intent.kind === 'accept') {
          const source = ProjectSourcesReadOutputV1Schema.parse(await execute('projects.sources.read', {
            serverId: input.projectRef.serverId, sourceId: input.intent.sourceId }));
          if (!source.ok) throw Object.assign(new Error(source.error), source, { code: source.error });
          const publication = await readPublishedProjectSetupV1({ source: source.source,
            readArtifact: async (artifactId, projectSourceId) => ArtifactActionOutputSchemasV1['artifact.get'].parse(
              await execute('artifact.get', { artifactId, projectSourceId })).artifact });
          const selection = projectSetupSelectionV1(publication);
          const expected = input.intent.expectedSelection;
          if (expected && (expected.sourceId !== selection.sourceId || expected.digest !== selection.digest
            || expected.contentRevision.headerVersion !== selection.contentRevision.headerVersion
            || expected.contentRevision.bodyVersion !== selection.contentRevision.bodyVersion)) return fail('project_setup_effect_changed');
          content.acceptedSharedSetup = publication;
        } else if (input.intent.kind === 'detach') delete content.acceptedSharedSetup;
        else if (input.intent.setupOverrides === null) delete content.setupOverrides;
        else content.setupOverrides = input.intent.setupOverrides;
        const inspection = ProjectDefinitionInspectOutputSchema.parse(await execute('projects.inspect', {
          workspace: input.workspace, read: { kind: 'editor', target: 'repository' } }));
        if (inspection.definition.document?.status === 'invalid') return fail('invalid_manifest');
        effectiveDefinition = resolveProjectDefinitionV1({ repositoryManifest:
          inspection.definition.document?.manifest ?? null, ...content });
        // Equality belongs to the producer: unchanged refreshes create no detail or row write.
        if (JSON.stringify(content) === JSON.stringify(before)) return organization;
        const next = { ...organization };
        if (content.acceptedSharedSetup) {
          const selection = projectSetupSelectionV1(content.acceptedSharedSetup);
          next.setupSelection = selection;
        } else delete next.setupSelection;
        if (!content.acceptedSharedSetup && !content.setupOverrides) delete next.setupContent;
        else {
          const detail = ArtifactActionOutputSchemasV1['artifact.create'].parse(await execute('artifact.create', {
            header: { kind: PROJECT_SETUP_ARTIFACT_KIND_V1 },
            body: JSON.stringify(ProjectSetupContentV1Schema.parse({ kind: PROJECT_SETUP_ARTIFACT_KIND_V1, ...content })),
          }));
          next.setupContent = { artifactId: detail.artifactId, ...detail.revision };
        }
        return next;
      } });
    if (result.status === 'conflict') return { ok: false, errorCode: 'project_setup_conflict',
      currentRevision: result.revision < 0 ? 'absent' : result.revision };
    if (!effectiveDefinition) return fail('project_setup_review_unavailable');
    return { ok: true, row: projectProjectAccountOrganizationActionViewV1(result.value), revision: result.revision, effectiveDefinition };
  } catch (error) {
    options?.signal?.throwIfAborted();
    const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    return { ok: false, errorCode: typeof code === 'string' ? code : 'project_setup_review_unavailable',
      failureCause: projectActionFailureCauseV1(error, 'projects.setup.set') };
  }
}
