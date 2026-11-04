import { resolveExecutionRunScope, withoutExecutionRunScope, resolveServerIdForExecutionRunScope } from '../sessionScope.js';
import { resolveExecutionRunLaunchOrigin, buildExecutionRunCallOptions, checkDetachedExecutionRunProtocolV2, readFanoutStartError, readCompleteExecutionRunStartIdentity, hasExecutionRunStartIdentityEvidence, classifyExecutionRunStartFailure, parseExecutionRunWaitResult, isExecutionRunWaitCancellation } from '../executionRuns.js';
import { resolveRunStartModelAndConfig } from '../agentStartAdmission.js';
import { normalizeConnectedServiceSelectionInput } from '../../../connect/normalizeConnectedServiceSelectionInput.js';
import { actionInputIssueFailure } from '../actionInputValidation.js';
import { createPermissionPolicyResult, resolveAgentExecutionRunPermission, bindAgentExistingExecutionRunAuthority } from '../callerContext.js';
import { EXECUTION_RUN_ACTION_PERMISSION_MODES } from '../../executionRunActionPermissionMode.js';
import { normalizeActionExecutorThrownError, completeActionResult, completeExecutionRunServiceActionResult } from '../resultProjection.js';
import { readFailureEnvelopeDetails } from '../actionFailureEnvelope.js';
import { readRecord } from '../../../inputs/inputRecords.js';
import { readExecutionRunStartRunCreation, ExecutionRunStartResponseSchema, ExecutionRunWaitResultSchema, ExecutionRunGetResponseSchema, withExecutionRunStartFailureDetails } from '../../../execution/runs/responseSchemas.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';
import { DetachedExecutionRunSendInputSchema, ExecutionRunPermissionRespondInputSchema } from '../../actionSpecs.js';
import type { ExecutionRunCallOptions } from '../executionRuns.js';
import { normalizeId } from '../inputReading.js';
import { ExecutionRunCancelTurnRequestSchema } from '../../../execution/runs/cancelTurn.js';
import { ExecutionRunWaitConditionSchema } from '../../../execution/runs/waitForTerminal.js';
import type { DispatchFacts } from '../coreInvocation.js';
import type { CoreInvocation, PreparedCoreAdmission } from '../coreInvocation.js';



