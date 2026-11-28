import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/plugin-sdk/actions';
import { isActionApprovalDeclinedErrorCode, isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/plugin-sdk/errors';
import { isPluginErrorData } from '@happier-dev/protocol/plugins/errors';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPluginError, readPluginErrorRequestIdV1, type JsonValue, type PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type {
  PluginUiActionExecutionOptions,
  PluginUiActionControlExecution,
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

type PluginActionFailureAuthorPayloadV1 = ReturnType<typeof readPluginActionFailureAuthorPayload>;
const StrictJsonValueSchema = defineProtocolJsonValue();

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
  | Readonly<{ status: 'success'; result: Result; requestId?: string }>
  | Readonly<Omit<PluginActionFailureAuthorPayloadV1, 'diagnostics'> & { effectAttempted?: boolean; status: 'error'; code: string; message: string; authoredMessage?: string; retryable: boolean; diagnostics?: readonly PluginDiagnosticData[]; requestId?: string }>
  | Readonly<PluginActionFailureAuthorPayloadV1 & { effectAttempted?: boolean; status: 'outcomeUnknown'; code: string; message: string; authoredMessage?: string; requestId?: string }>;

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
const CONFIRMATION_DECLINED_CODE = 'plugin_action_current_intent_rejected';

/** A settled host decision, consumed without decoding transport diagnostics again. */
export function isPluginActionConfirmationDeclined(execution: PluginActionExecution<unknown>): boolean {
  return execution.status === 'error' && execution.code === CONFIRMATION_DECLINED_CODE;
}

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
 * Synchronous fallback sentences for callers that read `execution.message`.
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

function readAuthoredMessage(message: unknown, code: string): string | undefined {
  if (typeof message !== 'string') return undefined;
  const normalized = message.trim();
  return normalized === '' || normalized === code ? undefined : message;
}

function translateRefusal(code: string, translate: Translate): string {
  const [key, fallback] = Object.hasOwn(REFUSAL_SENTENCES, code) ? REFUSAL_SENTENCES[code]! : FAILED_SENTENCE;
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
  const confirmationDeclined = isActionApprovalDeclinedErrorCode(code) || code === 'denied' && Array.isArray(diagnostics)
    && diagnostics.some(diagnostic => typeof diagnostic === 'string'
      ? diagnostic === CONFIRMATION_DECLINED_CODE
      : diagnostic !== null && typeof diagnostic === 'object'
        && Reflect.get(diagnostic, 'code') === CONFIRMATION_DECLINED_CODE);
  const details = (error as { details?: unknown } | null)?.details;
  const requestId = readPluginErrorRequestIdV1(error);
  const pluginError = isPluginError(error) ? error : undefined;
  const authoredMessage = readAuthoredMessage(pluginError?.data.message ?? (error as { message?: unknown } | null)?.message, code);
  const message = authoredMessage ?? translateRefusal(code, translate);
  const authored = pluginError ? { success: true as const, data: pluginError.data } : StrictJsonValueSchema.safeParse(error);
  const { details: carriedDetails, ...author } = readPluginActionFailureAuthorPayload(authored.success ? authored.data : undefined);
  // Immediate contributed failures carry PluginError data where recorded failures can carry the author details directly.
  const authorPayload = isPluginErrorData(carriedDetails) && carriedDetails.code === code
    ? readPluginActionFailureAuthorPayload(carriedDetails)
    : carriedDetails === undefined ? {} : { details: carriedDetails };
  const effectAttempted = (error as { effectAttempted?: unknown } | null)?.effectAttempted
    ?? (details && typeof details === 'object' ? Reflect.get(details, 'effectAttempted') : undefined);
  const metadata = { ...authorPayload, ...author,
    ...(authoredMessage === undefined ? {} : { authoredMessage }),
    ...(typeof effectAttempted === 'boolean' ? { effectAttempted } : {}),
  };
  const receiptLost = details !== null && typeof details === 'object' && !Array.isArray(details)
    && Reflect.get(details, 'layer') === 'transport'
    && Reflect.get(details, 'phase') === 'settlement';
  if (OUTCOME_UNKNOWN_ERROR_CODES.has(code) || isActionOutcomeUnknownErrorCodeV1(code)
    || (error as { effectAttempted?: unknown } | null)?.effectAttempted === true || receiptLost) {
    return { ...metadata, status: 'outcomeUnknown', code, message, ...(requestId === undefined ? {} : { requestId }) };
  }
  return {
    ...metadata,
    status: 'error',
    code: confirmationDeclined ? CONFIRMATION_DECLINED_CODE : code,
    message,
    retryable: (error as { retryable?: unknown } | null)?.retryable === true,
    ...(requestId === undefined ? {} : { requestId }),
    ...(isPluginError(error) && error.diagnostics !== undefined ? { diagnostics: error.diagnostics } : {}),
  };
}

/** Presents the original host settlement through the same owner as raw Action rejections. */
export function projectPluginActionControlExecutionV1(execution: PluginUiActionControlExecution, translate: Translate): PluginActionExecution {
  if (execution.ok) return { status: 'success', result: execution.result };
  const projected = projectPluginActionRejectionV1({ ...execution, code: execution.errorCode, message: execution.error }, translate);
  if (execution.requestId === undefined || (projected.status !== 'error' && projected.status !== 'outcomeUnknown')) return projected;
  return { ...projected, requestId: execution.requestId };
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
   * would be the same mutation running twice. A replacement waits for an
   * explicitly cancelled predecessor to settle before dispatching.
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
  const pendingRef = useRef<Readonly<{
    token: object;
    signal: AbortSignal | undefined;
    settled: Promise<void>;
  }> | null>(null);
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
    while (pendingRef.current?.token === bindingToken) {
      const previous = pendingRef.current;
      if (!previous.signal?.aborted) return { status: 'pending' };
      // Cancellation may settle asynchronously at the host boundary. The
      // successor consumes that settlement instead of mistaking it for a
      // duplicate live operation. Re-check the slot after another waiter wakes.
      await previous.settled;
    }
    let finish!: () => void;
    const pending = { token: bindingToken, signal: options?.signal,
      settled: new Promise<void>((resolve) => { finish = resolve; }) };
    pendingRef.current = pending;
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
      let requestId: string | undefined;
      const result = await executeAction(action, actionInput, {
        ...options,
        onIssued: (issuedRequestId) => {
          requestId = issuedRequestId;
          options?.onIssued?.(issuedRequestId);
        },
      });
      settled = { ...settledFromResult(result), ...(requestId === undefined ? {} : { requestId }) };
    } catch (error) {
      settled = projectPluginActionRejectionV1<JsonValue>(error, translateRef.current);
    }

    if (pendingRef.current === pending) pendingRef.current = null;
    finish();
    if (mountedRef.current) {
      setExecutionRecord((current) => current.token === bindingToken
        ? { token: bindingToken, execution: settled }
        : current);
    }
    return settled;
  }, [action, bindingToken, hostApi, input]);

  const reset = useCallback(() => {
    if (pendingRef.current?.token !== bindingToken) {
      setExecutionRecord({ token: bindingToken, execution: { status: 'idle' } });
    }
  }, [bindingToken]);

  return { execution, execute, reset, pendingApproval: execution.status === 'pending' ? surface.pendingApproval ?? null : null };
}
