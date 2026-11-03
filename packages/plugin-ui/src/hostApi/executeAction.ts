import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPluginError, type JsonValue, type PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type {
  PluginUiActionExecutionOptions,
  PluginUiActionInputFor,
  PluginUiActionReference,
  PluginUiActionResultFor,
  SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';

import { useHappierUiLocalization } from '../environment/context.js';
import { usePluginHostApi } from './context.js';
import { useSurfaceContext } from '../components/PluginUiProvider.js';

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
 * `outcomeUnknown` preserves the client's explicit dispatched-timeout fact.
 * A generic rejection does not prove whether the action ran; only an explicit
 * domain result can establish no effect. Neither rejection is replayed here.
 */
export type PluginActionExecution<Result = unknown> =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'pending' }>
  | Readonly<{ status: 'success'; result: Result }>
  | Readonly<{ status: 'error'; code: string; message: string; retryable: boolean; diagnostics?: readonly PluginDiagnosticData[]; requestId?: string }>
  | Readonly<{ status: 'outcomeUnknown'; code: string; message: string; requestId?: string }>;

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

/**
 * The sentence a refusal stands for when nobody wrote one.
 *
 * Host API refusals cross the mount as a bare `{ code }`, so the client error's
 * `message` is the code itself (`unavailable`). A page that shows
 * `execution.message` must read as words in the reader's language, so a missing
 * message, or one that only repeats its code, becomes the host-translated
 * sentence for that code. An author's or a host's real sentence is kept as is.
 */
const REFUSAL_SENTENCES: Readonly<Record<string, readonly [key: string, fallback: string]>> = {
  unavailable: ['happier.plugin-ui.action.error.unavailable', 'This isn\u2019t available right now. Try again in a moment.'],
  denied: ['happier.plugin-ui.action.error.denied', 'This isn\u2019t allowed here.'],
  expired_resource: ['happier.plugin-ui.action.error.stale', 'This page is out of date. Reopen it and try again.'],
  timeout: ['happier.plugin-ui.action.error.noAnswer', 'No answer came back in time, so it may still finish.'],
  aborted: ['happier.plugin-ui.action.error.noAnswer', 'No answer came back in time, so it may still finish.'],
};
const FAILED_SENTENCE = ['happier.plugin-ui.state.error', 'Something went wrong'] as const;

type Translate = (key: string, fallback?: string) => string;

function readErrorMessage(error: unknown, code: string, translate: Translate): string {
  const message = (error as { message?: unknown } | null)?.message;
  const written = typeof message === 'string' ? message.trim() : '';
  if (written !== '' && written !== code) return written;
  const [key, fallback] = REFUSAL_SENTENCES[code] ?? FAILED_SENTENCE;
  return translate(key, fallback);
}

/** The same transport settlement for controllers that dispatch through an admitted domain executor. */
export function projectPluginActionRejectionV1<Result>(error: unknown, translate: Translate): PluginActionExecution<Result> {
  const code = readErrorCode(error);
  // The host has withdrawn this mount's occurrence and is establishing its
  // successor. Readiness/rebinding owns recovery; never replay an Action here.
  if (code === 'stale_surface') return { status: 'pending' };
  const diagnostics = (error as { diagnostics?: unknown } | null)?.diagnostics;
  // The host binds this diagnostic to a declined confirmation. A generic
  // permission denial remains an error rather than being treated as consent.
  if (code === 'denied' && Array.isArray(diagnostics)
    && diagnostics.includes('plugin_action_current_intent_rejected')) {
    return { status: 'idle' };
  }
  const message = readErrorMessage(error, code, translate);
  const details = (error as { details?: unknown } | null)?.details;
  const requestIdValue = details !== null && typeof details === 'object' && !Array.isArray(details)
    ? Reflect.get(details, 'requestId') : undefined;
  const requestId = typeof requestIdValue === 'string' ? requestIdValue : undefined;
  const receiptLost = details !== null && typeof details === 'object' && !Array.isArray(details)
    && Reflect.get(details, 'layer') === 'transport'
    && Reflect.get(details, 'phase') === 'settlement';
  if (OUTCOME_UNKNOWN_ERROR_CODES.has(code) || receiptLost) {
    return { status: 'outcomeUnknown', code, message, ...(requestId === undefined ? {} : { requestId }) };
  }
  return {
    status: 'error',
    code,
    message,
    retryable: (error as { retryable?: unknown } | null)?.retryable === true,
    ...(requestId === undefined ? {} : { requestId }),
    ...(isPluginError(error) && error.diagnostics !== undefined ? { diagnostics: error.diagnostics } : {}),
  };
}

function settledFromResult<Result>(result: Result): PluginActionExecution<Result> {
  return { status: 'success', result };
}

export type PluginActionExecutionController<Result, Input = JsonValue> = Readonly<{
  /** The current execution state for the bound action. */
  execution: PluginActionExecution<Result>;
  /** The mounted host's pending approval while this hook has work in flight. The host retains all decision/result custody. */
  pendingApproval: NonNullable<SurfaceContext['pendingApproval']> | null;
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
  const surface = useSurfaceContext();
  const { translate } = useHappierUiLocalization();
  const translateRef = useRef(translate);
  translateRef.current = translate;
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
      settled = projectPluginActionRejectionV1<JsonValue>(error, translateRef.current);
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

  return { execution, execute, reset, pendingApproval: execution.status === 'pending' ? surface.pendingApproval ?? null : null };
}
