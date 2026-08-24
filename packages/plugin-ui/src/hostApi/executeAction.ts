import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  PluginUiActionExecutionOptions,
  PluginUiActionInputFor,
  PluginUiActionReference,
  PluginUiActionResultFor,
} from '@happier-dev/plugin-sdk/ui';

import { usePluginHostApi } from './context.js';

/**
 * Compatibility names for established plugin-ui consumers. The SDK owns the
 * action-reference/input/result mapping; this package only consumes it.
 */
export type { JsonValue as PluginActionInput } from '@happier-dev/plugin-sdk';
export type {
  PluginUiActionInputFor as PluginActionInputFor,
  PluginUiActionReference as PluginActionReference,
  PluginUiActionResultFor as PluginActionResultFor,
} from '@happier-dev/plugin-sdk/ui';

/**
 * The settled fact about one execution (§3.9).
 *
 * `outcomeUnknown` is a first-class member, not a flavour of `error`, because
 * the two license opposite behaviour: a definite failure never ran, so offering
 * "try again" is correct; an unknown outcome may already have mutated state, so
 * §2 forbids retrying it blindly. Collapsing them is precisely how a duplicate
 * mutation ships.
 */
export type PluginActionExecution<Result = unknown> =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'success'; result: Result }>
  | Readonly<{ status: 'error'; code: string; message: string; retryable: boolean }>
  | Readonly<{ status: 'outcomeUnknown'; code: string; message: string }>;

/**
 * The rejection codes that mean "the request reached the host and we stopped
 * waiting", as opposed to "the host declined it".
 *
 * These are the canonical `@happier-dev/plugin-sdk/ui` client's own codes:
 * `timeout` fires after the request was written to the transport, and `aborted`
 * settles an already-dispatched request when the caller's signal fires. Neither
 * tells the author whether the action ran.
 *
 * Read structurally from `error.code` and never with `instanceof` (§3.5): a
 * hosted-web surface receives its errors as postMessage payloads from another
 * realm, and a packed React Native plugin carries its own copy of the error
 * class, so identity is false across exactly the boundaries that matter.
 */
const OUTCOME_UNKNOWN_ERROR_CODES: ReadonlySet<string> = new Set(['timeout', 'aborted']);

const UNKNOWN_ERROR_CODE = 'plugin_action_failed';

type PluginUiActionExecutionWithOptionalInput = (
  action: PluginUiActionReference,
  input?: JsonValue,
  options?: PluginUiActionExecutionOptions,
) => Promise<JsonValue>;

function actionIdentityKey(action: PluginUiActionReference): string {
  return typeof action === 'string'
    ? JSON.stringify(['local', action])
    : JSON.stringify(['qualified', action.pluginId, action.localId]);
}

function readErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.trim() !== '' ? code : UNKNOWN_ERROR_CODE;
}

function readErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim() !== ''
    ? message
    : 'The action did not complete.';
}

function settledFromRejection<Result>(error: unknown): PluginActionExecution<Result> {
  const code = readErrorCode(error);
  const message = readErrorMessage(error);
  if (OUTCOME_UNKNOWN_ERROR_CODES.has(code)) {
    return { status: 'outcomeUnknown', code, message };
  }
  return {
    status: 'error',
    code,
    message,
    retryable: (error as { retryable?: unknown } | null)?.retryable === true,
  };
}

function settledFromResult<Result>(result: Result): PluginActionExecution<Result> {
  return { status: 'success', result };
}

export type PluginActionExecutionController<Result, Input = JsonValue> = Readonly<{
  /** The current execution state for the bound action. */
  execution: PluginActionExecution<Result>;
  /**
   * Run the bound action. `input` overrides the bound input for this run, which
   * is what a form surface needs — the values only exist at press time.
   *
   * Resolves with the settled execution rather than throwing, so a caller reads
   * one typed outcome instead of writing a second try/catch beside this state.
   * A call made while one is already in flight is ignored and resolves with the
   * pending state: this hook owns the action's identity, so a second dispatch
   * would be the same mutation running twice.
   */
  execute: (
    input?: Input,
    options?: PluginUiActionExecutionOptions,
  ) => Promise<PluginActionExecution<Result>>;
  /** Return to `idle`, e.g. after the author has shown the outcome. */
  reset: () => void;
}>;

