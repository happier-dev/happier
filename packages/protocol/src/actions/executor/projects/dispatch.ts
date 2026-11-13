import { createProjectFromStarter } from './starters.js';
import { PROJECT_STARTER_CREATE_ACTION_ID_V1 } from '../../specs/projectStartersActionIdsV1.js';
import { isWorkspaceActionId } from '../../workspaceActionFamily.js';
import { completeActionResult } from '../resultProjection.js';
import { isProjectActionIdV1 } from '../../projectActionIdsV1.js';
import { isProjectDefinitionActionId } from '../../projectDefinitionActionFamily.js';
import type { ProjectContextUpdateInputV1Schema } from '../../../projects/projectContextV1.js';
import { OpenProjectResultV1Schema, type OpenProjectInputV1Schema } from '../../../projects/openProjectV1.js';
import { prepareApprovalRequest } from '../approvalPreparation.js';
import { computeActionReviewDigestV1 } from '../../decisionAuthority.js';
import { isPresentUserHostInvocation, isHomeAdmittedPresentUserHostInvocation } from '../../invocationAuthority.js';
import { projectNativeJsonValueForTransport } from '../../../json/strictJsonValue.js';
import { isRpcError, readRpcErrorCode, RPC_ERROR_CODES } from '../../../rpc/errors.js';
import { isPluginError } from '../../../plugins/errors.js';
import { type ProjectOrganizationUpdateInputV1Schema, ProjectOrganizationUpdateOutputV1Schema } from '../../../projects/projectOrganizationV1.js';
import type { ProjectSourcesCreateInputV1Schema, ProjectSourcesUpdateInputV1Schema } from '../../../projects/sources/projectSourceV1.js';
import { type ActionId } from '../../actionIds.js';
import type { ActionExecuteResult, ActionExecutorContext, AdmittedClientActionContext } from '../types.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecutorDeps } from '../types.js';
import { clientActionUnavailable } from '../../clientDispatchV1.js';
import type { z } from '../../../zodRuntimePolicy.js';
import { getActionSpec, resolveActionExecutionPlacementForInput, type AdmittedActionInputById } from '../../actionSpecs.js';
import type { ProjectWorkspaceUpdateInputV1Schema, ProjectWorkspaceForgetInputV1Schema } from '../../../projects/projectWorkspaceActionsV1.js';