export async function dispatchRunsDispatch1(inv: Pick<CoreInvocation, 'actionId' | 'parsed' | 'ctx' | 'deps' | 'data'> & Readonly<{
  dispatchFacts: DispatchFacts;
  startExecutionRunWithSelection: (sessionId: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[0], input: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[1], opts: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[2], context: ActionExecutorContext) => ReturnType<NonNullable<ActionExecutorDeps['executionRunStart']>>;
}>): Promise<ActionExecuteResult | null> {
  const { actionId, parsed, ctx, deps, data, dispatchFacts, startExecutionRunWithSelection } = inv;

        if (actionId === 'execution.run.start') {
          const waitForCompletion = data.waitForCompletion === true ? deps.executionRunWait : undefined;
          if (data.waitForCompletion === true && !waitForCompletion) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            ctx.executionRunTargetMachineId,
            sessionId === null ? ctx.executionRunPermissionRequestStore : undefined,
            sessionId === null ? ctx.executionRunWorkflowObservationSink : undefined,
            ctx,
          );
          const exactInputResults = data.localInputId !== undefined || data.resultContract !== undefined;
          const runScopedAgentBindings = data.roleId !== undefined || data.launchProfileId !== undefined
            || data.teamCredentialModel !== undefined || (
            data.intent === 'agent' && (
              data.cwd !== undefined
              || data.capabilitySelection !== undefined
              || data.modelId !== undefined
              || data.modelSelection !== undefined
              || data.sessionConfigOptionOverrides !== undefined
              || data.connectedServices !== undefined
            )
          );
          const secretReferenceOverlay = data.secretReferenceOverlay !== undefined;
          const needsProtocolV2 = sessionId === null
            || data.waitForCompletion === true
            || data.waitTimeoutSeconds !== undefined
            || exactInputResults
            || runScopedAgentBindings
            || secretReferenceOverlay;
          let dispatchOpts = opts;
          if (needsProtocolV2) {
            const capability = await checkDetachedExecutionRunProtocolV2(
              deps,
              sessionId,
              opts,
              {
                startAndWait: data.waitForCompletion === true || data.waitTimeoutSeconds !== undefined,
                exactInputResults,
                runScopedAgentBindings,
                secretReferenceOverlay,
              },
            );
            if (!capability.ok) {
              return classifyExecutionRunStartFailure(capability, 'noRunCreated');
            }
            dispatchOpts = capability.opts;
          }

          const runOptions = resolveRunStartModelAndConfig(data);
          if (!runOptions.ok) {
            return classifyExecutionRunStartFailure(
              runOptions.error,
              'noRunCreated',
            );
          }
          const request: Record<string, unknown> = { ...data };
          delete request.sessionId;
          delete request.waitForCompletion;
          delete request.waitTimeoutSeconds;
          // The `configOptions` shorthand is merged into the canonical `sessionConfigOptionOverrides`
          // above; never forward it as a second vocabulary on the run request.
          delete request.configOptions;
          request.launchOrigin = resolveExecutionRunLaunchOrigin(ctx);
          if (runOptions.options.modelId) {
            request.modelId = runOptions.options.modelId;
          } else {
            delete request.modelId;
          }
          if (runOptions.options.sessionConfigOptionOverrides) {
            request.sessionConfigOptionOverrides = runOptions.options.sessionConfigOptionOverrides;
          } else {
            delete request.sessionConfigOptionOverrides;
          }
          // Normalize the agent-friendly connected-services selection at the ONE boundary; malformed
          // input fails closed with invalid_parameters (the run is never started on a bad selection).
          if (request.connectedServices !== undefined) {
            const normalized = normalizeConnectedServiceSelectionInput(request.connectedServices);
            if (!normalized.ok) {
              return classifyExecutionRunStartFailure(
                actionInputIssueFailure({ code: 'invalid_selection', path: ['connectedServices'] }),
                'noRunCreated',
              );
            }
            request.connectedServices = normalized.bindings;
            // Preserve bare per-service defaults (RO-F5) alongside explicit pins; the run-start owner
            // resolves each named service's stored default and merges it UNDER explicit selections.
            if (normalized.defaultServiceIds.length > 0) {
              request.connectedServicesDefaultServiceIds = normalized.defaultServiceIds;
            } else {
              delete request.connectedServicesDefaultServiceIds;
            }
          }
          const executionRunPermission = resolveAgentExecutionRunPermission(
            ctx,
            request.permissionMode,
            EXECUTION_RUN_ACTION_PERMISSION_MODES,
          );
          if (!executionRunPermission.ok) {
            return classifyExecutionRunStartFailure(executionRunPermission.error, 'noRunCreated');
          }
          const permissionDecision = executionRunPermission.permissionDecision;
          if (permissionDecision?.ok === false) {
            return classifyExecutionRunStartFailure(
              createPermissionPolicyResult(ctx, permissionDecision),
              'noRunCreated',
            );
          }
          if (permissionDecision?.ok === true) {
            request.permissionMode = permissionDecision.requestedMode;
          }
          if (executionRunPermission.causalPermissionAuthority) {
            dispatchOpts = {
              ...(dispatchOpts ?? {}),
              causalPermissionAuthority: executionRunPermission.causalPermissionAuthority,
            };
          }
          let rawStartResult: unknown;
          if (ctx.agentStartWorkDepth !== undefined) dispatchOpts = { ...dispatchOpts, workDepth: ctx.agentStartWorkDepth, agentStartContext: ctx.agentStartContext, workspaceWrites: ctx.agentStartWorkspaceWrites, sessionAgentSpawnPolicyV1: ctx.sessionAgentSpawnPolicyV1 };
          try {
            dispatchFacts.executionRunStartDispatched = true;
            rawStartResult = await startExecutionRunWithSelection(sessionId, request, dispatchOpts, ctx);
          } catch (error) {
            const failure = normalizeActionExecutorThrownError(error);
            const details = readFailureEnvelopeDetails(readRecord(error));
            return classifyExecutionRunStartFailure(
              { ok: false, errorCode: failure.errorCode, error: failure.error, ...(details !== undefined ? { details } : {}) },
              readExecutionRunStartRunCreation(details),
              error,
            );
          }
          const returnedIdentity = readCompleteExecutionRunStartIdentity(rawStartResult);
          const startResult: ActionExecuteResult = returnedIdentity
            ? { ok: true, result: returnedIdentity }
            : completeExecutionRunServiceActionResult(actionId, rawStartResult);
          if (!startResult.ok) {
            return classifyExecutionRunStartFailure(
              startResult,
              hasExecutionRunStartIdentityEvidence(rawStartResult)
                ? 'outcomeUnknown'
                : readExecutionRunStartRunCreation(startResult.details),
            );
          }
          const res = startResult.result;
          const serviceFailure = readRecord(res);
          if (serviceFailure.ok === false) {
            const failure = readFanoutStartError(res);
            const details = readFailureEnvelopeDetails(serviceFailure);
            return {
              ok: false,
              errorCode: failure.errorCode ?? 'execution_run_failed',
              error: failure.error,
              details: withExecutionRunStartFailureDetails(
                details,
                hasExecutionRunStartIdentityEvidence(rawStartResult)
                  ? 'outcomeUnknown'
                  : readExecutionRunStartRunCreation(details),
              ),
            };
          }
          const parsedStartResponse = ExecutionRunStartResponseSchema.safeParse(res);
          if (!parsedStartResponse.success) {
            return classifyExecutionRunStartFailure(
              {
                ok: false,
                errorCode: 'execution_run_failed',
                error: 'execution_run_invalid_response',
              },
              'outcomeUnknown',
            );
          }
          const admittedStartResult: ActionExecuteResult = {
            ok: true,
            result: parsedStartResponse.data,
          };
          if (!waitForCompletion) return admittedStartResult;

          const runId = parsedStartResponse.data.runId;
          // The waiter is a client concern: compose the existing scoped waiter
          // after a successful start without turning caller cancellation into a
          // run stop. A typed timeout remains nested under the accepted run.
          try {
            const rawWait = await waitForCompletion(sessionId, {
              runId,
              ...(typeof data.waitTimeoutSeconds === 'number'
                ? { timeoutSeconds: data.waitTimeoutSeconds }
                : {}),
            }, dispatchOpts);
            const wait = parseExecutionRunWaitResult(rawWait);
            if (!wait.success) {
              return {
                ok: true,
                result: ExecutionRunStartResponseSchema.parse({
                  ...parsedStartResponse.data,
                  wait: { ok: false, code: 'execution_run_failed' },
                }),
              };
            }
            return {
              ok: true,
              result: ExecutionRunStartResponseSchema.parse({ ...parsedStartResponse.data, wait: wait.data }),
            };
          } catch (error) {
            return {
              ok: true,
              result: ExecutionRunStartResponseSchema.parse({
                ...parsedStartResponse.data,
                wait: isExecutionRunWaitCancellation(error, ctx.signal)
                  ? { ok: false, code: 'cancelled' }
                  : { ok: false, code: 'execution_run_failed' },
              }),
            };
          }
        }

        if (actionId === 'execution.run.list') {
          if (!deps.executionRunList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            undefined,
            undefined,
            ctx,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunList(sessionId, withoutExecutionRunScope(parsed.data), capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.get') {
          if (!deps.executionRunGet) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            sessionId === null ? ctx.executionRunPermissionRequestStore : undefined,
            undefined,
            ctx,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunGet(sessionId, {
            runId: data.runId,
            includeStructured: data.includeStructured === true,
            ...(typeof data.includeLatestToolResult === 'boolean' ? { includeLatestToolResult: data.includeLatestToolResult } : {}),
            ...(data.waitForInputId ? { waitForInputId: data.waitForInputId } : {}),
            ...(data.waitForOutput ? { waitForOutput: data.waitForOutput } : {}),
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.send') {
          if (!deps.detachedExecutionRunSend) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const detachedInput = DetachedExecutionRunSendInputSchema.parse(parsed.data);
          const sessionId = detachedInput.sessionId;
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            sessionId === null ? ctx.executionRunPermissionRequestStore : undefined,
            sessionId === null ? ctx.executionRunWorkflowObservationSink : undefined,
            ctx,
          );
          const authority = bindAgentExistingExecutionRunAuthority(ctx, opts);
          if (!authority.ok) return authority.error;
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, authority.opts, {
            startAndWait: false,
            exactInputResults: detachedInput.localInputId !== undefined || detachedInput.resultContract !== undefined,
            secretReferenceOverlay: false,
          });
          if (!capability.ok) return capability;
          const res = await deps.detachedExecutionRunSend(sessionId, {
            runId: detachedInput.runId,
            message: detachedInput.message,
            delivery: detachedInput.delivery === 'prompt' || detachedInput.delivery === 'interrupt'
              ? detachedInput.delivery
              : 'steer_if_supported',
            ...(detachedInput.resume === true ? { resume: true } : {}),
            ...(detachedInput.localInputId ? { localInputId: detachedInput.localInputId } : {}),
            ...(detachedInput.resultContract ? { resultContract: detachedInput.resultContract } : {}),
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.ensure') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          if (!deps.executionRunEnsure) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.ensure' };
          }
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            undefined,
            undefined,
            ctx,
          );
          const authority = bindAgentExistingExecutionRunAuthority(ctx, opts);
          if (!authority.ok) return authority.error;
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, authority.opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunEnsure(sessionId, {
            runId: data.runId,
            ...(data.resume === true ? { resume: true } : {}),
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.ensure_or_start') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          if (!deps.executionRunEnsureOrStart) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.ensure_or_start' };
          }
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            undefined,
            undefined,
            ctx,
          );
          const existingAuthority = data.runId
            ? bindAgentExistingExecutionRunAuthority(ctx, opts)
            : { ok: true as const, opts };
          if (!existingAuthority.ok) return existingAuthority.error;
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, existingAuthority.opts, { startAndWait: false });
          if (!capability.ok) return capability;
          let start = data.start ? withoutExecutionRunScope(data.start) : undefined;
          let dispatchOpts = capability.opts;
          if (start) {
            const executionRunPermission = resolveAgentExecutionRunPermission(
              ctx,
              start.permissionMode,
              EXECUTION_RUN_ACTION_PERMISSION_MODES,
            );
            if (!executionRunPermission.ok) {
              return executionRunPermission.error;
            }
            const permissionDecision = executionRunPermission.permissionDecision;
            if (permissionDecision?.ok === false) {
              return createPermissionPolicyResult(ctx, permissionDecision);
            }
            if (permissionDecision?.ok === true) {
              start = { ...start, permissionMode: permissionDecision.requestedMode };
            }
            if (executionRunPermission.causalPermissionAuthority) {
              dispatchOpts = {
                ...(dispatchOpts ?? {}),
                causalPermissionAuthority: executionRunPermission.causalPermissionAuthority,
              };
            }
          }
          const res = await deps.executionRunEnsureOrStart(sessionId, {
            ...(data.runId ? { runId: data.runId } : {}),
            ...(start ? { start } : {}),
            ...(data.resume === true ? { resume: true } : {}),
          }, dispatchOpts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.stream.start') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          if (!deps.executionRunStreamStart) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.stream.start' };
          }
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            undefined,
            undefined,
            ctx,
          );
          const authority = bindAgentExistingExecutionRunAuthority(ctx, opts);
          if (!authority.ok) return authority.error;
          const nestedActionOptions: ExecutionRunCallOptions = {
            ...(authority.opts ?? {}),
            ...(ctx.authority ? { authority: ctx.authority } : {}),
            ...(ctx.actionCaller ? { actionCaller: ctx.actionCaller } : {}),
            ...(normalizeId(ctx.runtimeAccountId) ? { runtimeAccountId: normalizeId(ctx.runtimeAccountId) } : {}),
            ...(normalizeId(ctx.actionRequestId) ? { actionRequestId: normalizeId(ctx.actionRequestId) } : {}),
            ...(ctx.externalActionCredential ? { externalActionCredential: ctx.externalActionCredential } : {}),
            ...(ctx.externalActionExecutionAuthorization ? { externalActionExecutionAuthorization: ctx.externalActionExecutionAuthorization } : {}),
            ...(ctx.signExternalActionApprovalInput ? { signExternalActionApprovalInput: ctx.signExternalActionApprovalInput } : {}),
            ...(ctx.externalActionTarget ? { externalActionTarget: ctx.externalActionTarget } : {}),
            ...(normalizeId(ctx.defaultSessionMachineId)
              ? { defaultSessionMachineId: normalizeId(ctx.defaultSessionMachineId) }
              : {}),
          };
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, nestedActionOptions, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunStreamStart(sessionId, {
            runId: data.runId,
            message: data.message,
            ...(data.displayMessage ? { displayMessage: data.displayMessage } : {}),
            ...(data.resume === true ? { resume: true } : {}),
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.stream.read') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          if (!deps.executionRunStreamRead) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.stream.read' };
          }
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            undefined,
            undefined,
            ctx,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunStreamRead(sessionId, {
            runId: data.runId,
            streamId: data.streamId,
            ...(typeof data.cursor === 'number' ? { cursor: data.cursor } : {}),
            ...(typeof data.maxEvents === 'number' ? { maxEvents: data.maxEvents } : {}),
            ...(data.waitForEvents === true ? { waitForEvents: true } : {}),
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.stream.cancel') {
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          if (!deps.executionRunStreamCancel) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.stream.cancel' };
          }
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            undefined,
            undefined,
            ctx,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunStreamCancel(sessionId, {
            runId: data.runId,
            streamId: data.streamId,
          }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.cancel_turn') {
          if (!deps.executionRunCancelTurn) return { ok: false, errorCode: 'unsupported_action', error: 'Cancel turn is unavailable' };
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId, ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            undefined,
            undefined,
            ctx,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const request = ExecutionRunCancelTurnRequestSchema.parse({
            runId: data.runId, occurrenceId: data.occurrenceId, turnId: data.turnId,
          });
          const res = await deps.executionRunCancelTurn(sessionId, request, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.stop') {
          if (!deps.executionRunStop) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            undefined,
            undefined,
            ctx,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunStop(sessionId, { runId: data.runId }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }

        if (actionId === 'execution.run.permission.respond') {
          if (!deps.executionRunPermissionRespond) {
            return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:execution.run.permission.respond' };
          }
          const request = ExecutionRunPermissionRespondInputSchema.parse(parsed.data);
          return completeActionResult(await deps.executionRunPermissionRespond(request, ctx));
        }

        if (actionId === 'execution.run.action') {
          if (!deps.executionRunAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            undefined,
            undefined,
            ctx,
          );
          const authority = bindAgentExistingExecutionRunAuthority(ctx, opts);
          if (!authority.ok) return authority.error;
          const nestedActionOptions: ExecutionRunCallOptions = {
            ...(authority.opts ?? {}),
            ...(ctx.authority ? { authority: ctx.authority } : {}),
            ...(ctx.actionCaller ? { actionCaller: ctx.actionCaller } : {}),
            ...(normalizeId(ctx.runtimeAccountId) ? { runtimeAccountId: normalizeId(ctx.runtimeAccountId) } : {}),
            ...(normalizeId(ctx.actionRequestId) ? { actionRequestId: normalizeId(ctx.actionRequestId) } : {}),
            ...(ctx.externalActionCredential ? { externalActionCredential: ctx.externalActionCredential } : {}),
            ...(ctx.externalActionExecutionAuthorization ? { externalActionExecutionAuthorization: ctx.externalActionExecutionAuthorization } : {}),
            ...(ctx.signExternalActionApprovalInput ? { signExternalActionApprovalInput: ctx.signExternalActionApprovalInput } : {}),
            ...(ctx.externalActionTarget ? { externalActionTarget: ctx.externalActionTarget } : {}),
            ...(normalizeId(ctx.defaultSessionMachineId)
              ? { defaultSessionMachineId: normalizeId(ctx.defaultSessionMachineId) }
              : {}),
          };
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, nestedActionOptions, { startAndWait: false });
          if (!capability.ok) return capability;
          const res = await deps.executionRunAction(sessionId, { runId: data.runId, actionId: data.actionId, input: data.input }, capability.opts);
          return completeExecutionRunServiceActionResult(actionId, res);
        }
  return null;
}

export async function dispatchRunsDispatch2(inv: Pick<CoreInvocation, 'actionId' | 'data' | 'parsed' | 'ctx' | 'deps'>): Promise<ActionExecuteResult | null> {
  const { actionId, data, parsed, ctx, deps } = inv;

        if (actionId === 'execution.run.wait') {
          if (!deps.executionRunWait) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          if (typeof data.runId !== 'string') {
            return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
          }
          const sessionId = resolveExecutionRunScope(parsed.data, ctx);
          const serverId = resolveServerIdForExecutionRunScope(deps, ctx, sessionId);
          const opts = buildExecutionRunCallOptions(
            ctx.authority,
            serverId,
            ctx.signal,
            sessionId === null ? ctx.defaultSessionId : undefined,
            sessionId === null ? ctx.executionRunTargetMachineId : undefined,
            undefined,
            undefined,
            ctx,
          );
          const capability = await checkDetachedExecutionRunProtocolV2(deps, sessionId, opts, { startAndWait: false });
          if (!capability.ok) return capability;
          try {
            const res = await deps.executionRunWait(sessionId, {
              runId: data.runId,
              ...(typeof data.timeoutSeconds === 'number' ? { timeoutSeconds: data.timeoutSeconds } : {}),
              ...(data.condition ? { condition: ExecutionRunWaitConditionSchema.parse(data.condition) } : {}),
              ...(data.after ? { after: ExecutionRunGetResponseSchema.parse(data.after) } : {}),
            }, { ...capability.opts, ...(ctx.onWaitSnapshot ? { onSnapshot: ctx.onWaitSnapshot } : {}) });
            const wait = parseExecutionRunWaitResult(res);
            if (wait.success) return { ok: true, result: wait.data };
            if (readRecord(res).ok === true) {
              return {
                ok: false,
                errorCode: 'action_failed',
                error: 'execution_run_wait_result_invalid',
              };
            }
            return completeExecutionRunServiceActionResult(actionId, res);
          } catch (error) {
            if (!isExecutionRunWaitCancellation(error, ctx.signal)) throw error;
            return { ok: true, result: ExecutionRunWaitResultSchema.parse({ ok: false, code: 'cancelled' }) };
          }
        }
  return null;
}
