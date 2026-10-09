import {
  ProjectDefinitionInspectOutputSchema,
  type ProjectDefinitionWorkspace,
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
import {
  ProjectManifestUpdateResultSchema,
  type ProjectManifestFileBasisV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { ActionOperationProjectScriptSelection } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import type { z } from 'zod';

import {
  awaitActionApprovalResult,
  createActionApprovalContinuation,
  type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

type Execute = ReturnType<typeof createFrontDoorActionExecute>;
type Outcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: string; workerRefusal?: ProjectWorkerNoAcceptanceFailureDetailsV1 }>;

export type ProjectScriptSelection = ActionOperationProjectScriptSelection;

/**
 * The one Project Action client: inspection, guarded manifest writes, script runs and setup
 * preparation all reach the existing Action approval/execution front door with the host-captured
 * Account and exact checkout Machine. An Ask-first approval keeps the call pending until its
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
    externalActionTarget: {
      kind: 'machine' as const,
      machineId: input.workspace.machineId,
    },
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
      | 'projects.prepare',
    actionInput: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const outcome = await awaitActionApprovalResult<unknown, Outcome<T>>({
      execute: async (callbacks) => {
        const result = await execute(actionId, actionInput, context);
        if (!result.ok) {
          // A typed D18 setup review keeps its safe review facts for the review surface.
          const consent = readProjectSetupConsentFailureV1(result);
          if (consent) throw Object.assign(new Error(consent.errorCode), { code: consent.errorCode, consent: consent.details });
          const worker = readProjectWorkerNoAcceptanceFailureV1(result);
          if (worker) throw Object.assign(new Error(worker.errorCode), { code: worker.errorCode, workerRefusal: worker.details });
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
        const parsed = schema.safeParse(result.result);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, code: 'invalid_action_output' };
      },
      succeeded: (value) => {
        const parsed = schema.safeParse(value);
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
      throw Object.assign(new Error(outcome.code), { code: outcome.code,
        ...(outcome.workerRefusal ? { workerRefusal: outcome.workerRefusal } : {}) });
    return outcome.value;
  }

  return {
    async inspect() {
      const result = await execute(
        'projects.inspect',
        { workspace: input.workspace },
        context,
      );
      if (!result.ok)
        throw Object.assign(new Error(result.error), {
          code: result.errorCode,
        });
      return ProjectDefinitionInspectOutputSchema.parse(result.result);
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
        ProjectManifestUpdateResultSchema as unknown as z.ZodType<
          z.infer<typeof ProjectManifestUpdateResultSchema>
        >,
      );
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
