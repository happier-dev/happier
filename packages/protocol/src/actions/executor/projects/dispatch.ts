import { isWorkspaceActionId } from '../../workspaceActionFamily.js';
import { completeActionResult } from '../resultProjection.js';
import { ProjectPagesListInputV1Schema } from '../../projectActionFamily.js';
import { isProjectActionIdV1 } from '../../projectActionIdsV1.js';
import { isProjectDefinitionActionId } from '../../projectDefinitionActionFamily.js';
import { ProjectContextUpdateInputV1Schema } from '../../../projects/projectContextV1.js';
import { OpenProjectInputV1Schema, OpenProjectResultV1Schema } from '../../../projects/openProjectV1.js';
import { ActionApprovalRequestCreatedResultSchema } from '../../actionExecutionResult.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import { readRecord } from '../../../inputs/inputRecords.js';
import { readRpcErrorCode, RPC_ERROR_CODES } from '../../../rpc/errors.js';
import { ProjectOrganizationUpdateInputV1Schema, ProjectOrganizationUpdateOutputV1Schema } from '../../../projects/projectOrganizationV1.js';
import { ProjectSourcesListInputV1Schema, ProjectSourcesReadInputV1Schema, ProjectSourcesCreateInputV1Schema, ProjectSourcesUpdateInputV1Schema, ProjectSourcesDeleteInputV1Schema } from '../../../projects/sources/projectSourceV1.js';
import { type ActionId } from '../../actionIds.js';
import type { ActionExecuteResult, ActionExecutorContext } from '../types.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecutorDeps } from '../types.js';
import { ProjectSourcesMoveToTeamInputV1Schema } from '../../../projects/sources/projectSourceV1.js';
import { clientActionUnavailable } from '../../clientDispatchV1.js';



