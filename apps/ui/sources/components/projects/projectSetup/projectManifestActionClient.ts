import {
  ProjectDefinitionInspectOutputSchema,
  ProjectDefinitionInspectResultSchema,
  ProjectWorktreePortsReassignInputSchema,
  type ProjectDefinitionWorkspace,
  type ProjectDefinitionInspectRead,
} from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { PROJECT_WORKTREE_PORTS_REASSIGN_ACTION_ID } from '@happier-dev/protocol/actions/projectDefinitionActionIdsV1';
import { WorktreePortsResultV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/worktreePortsV1';
import {
  readProjectSetupConsentFailureV1,
  readProjectWorkerNoAcceptanceFailureV1,
  PROJECT_ACTION_INPUT_SCHEMAS_V1,
  PROJECT_ACTION_OUTPUT_SCHEMAS_V1,
  type ProjectPrepareInputV1,
  type ProjectWorkerNoAcceptanceFailureDetailsV1,
} from '@happier-dev/protocol/actions/projectActionFamily';
import { ArtifactActionInputSchemasV1, ArtifactActionOutputSchemasV1, type ArtifactActionResultV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ProjectSharedSetupV1Schema, PROJECT_SETUP_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/projects/projectSetupV1';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { ProjectSourcesUpdateInputV1Schema, ProjectSourcesUpdateOutputV1Schema, type ProjectSourcePublicationPatchV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectOrganizationUpdateInputV1Schema, ProjectOrganizationUpdateOutputV1Schema,
  type ProjectOrganizationUpdateInputV1 } from '@happier-dev/protocol/projects/projectOrganizationV1';
import { ProjectSetupSetInputV1Schema, ProjectSetupSetOutputV1Schema,
  type ProjectSetupSetInputV1 } from '@happier-dev/protocol/projects/projectSetupSetV1';
import {
  ProjectManifestUpdateResultSchema,
  readProjectManifestDocument,
  type ProjectManifestFileBasisV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { readAcceptedProjectSetupV1 } from '@happier-dev/protocol/projects/projectSetupV1';
import type { ProjectAccountOrganizationV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { PersonalProjectManifestEditorUpdateResult, ProjectManifestEditorDefinition } from './projectManifestEditorModel';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { ActionOperationProjectScriptSelection } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { safeParse, type core } from 'zod/mini';

import {
  awaitActionApprovalResult,
  createActionApprovalContinuation,
  type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { randomUUID } from '@/platform/randomUUID';
import { HappyError } from '@/utils/errors/errors';

type ActionInvocation = (
  actionId: 'projects.inspect' | 'projects.manifest.update' | 'projects.script.run' | 'projects.prepare' | 'projects.organization.update' | 'projects.setup.set' | 'artifact.get' | 'artifact.create' | 'projects.sources.update' | typeof PROJECT_WORKTREE_PORTS_REASSIGN_ACTION_ID,
  input: unknown,
  context?: Parameters<ReturnType<typeof createFrontDoorActionExecute>>[2],
) => ReturnType<ReturnType<typeof createFrontDoorActionExecute>>;
type Execute = ActionInvocation & Readonly<{ confirmed?: ActionInvocation }>;
type Outcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: string; workerRefusal?: ProjectWorkerNoAcceptanceFailureDetailsV1 }>;

export type ProjectScriptSelection = ActionOperationProjectScriptSelection;

export type PersonalProjectManifestRead =
  | Readonly<{ kind: 'ready'; definition: Extract<ProjectManifestEditorDefinition, { basis: { kind: 'personal' } }> }>
  | Readonly<{ kind: 'unavailable'; code: string }>;

/**
 * The one Project Action client: inspection, guarded manifest writes, script runs and setup
 * preparation all reach the existing Action approval/execution front door with the host-captured
 * Account and exact SOURCE checkout input; placement remains the canonical Action owner's
 * decision. An Ask-first approval keeps the call pending until its
 * mounted continuation delivers the approved result; it never becomes a fake success.
 */
export function createProjectManifestActionClient(
  input: Readonly<{
    workspace: ProjectDefinitionWorkspace;
    // Host-captured Workbench ownership, not a manifest field or caller-supplied Action authority.
    expectedAccountId: string;
    execute?: Execute;
    signal?: AbortSignal;
    /** The mounted surface presents the pending approval (Ask first) and its Details link. */
    onApprovalPending?: (approval: ActionApprovalRegistration) => void;
  }>,
) {
  const execute = input.execute ?? createFrontDoorActionExecute();
  const context = {
    surface: 'ui' as const,
    authority: 'present_user' as const,
    serverId: input.workspace.serverId,
    expectedAccountId: input.expectedAccountId,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const scope = {
    serverId: input.workspace.serverId,
    accountId: input.expectedAccountId,
  };

  async function invoke<T>(
    actionId:
      | 'projects.manifest.update'
      | 'projects.script.run'
      | 'projects.organization.update'
      | 'projects.setup.set'
      | 'projects.prepare'
      | 'artifact.create'
      | 'projects.sources.update'
      | typeof PROJECT_WORKTREE_PORTS_REASSIGN_ACTION_ID,
    actionInput: unknown,
    schema: core.$ZodType<T>,
    confirmation?: Readonly<{ confirmed: true }>,
  ): Promise<T> {
    const actionContext = { ...context, actionRequestId: randomUUID() };
    const outcome = await awaitActionApprovalResult<unknown, Outcome<T>>({
      execute: async (callbacks) => {
        const dispatch = confirmation?.confirmed ? execute.confirmed ?? execute : execute;
        const result = await dispatch(actionId, actionInput, actionContext);
        if (!result.ok) {
          // A typed D18 setup review keeps its safe review facts for the review surface.
          const consent = readProjectSetupConsentFailureV1(result);
          if (consent) throw Object.assign(new HappyError(consent.errorCode, false, { code: consent.errorCode }), { consent: consent.details });
          const worker = readProjectWorkerNoAcceptanceFailureV1(result);
          if (worker) throw Object.assign(new HappyError(worker.errorCode, false, { code: worker.errorCode }), { workerRefusal: worker.details });
          return { ok: false, code: result.errorCode };
        }
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(
          result.result,
        );
        if (approval.success) {
          input.onApprovalPending?.(
            createActionApprovalContinuation({
              artifactId: approval.data.artifactId,
              actionId,
              scope,
              expectedInput: actionInput,
              ...(input.signal ? { signal: input.signal } : {}),
              onSucceeded: callbacks.onApprovalSucceeded,
              onFailed: callbacks.onApprovalFailed,
            }),
          );
          return { approvalPending: true };
        }
        const parsed = safeParse(schema, result.result);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, code: 'invalid_action_output' };
      },
      succeeded: (value) => {
        const parsed = safeParse(schema, value);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, code: 'invalid_action_output' };
      },
      failed: (code, failure) => {
        const worker = readProjectWorkerNoAcceptanceFailureV1(failure);
        return { ok: false, code, ...(worker?.errorCode === code ? { workerRefusal: worker.details } : {}) };
      },
      aborted: () => ({ ok: false, code: 'cancelled' }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!outcome.ok)
      throw Object.assign(new HappyError(outcome.code, false, { code: outcome.code }), {
        ...(outcome.workerRefusal ? { workerRefusal: outcome.workerRefusal } : {}) });
    return outcome.value;
  }

  function setSetup(request: Omit<ProjectSetupSetInputV1, 'workspace'>) {
    return invoke('projects.setup.set', ProjectSetupSetInputV1Schema.parse({ ...request, workspace: input.workspace }), ProjectSetupSetOutputV1Schema);
  }

  return {
    /** Called after the surface's designed Choose new ports confirmation. */
    reassignWorktreePorts(confirmation: Readonly<{ confirmed: true }>) {
      return invoke(PROJECT_WORKTREE_PORTS_REASSIGN_ACTION_ID,
        ProjectWorktreePortsReassignInputSchema.parse({ workspace: input.workspace }), WorktreePortsResultV1Schema, confirmation);
    },
    /** The existing Artifact Action owns Account-mode encoding; Source update owns recipient preparation. */
    createSharedSetup(manifest: ProjectManifestV1, title: string) {
      return invoke('artifact.create', ArtifactActionInputSchemasV1['artifact.create'].parse({
        header: { kind: PROJECT_SETUP_ARTIFACT_KIND_V1, title },
        body: JSON.stringify(ProjectSharedSetupV1Schema.parse({ kind: PROJECT_SETUP_ARTIFACT_KIND_V1, manifest })),
      }), ArtifactActionOutputSchemasV1['artifact.create']);
    },
    attachSharedSetup(request: Readonly<{
      sourceId: string; expectedRevision: number;
      publication: ArtifactActionResultV1<'artifact.create'>;
      patch?: ProjectSourcePublicationPatchV1;
    }>) {
      return invoke('projects.sources.update', ProjectSourcesUpdateInputV1Schema.parse({
        serverId: input.workspace.serverId, sourceId: request.sourceId, expectedRevision: request.expectedRevision,
        patch: { ...request.patch, attachment: { kind: 'attach', attachment: {
          purpose: 'setup', ref: { kind: 'doc', serverId: input.workspace.serverId, artifactId: request.publication.artifactId },
          contentRevision: request.publication.revision,
        } } },
      }), ProjectSourcesUpdateOutputV1Schema);
    },
    /** Upstream is read only for the person's explicit update review. */
    async reviewSharedSetup(sourceId: string) {
      const result = await execute('projects.inspect', {
        workspace: input.workspace, read: { kind: 'editor' }, reviewSharedSetup: { sourceId },
      }, context);
      if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode });
      return ProjectDefinitionInspectOutputSchema.parse(result.result);
    },
    async inspect(read: ProjectDefinitionInspectRead = { kind: 'scripts' }) {
      const result = await execute(
        'projects.inspect',
        { workspace: input.workspace, read },
        context,
      );
      if (!result.ok)
        throw new HappyError(result.error, false, {
          code: result.errorCode,
        });
      return ProjectDefinitionInspectOutputSchema.parse(result.result);
    },
    /** Revalidates a held inspection: an unchanged current result comes back without its body. */
    async revalidate(read: ProjectDefinitionInspectRead, ifRevision: string) {
      const result = await execute(
        'projects.inspect',
        { workspace: input.workspace, read, ifRevision },
        context,
      );
      if (!result.ok)
        throw new HappyError(result.error, false, {
          code: result.errorCode,
        });
      return ProjectDefinitionInspectResultSchema.parse(result.result);
    },
    update(
      request: Readonly<{
        expectedBasis: ProjectManifestFileBasisV1;
        bytes: string;
      }>,
    ) {
      return invoke(
        'projects.manifest.update',
        {
          workspace: input.workspace,
          expectedBasis: request.expectedBasis,
          bytes: request.bytes,
        },
        ProjectManifestUpdateResultSchema,
      );
    },
    updateEnvironmentBinding(request: ProjectOrganizationUpdateInputV1) {
      return invoke('projects.organization.update', ProjectOrganizationUpdateInputV1Schema.parse(request), ProjectOrganizationUpdateOutputV1Schema);
    },
    /** Personal definitions and shared selections use the protected detail/CAS owner. */
    setSetup,
    /** The selected Account row points at protected detail; the accepted-record owner checks its exact revision. */
    async loadPersonalSetup(request: Readonly<{
      revision: ProjectSetupSetInputV1['expectedRevision']; organization: ProjectAccountOrganizationV1;
    }>): Promise<PersonalProjectManifestRead> {
      const setup = await readAcceptedProjectSetupV1({
        setupContent: request.organization.setupContent,
        setupSelection: request.organization.setupSelection,
        ...(input.signal ? { signal: input.signal } : {}),
        readArtifact: async artifactId => {
          const result = await execute('artifact.get', { artifactId }, context);
          if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode });
          return ArtifactActionOutputSchemasV1['artifact.get'].parse(result.result).artifact;
        },
      });
      if (setup.kind !== 'ready') return setup;
      return { kind: 'ready', definition: {
        basis: { kind: 'personal', revision: request.revision },
        document: setup.setupOverrides ? readProjectManifestDocument(JSON.stringify(setup.setupOverrides)) : null,
      } };
    },
    /** Row revisions stay row revisions; personal editing never calls the repository file writer. */
    async updatePersonalSetup(request: Readonly<{
      projectRef: ProjectSetupSetInputV1['projectRef']; expectedRevision: ProjectSetupSetInputV1['expectedRevision']; bytes: string;
    }>): Promise<PersonalProjectManifestEditorUpdateResult> {
      const document = readProjectManifestDocument(request.bytes);
      if (document.status !== 'valid') return { status: 'refused', code: 'invalid_manifest' };
      const result = await setSetup({ projectRef: request.projectRef, expectedRevision: request.expectedRevision,
        intent: { kind: 'personal', setupOverrides: document.manifest } });
      // A refused CAS retains the draft and its old basis until an actual current detail is received.
      if (!result.ok) return { status: 'refused', code: result.errorCode };
      return { status: 'saved', basis: { kind: 'personal', revision: result.revision }, document };
    },
    runScript(selection: ProjectScriptSelection, choice?: ProjectExecutionChoiceV1) {
      const actionInput = PROJECT_ACTION_INPUT_SCHEMAS_V1[
        'projects.script.run'
      ].parse({ workspace: input.workspace, selection, ...(choice ? { choice } : {}) });
      return invoke(
        'projects.script.run',
        actionInput,
        PROJECT_ACTION_OUTPUT_SCHEMAS_V1['projects.script.run'],
      );
    },
    prepare(
      request: Readonly<Omit<ProjectPrepareInputV1, 'workspace'>>,
    ) {
      const actionInput = PROJECT_ACTION_INPUT_SCHEMAS_V1[
        'projects.prepare'
      ].parse({ workspace: input.workspace, ...request });
      return invoke(
        'projects.prepare',
        actionInput,
        PROJECT_ACTION_OUTPUT_SCHEMAS_V1['projects.prepare'],
      );
    },
  };
}

export type ProjectManifestActionClient = ReturnType<
  typeof createProjectManifestActionClient
>;