/**
 * Execute one contributed or host action and observe its typed lifecycle
 * (§3.9).
 *
 * It passes the author's reference and input to `PluginUiHostApi.executeAction`
 * untouched. Parsing action identity, evaluating policy and stamping the
 * execution surface belong to the canonical host dispatcher (§3.5); a second
 * interpretation here would be the split-brain that owner exists to prevent.
 *
 * It is exported under §3.9's hook rule because it owns caller-visible async
 * state — pending, success, typed failure and outcome-unknown, plus the
 * in-flight guard and unmount safety — that every caller would otherwise
 * rewrite.
 */
export function useExecutePluginAction<TAction extends PluginUiActionReference>(
  action: TAction,
  input?: NoInfer<PluginUiActionInputFor<NoInfer<TAction>>>,
): PluginActionExecutionController<
  PluginUiActionResultFor<NoInfer<TAction>>,
  PluginUiActionInputFor<NoInfer<TAction>>
>;
export function useExecutePluginAction(
  action: PluginUiActionReference,
  input?: JsonValue,
): PluginActionExecutionController<JsonValue, JsonValue> {
  const hostApi = usePluginHostApi();
  const actionKey = actionIdentityKey(action);
  const bindingToken = useMemo(() => ({}), [actionKey, hostApi]);
  const [executionRecord, setExecutionRecord] = useState<Readonly<{
    token: object;
    execution: PluginActionExecution<JsonValue>;
  }>>({ token: bindingToken, execution: { status: 'idle' } });
  const execution = executionRecord.token === bindingToken
    ? executionRecord.execution
    : { status: 'idle' } as const;
  // The guard is a ref rather than the rendered state: React has not committed
  // `pending` yet when a second press arrives in the same tick, so a state-only
  // guard dispatches the action twice (the same defect the shared pressable
  // owner fixes for presses).
  const pendingRef = useRef<object | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    // StrictMode probes setup → cleanup → setup. Re-arm the settlement guard
    // on each setup so an active mounted hook can publish its outcome.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = useCallback(async (
    overrideInput?: JsonValue,
    options?: PluginUiActionExecutionOptions,
  ): Promise<PluginActionExecution<JsonValue>> => {
    if (pendingRef.current === bindingToken) return { status: 'pending' };
    pendingRef.current = bindingToken;
    setExecutionRecord({ token: bindingToken, execution: { status: 'pending' } });

    let settled: PluginActionExecution<JsonValue>;
    try {
      // `null` is an explicit author value (for example, a form clearing an
      // initially bound payload). An omitted value must stay omitted so the
      // protocol's optional action-input grammar, and only that grammar,
      // supplies its default. The public generic signature keeps typed Action
      // inputs required; this hook also serves dynamic actions whose input is
      // intentionally absent.
      const actionInput = overrideInput === undefined ? input : overrideInput;
      const executeAction = hostApi.executeAction as PluginUiActionExecutionWithOptionalInput;
      const result = options === undefined
        ? actionInput === undefined
          ? await executeAction(action)
          : await executeAction(action, actionInput)
        : await executeAction(action, actionInput, options);
      settled = settledFromResult(result);
    } catch (error) {
      settled = settledFromRejection<JsonValue>(error);
    }

    if (pendingRef.current === bindingToken) pendingRef.current = null;
    if (mountedRef.current) {
      setExecutionRecord((current) => current.token === bindingToken
        ? { token: bindingToken, execution: settled }
        : current);
    }
    return settled;
  }, [action, bindingToken, hostApi, input]);

  const reset = useCallback(() => {
    if (pendingRef.current !== bindingToken) {
      setExecutionRecord({ token: bindingToken, execution: { status: 'idle' } });
    }
  }, [bindingToken]);

  return { execution, execute, reset };
}