export async function dispatchProjectsDispatch1(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'parsed' | 'ctx'> & Readonly<{
  executeHostChild: (childId: ActionId, childInput: unknown, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, parsed, ctx, executeHostChild } = inv;

        if (isWorkspaceActionId(actionId)) {
          if (!deps.workspaceAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          return completeActionResult(await deps.workspaceAction({ actionId, input: parsed.data, ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'projects.pages.list') {
          if (!deps.projectsPagesList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const input = ProjectPagesListInputV1Schema.parse(parsed.data);
          return completeActionResult(await deps.projectsPagesList(input, ctx));
        }

        if (isProjectActionIdV1(actionId)) {
          if (!deps.projectAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          return completeActionResult(await deps.projectAction({ actionId, input: parsed.data, context: ctx,
            // Like SCM's source reads, placement consumes this same admitted
            // frontdoor and host context without lending a new target grant.
            executeCanonicalAction: (nestedActionId, nestedInput) => executeHostChild(nestedActionId, nestedInput, ctx),
          }));
        }

        if (isProjectDefinitionActionId(actionId)) {
          if (!deps.projectDefinitionAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          return completeActionResult(await deps.projectDefinitionAction({ actionId, input: parsed.data, context: ctx }));
        }
  return null;
}

export async function dispatchProjectsDispatch2(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'data' | 'ctx'>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, data, ctx } = inv;

        if (actionId === 'paths.list_recent') {
          if (!deps.pathsListRecent) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const res = await deps.pathsListRecent({
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
          });
          return completeActionResult(res);
        }

        if (actionId === 'projects.context.update') {
          if (!deps.projectsContextUpdate) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.context.update' };
          // The domain conflict carries the row revision required for the editor's next submission.
          return { ok: true, result: await deps.projectsContextUpdate(ProjectContextUpdateInputV1Schema.parse(data), ctx) };
        }

        if (actionId === 'projects.open') {
          if (!deps.projectsOpen) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.open' };
          const input = OpenProjectInputV1Schema.parse(data);
          if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
          try {
            const result = await deps.projectsOpen(input, ctx);
            const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result);
            if (approval.success && approval.data.actionId === actionId) return completeActionResult(approval.data);
            const failure = readActionFailureEnvelope(result);
            if (failure) {
              if (failure.errorCode === 'outcome_unknown' || failure.errorCode === 'invalid_action_output'
                || failure.errorCode === 'result_too_large') {
                // A lost or unrepresentable effect receipt is not a no-effect
                // refusal. Keep only validated evidence from the bound settlement.
                const operationId = readRecord(failure.details).operationId;
                const unknown = OpenProjectResultV1Schema.safeParse({ kind: 'outcomeUnknown',
                  ...(operationId === undefined ? {} : { operationId }) });
                return completeActionResult(unknown.success ? unknown.data : { kind: 'outcomeUnknown' });
              }
              return failure;
            }
            return completeActionResult(OpenProjectResultV1Schema.parse(result));
          } catch (error) {
            const code = readRpcErrorCode(error);
            // These acknowledgements prove refusal before the handler can execute.
            // Transport loss, cancellation after dispatch and malformed acceptance do not.
            if (code === RPC_ERROR_CODES.METHOD_NOT_FOUND || code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
              || code === RPC_ERROR_CODES.UPDATE_REQUIRED || code === RPC_ERROR_CODES.FORBIDDEN) {
              return completeActionResult({ kind: 'refused', code });
            }
            return completeActionResult({ kind: 'outcomeUnknown' });
          }
        }

        if (actionId === 'projects.visibility.set') {
          if (!deps.projectsVisibilitySet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.visibility.set' };
          const { ProjectVisibilitySetInputV1Schema } = await import('../../../projects/projectVisibilityV1.js');
          return completeActionResult(await deps.projectsVisibilitySet(ProjectVisibilitySetInputV1Schema.parse(data), ctx));
        }

        if (actionId === 'projects.organization.update') {
          if (!deps.projectsOrganizationUpdate) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.organization.update' };
          // Domain conflicts retain their observed revision; thrown failures still use the Action envelope.
          return { ok: true, result: ProjectOrganizationUpdateOutputV1Schema.parse(
            await deps.projectsOrganizationUpdate(ProjectOrganizationUpdateInputV1Schema.parse(data), ctx)) };
        }

        if (actionId === 'projects.workspace.update') {
          if (!deps.projectsWorkspaceUpdate) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.workspace.update' };
          const { ProjectWorkspaceUpdateInputV1Schema, ProjectWorkspaceUpdateOutputV1Schema } = await import('../../../projects/projectWorkspaceActionsV1.js');
          const input = ProjectWorkspaceUpdateInputV1Schema.parse(data);
          return completeActionResult(ProjectWorkspaceUpdateOutputV1Schema.parse(await deps.projectsWorkspaceUpdate(input, ctx)));
        }

        if (actionId === 'projects.workspace.forget') {
          if (!deps.projectsWorkspaceForget) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.workspace.forget' };
          const { ProjectWorkspaceForgetInputV1Schema, ProjectWorkspaceForgetOutputV1Schema } = await import('../../../projects/projectWorkspaceActionsV1.js');
          const input = ProjectWorkspaceForgetInputV1Schema.parse(data);
          return completeActionResult(ProjectWorkspaceForgetOutputV1Schema.parse(await deps.projectsWorkspaceForget(input, ctx)));
        }

        if (actionId === 'projects.list') {
          const projectsList = deps.projectsList;
          if (!projectsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.list' };
          }
          const res = await projectsList({
            ...(typeof data.serverId === 'string' ? { serverId: data.serverId } : {}),
            ...((data.machineId) ? { machineId: String(data.machineId) } : {}),
            ...(typeof data.limit === 'number' ? { limit: data.limit } : {}),
            ...(typeof data.includeHidden === 'boolean' ? { includeHidden: data.includeHidden } : {}),
          }, ctx);
          return completeActionResult(res);
        }
  return null;
}

export async function dispatchProjectsDispatch3(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'data' | 'ctx'>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, data, ctx } = inv;
        if (actionId === 'projects.sources.moveToTeam') {
          if (!deps.projectSourcesMoveToTeam) return clientActionUnavailable(actionId);
          return completeActionResult(await deps.projectSourcesMoveToTeam(ProjectSourcesMoveToTeamInputV1Schema.parse(data), ctx));
        }
        if (actionId === 'projects.sources.list') {
          if (!deps.projectSourcesList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.projectSourcesList(ProjectSourcesListInputV1Schema.parse(data), ctx);
          return 'errorCode' in result ? result : { ok: true, result };
        }
        if (actionId === 'projects.sources.read') {
          if (!deps.projectSourcesRead) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.projectSourcesRead(ProjectSourcesReadInputV1Schema.parse(data), ctx);
          return 'errorCode' in result ? result : { ok: true, result };
        }
        if (actionId === 'projects.sources.create') {
          if (!deps.projectSourcesCreate) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.projectSourcesCreate(ProjectSourcesCreateInputV1Schema.parse(data), ctx);
          return 'errorCode' in result ? result : { ok: true, result };
        }
        if (actionId === 'projects.sources.update') {
          if (!deps.projectSourcesUpdate) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.projectSourcesUpdate(ProjectSourcesUpdateInputV1Schema.parse(data), ctx);
          return 'errorCode' in result ? result : { ok: true, result };
        }
        if (actionId === 'projects.sources.delete') {
          if (!deps.projectSourcesDelete) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.projectSourcesDelete(ProjectSourcesDeleteInputV1Schema.parse(data), ctx);
          return 'errorCode' in result ? result : { ok: true, result };
        }
  return null;
}
