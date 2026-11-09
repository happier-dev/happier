import {
  ProjectDefinitionInspectOutputSchema,
  ProjectDefinitionInspectResultSchema,
  type ProjectDefinitionWorkspace,
  type ProjectDefinitionInspectRead,
} from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import {
  readProjectSetupConsentFailureV1,
  readProjectWorkerNoAcceptanceFailureV1,
  PROJECT_ACTION_INPUT_SCHEMAS_V1,
  PROJECT_ACTION_OUTPUT_SCHEMAS_V1,
  type ProjectPrepareInputV1,
  type ProjectWorkerNoAcceptanceFailureDetailsV1,
} from '@happier-dev/protocol/actions/projectActionFamily';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectOrganizationUpdateInputV1Schema, ProjectOrganizationUpdateOutputV1Schema,
  type ProjectOrganizationUpdateInputV1 } from '@happier-dev/protocol/projects/projectOrganizationV1';
import {
  ProjectManifestUpdateResultSchema,
  type ProjectManifestFileBasisV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
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

type Execute = (
  actionId: 'projects.inspect' | 'projects.manifest.update' | 'projects.script.run' | 'projects.prepare' | 'projects.organization.update',
  input: unknown,
  context?: Parameters<ReturnType<typeof createFrontDoorActionExecute>>[2],
) => ReturnType<ReturnType<typeof createFrontDoorActionExecute>>;
type Outcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: string; workerRefusal?: ProjectWorkerNoAcceptanceFailureDetailsV1 }>;

export type ProjectScriptSelection = ActionOperationProjectScriptSelection;

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
      | 'projects.prepare',
    actionInput: unknown,
    schema: core.$ZodType<T>,
  ): Promise<T> {
    const actionContext = { ...context, actionRequestId: randomUUID() };
    const outcome = await awaitActionApprovalResult<unknown, Outcome<T>>({
      execute: async (callbacks) => {
        const result = await execute(actionId, actionInput, actionContext);
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

  return {
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