export async function dispatchProjectsDispatch1(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'parsed' | 'ctx'> & Readonly<{
  admittedClientContext: AdmittedClientActionContext | undefined;
  executeHostChild: (childId: ActionId, childInput: unknown, childContext: ActionExecutorContext) => Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, parsed, ctx, executeHostChild } = inv;
  if (actionId === PROJECT_STARTER_CREATE_ACTION_ID_V1) {
    const input = parsed.data as AdmittedActionInputById[typeof PROJECT_STARTER_CREATE_ACTION_ID_V1];
    return createProjectFromStarter(input, (childId, childInput) => executeHostChild(childId, childInput,
      resolveActionExecutionPlacementForInput(getActionSpec(childId), childInput) === 'machine'
        ? { ...ctx, serverId: input.serverId, externalActionTarget: { kind: 'machine', machineId: input.machineId } }
        : ctx));
  }

        if (isWorkspaceActionId(actionId)) {
          if (!deps.workspaceAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          if (!inv.admittedClientContext) return { ok: false, errorCode: 'action_disabled', error: 'action_disabled' };
          return completeActionResult(await deps.workspaceAction({ actionId, input: parsed.data, context: inv.admittedClientContext,
            ...(ctx.signal ? { signal: ctx.signal } : {}) }));
        }

        if (actionId === 'projects.pages.list') {
          if (!deps.projectsPagesList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const input = parsed.data as AdmittedActionInputById['projects.pages.list'];
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
          return { ok: true, result: await deps.projectsContextUpdate(data as z.infer<typeof ProjectContextUpdateInputV1Schema>, ctx) };
        }

        if (actionId === 'projects.open') {
          if (!deps.projectsOpen) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.open' };
          const input = data as z.infer<typeof OpenProjectInputV1Schema>;
          if (ctx.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
          try {
            const result = await deps.projectsOpen(input, ctx);
            const opened = OpenProjectResultV1Schema.safeParse(result);
            if (opened.success && opened.data.kind === 'refused'
              && opened.data.code === 'workspace_private_checkout_review_required' && opened.data.effectAttempted === false
              && opened.data.destinationReview && input.materialization.kind === 'clone' && ctx.surface === 'ui'
              && (isPresentUserHostInvocation(ctx) || isHomeAdmittedPresentUserHostInvocation(ctx, actionId))) {
              const destination = opened.data.destinationReview;
              const reviewedInput = { ...input, materialization: { ...input.materialization,
                destinationParentPath: destination.destinationParentPath, destinationDirectoryName: destination.destinationDirectoryName } };
              // The native owner supplies only its requester's prepared destination. Reuse the same
              // approval builder and digest that the receiving executor checks on the new invocation.
              const review = await prepareApprovalRequest({ deps, actionId, input: reviewedInput, actionArgs: reviewedInput, context: ctx });
              if (review && 'ok' in review) return review;
              if (review) return { ok: false, errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required',
                details: { review: projectNativeJsonValueForTransport(review), reviewDigest: computeActionReviewDigestV1(actionId, review) } };
            }
            return completeActionResult(result);
          } catch (error) {
            const code = readRpcErrorCode(error);
            // These acknowledgements prove refusal before the handler can execute.
            // Transport loss, cancellation after dispatch and malformed acceptance do not.
            if (code === RPC_ERROR_CODES.METHOD_NOT_FOUND || code === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
              || code === RPC_ERROR_CODES.UPDATE_REQUIRED || code === RPC_ERROR_CODES.FORBIDDEN) {
              const failureCause = isPluginError(error) ? error.data.failureCause : isRpcError(error) ? error.failureCause : undefined;
              return completeActionResult({ kind: 'refused', code, ...(failureCause ? { failureCause } : {}) });
            }
            return completeActionResult({ kind: 'outcomeUnknown' });
          }
        }

        if (actionId === 'projects.visibility.set') {
          if (!deps.projectsVisibilitySet) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.visibility.set' };
          return completeActionResult(await deps.projectsVisibilitySet(data as AdmittedActionInputById['projects.visibility.set'], ctx));
        }

        if (actionId === 'projects.organization.update') {
          if (!deps.projectsOrganizationUpdate) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.organization.update' };
          // Domain conflicts retain their observed revision; thrown failures still use the Action envelope.
          return { ok: true, result: ProjectOrganizationUpdateOutputV1Schema.parse(
            await deps.projectsOrganizationUpdate(data as z.infer<typeof ProjectOrganizationUpdateInputV1Schema>, ctx)) };
        }

        if (actionId === 'projects.workspace.update') {
          if (!deps.projectsWorkspaceUpdate) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.workspace.update' };
          const { ProjectWorkspaceUpdateOutputV1Schema } = await import('../../../projects/projectWorkspaceActionsV1.js');
          const input = data as z.infer<typeof ProjectWorkspaceUpdateInputV1Schema>;
          return completeActionResult(ProjectWorkspaceUpdateOutputV1Schema.parse(await deps.projectsWorkspaceUpdate(input, ctx)));
        }

        if (actionId === 'projects.workspace.forget') {
          if (!deps.projectsWorkspaceForget) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.workspace.forget' };
          const { ProjectWorkspaceForgetOutputV1Schema } = await import('../../../projects/projectWorkspaceActionsV1.js');
          const input = data as z.infer<typeof ProjectWorkspaceForgetInputV1Schema>;
          return completeActionResult(ProjectWorkspaceForgetOutputV1Schema.parse(await deps.projectsWorkspaceForget(input, ctx)));
        }

        if (actionId === 'projects.list') {
          const projectsList = deps.projectsList;
          if (!projectsList) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:projects.list' };
          }
          const res = await projectsList(data as AdmittedActionInputById['projects.list'], ctx);
          return completeActionResult(res);
        }
  return null;
}

export async function dispatchProjectsDispatch3(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'data' | 'ctx'>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, data, ctx } = inv;
        if (actionId === 'projects.sources.moveToTeam') {
          if (!deps.projectSourcesMoveToTeam) return clientActionUnavailable(actionId);
          return completeActionResult(await deps.projectSourcesMoveToTeam(data as AdmittedActionInputById['projects.sources.moveToTeam'], ctx));
        }
        if (actionId === 'projects.sources.list') {
          if (!deps.projectSourcesList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.projectSourcesList(data as AdmittedActionInputById['projects.sources.list'], ctx);
          return 'errorCode' in result ? result : { ok: true, result };
        }
        if (actionId === 'projects.sources.read') {
          if (!deps.projectSourcesRead) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.projectSourcesRead(data as AdmittedActionInputById['projects.sources.read'], ctx);
          return 'errorCode' in result ? result : { ok: true, result };
        }
        if (actionId === 'projects.sources.create') {
          if (!deps.projectSourcesCreate) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.projectSourcesCreate(data as z.infer<typeof ProjectSourcesCreateInputV1Schema>, ctx);
          return 'errorCode' in result ? result : { ok: true, result };
        }
        if (actionId === 'projects.sources.update') {
          if (!deps.projectSourcesUpdate) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.projectSourcesUpdate(data as z.infer<typeof ProjectSourcesUpdateInputV1Schema>, ctx);
          return 'errorCode' in result ? result : { ok: true, result };
        }
        if (actionId === 'projects.sources.delete') {
          if (!deps.projectSourcesDelete) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const result = await deps.projectSourcesDelete(data as AdmittedActionInputById['projects.sources.delete'], ctx);
          return 'errorCode' in result ? result : { ok: true, result };
        }
  return null;
}
