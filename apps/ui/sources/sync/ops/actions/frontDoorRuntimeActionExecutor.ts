import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionId, RuntimeActionExecuteArgs } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { HappyError } from '@/utils/errors/errors';

import { createDefaultActionExecutor, type UiActionExecutorContext } from './defaultActionExecutor';

type ActionExecutorLike = Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'> &
  Partial<Pick<ReturnType<typeof createDefaultActionExecutor>, 'prepare' | 'executeConfirmed'>>;
export type FrontDoorActionExecute = ActionExecutorLike['execute'] & Pick<ReturnType<typeof createDefaultActionExecutor>, 'prepare'> & Readonly<{ confirmed: ActionExecutorLike['execute'] }>;
/** The UI front door admits the full Action catalog, including setup before a runtime effect. */
export type FrontDoorRuntimeActionExecute = (
  args: Omit<RuntimeActionExecuteArgs, 'actionId'> & Readonly<{ actionId: ActionId }>,
  options?: Pick<NonNullable<Parameters<typeof createDefaultActionExecutor>[0]>, 'presentUserActionConfirmation'>,
) => Promise<unknown>;
export type UiActionOperation = Pick<UiActionExecutorContext,
  'signal' | 'presentUserConfirmation' | 'defaultSessionId' | 'actionRequestId' | 'onTransportIssued' | 'isPluginSettingsIntentCurrent'
  | 'executionRunTargetMachineId' | 'executionRunLaunchOrigin' | 'externalActionTarget' | 'openRoute' | 'reviewPublicProfilePreparedAction'>;

/** Retain typed refusal and pending custody instead of exposing either as a completed effect. */
export function requireActionSuccess(result: ActionExecuteResult): asserts result is Extract<ActionExecuteResult, { ok: true }> {
  if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode, details: result.details });
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
  if (approval.success) throw new HappyError(approval.data.kind, false, { code: approval.data.kind, details: approval.data });
}

/** The deferred approval {@link requireActionSuccess} threw, so a caller can wait on it instead of failing. */
export function readActionApprovalRequestCreatedError(error: unknown): Readonly<{ artifactId: string }> | null {
  if (!(error instanceof HappyError) || error.code !== 'approval_request_created') return null;
  const approval = ActionApprovalRequestCreatedResultSchema.safeParse(error.details);
  return approval.success ? { artifactId: approval.data.artifactId } : null;
}

/**
 * The canonical `ActionExecutor.execute` front door, lazily resolved.
 *
 * Unlike {@link createFrontDoorRuntimeActionExecutor} this preserves the
 * discriminated `ActionExecuteResult`, so a caller that must distinguish success
 * from failure — the plugin-surface action dispatcher, which rejects failures as
 * typed public errors — is not handed a collapsed value it would have to
 * re-inspect (UI-D08).
 */
export function createFrontDoorActionExecute(
  executor?: ActionExecutorLike,
  options?: Parameters<typeof createDefaultActionExecutor>[0],
): FrontDoorActionExecute {
  // Lazily resolve the default executor on first dispatch so that mounting a surface (which often
  // renders nothing) never eagerly builds the full executor dependency graph.
  let resolved: ActionExecutorLike | null = executor ?? null;
  const resolve = (): ActionExecutorLike => resolved ?? (resolved = createDefaultActionExecutor(options));
  const execute: ActionExecutorLike['execute'] = async (actionId, input, context) => {
    // Static module resolution works in both native bundles and ESM hosts.
    // Construction stays deferred; cyclic consumers only retain this function
    // while evaluating their modules and dispatch after initialization.
    const target = resolve();
    return target.execute(actionId, input, context);
  };
  return Object.assign(execute, {
    confirmed: async (...args: Parameters<ActionExecutorLike['execute']>) => {
      const [actionId, input, context] = args;
      // Snapshot before the lazy import or Account capture can suspend the clicked intent.
      // Use the approval-digest owner's JSON projection, including optional native members.
      let confirmedInput: unknown;
      try { confirmedInput = projectNativeJsonValueForTransport(input); }
      catch { return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' }; }
      const target = resolve();
      if (!target.executeConfirmed) throw new Error('The injected Action executor does not implement confirmed dispatch');
      return target.executeConfirmed(actionId, confirmedInput, context);
    },

    prepare: async (...args: Parameters<ReturnType<typeof createDefaultActionExecutor>['prepare']>) => {
      const target = resolve();
      return target.prepare ? target.prepare(...args) : {
        kind: 'settled' as const,
        result: { ok: false as const, errorCode: 'action_prepare_unavailable', error: 'action_prepare_unavailable' },
      };
    },
  });
}

/**
 * Product-UI adapter for existing domain clients whose leaf contract is
 * `(actionId, input) => value`. Policy, approval, provenance and failure
 * settlement remain owned by the one Action front door; HTTP executors stay
 * below `createDefaultActionExecutor` as transport dependencies only.
 */
export function createFrontDoorUiActionExecutor(
  executor?: ActionExecutorLike,
  scopeContext?: Pick<UiActionExecutorContext, 'serverId' | 'expectedAccountId'>,
): (
  actionId: ActionId,
  input: unknown,
  options?: UiActionOperation,
) => Promise<unknown> {
  const execute = createFrontDoorActionExecute(executor);
  return async (actionId, input, options) => {
    const result = await execute(actionId, input, {
      surface: 'ui',
      authority: options?.presentUserConfirmation ? 'present_user' : undefined,
      actionCaller: options?.presentUserConfirmation ? { kind: 'host' } : undefined,
      ...scopeContext,
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.presentUserConfirmation ? { presentUserConfirmation: options.presentUserConfirmation } : {}),
      ...(options?.defaultSessionId ? { defaultSessionId: options.defaultSessionId } : {}),
      ...(options?.actionRequestId ? { actionRequestId: options.actionRequestId } : {}),
      ...(options?.onTransportIssued ? { onTransportIssued: options.onTransportIssued } : {}),
      ...(options?.isPluginSettingsIntentCurrent ? { isPluginSettingsIntentCurrent: options.isPluginSettingsIntentCurrent } : {}),
      ...(options?.executionRunTargetMachineId ? { executionRunTargetMachineId: options.executionRunTargetMachineId } : {}),
      ...(options?.executionRunLaunchOrigin ? { executionRunLaunchOrigin: options.executionRunLaunchOrigin } : {}),
      ...(options?.externalActionTarget ? { externalActionTarget: options.externalActionTarget } : {}),
      ...(options?.openRoute ? { openRoute: options.openRoute } : {}),
      ...(options?.reviewPublicProfilePreparedAction ? { reviewPublicProfilePreparedAction: options.reviewPublicProfilePreparedAction } : {}),
    });
    requireActionSuccess(result);
    return result.result;
  };
}

/**
 * Canonical front-door bridge: adapts `ActionExecutor.execute` into the `RuntimeActionExecute`
 * shape that runtime-action consumers (local-services panes, browser-panel host API) depend on.
 *
 * This is the single, sanctioned `runtimeActionExecute` adapter (FINALIZATION-PLAN §2.3/§12.6):
 * every product runtime-action dispatch flows through `ActionExecutor.execute`, so per-surface
 * enablement (ActionsSettings) and approval routing (§4.2/§12.8 agent-approval defaults) are
 * always enforced. Product surfaces must obtain their runtime dispatcher here and never call the
 * raw `createDefaultRuntimeActionExecutor` (which is only the executor's internal dep).
 *
 * On success the raw runtime result is unwrapped so callers keep parsing the same payloads they
 * received from the legacy direct path; on failure the `{ ok: false, errorCode, error }` envelope
 * is returned verbatim, which callers treat as fail-closed (schema parse rejects it).
 */
export function createFrontDoorRuntimeActionExecutor(
  executor?: ActionExecutorLike,
): FrontDoorRuntimeActionExecute {
  const execute = createFrontDoorActionExecute(executor);
  return async ({ actionId, input, context }, options) => {
    // Presentation stays private to this invocation; the shared policy still decides whether to ask.
    const dispatch = options?.presentUserActionConfirmation ? createFrontDoorActionExecute(executor, options) : execute;
    const result = await dispatch(actionId, input, context);
    return result.ok ? result.result : result;
  };
}
