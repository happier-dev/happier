import { AgentRuntimeJsonValueV1Schema } from '../../runtime/agentSessionV1.js';
import {
  PluginDiagnosticDataV1Schema,
  PluginDiagnosticRemediationV1Schema,
  type PluginDiagnosticDataV1,
  type PluginDiagnosticRemediationV1,
} from '../../daemon/pluginContributionIntrospection.js';
import { trimBugReportTextHeadToMaxBytes } from '../../bugs/reports/redaction.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { computeCanonicalDomainSeparatedHexDigest } from '../../crypto/canonicalDigest.js';
import type { JsonValue as StrictJsonValue } from '../../json/strictJsonValue.js';
import { z } from 'zod';
import { isPluginError } from '../errors.js';
import {
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../contributionIdentity.js';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
  rehydrateCanonicalProtocolComposableSchema,
} from './jsonSchemaValidation.js';
import {
  evaluatePluginActionPolicy,
  type PluginActionPolicyInput,
} from './policy.js';
import type {
  PluginActionConfirmationV2,
  PluginActionDangerLevelV2,
} from './v2.js';

const PLUGIN_ACTION_FAILURE_FALLBACK_CODE = 'plugin_action_execution_failed';
const PLUGIN_ACTION_FAILURE_FALLBACK_MESSAGE = 'Plugin operation failed';
export const PLUGIN_ACTION_FAILURE_MESSAGE_MAX_UTF8_BYTES = 2_048;

/**
 * Stable, non-secret Action failure projection shared by every realm that
 * reconstructs a plugin handler error. Hosts apply credential and local-path
 * redaction before calling this message projector; that privacy work remains
 * host-owned rather than becoming an SDK behavior.
 */
export function projectPluginActionFailureCode(value: unknown): string {
  return typeof value === 'string'
    && /^[a-z][a-z0-9_.:-]{0,119}$/iu.test(value)
    ? value
    : PLUGIN_ACTION_FAILURE_FALLBACK_CODE;
}

export function projectPluginActionFailureMessage(
  value: unknown,
  options: Readonly<{ maxUtf8Bytes?: number }> = {},
): string {
  try {
    if (typeof value !== 'string') return PLUGIN_ACTION_FAILURE_FALLBACK_MESSAGE;
    const trimmed = value.trim();
    if (!trimmed) return PLUGIN_ACTION_FAILURE_FALLBACK_MESSAGE;
    const maxUtf8Bytes = typeof options.maxUtf8Bytes === 'number'
      && Number.isFinite(options.maxUtf8Bytes)
      && options.maxUtf8Bytes > 0
      ? Math.trunc(options.maxUtf8Bytes)
      : PLUGIN_ACTION_FAILURE_MESSAGE_MAX_UTF8_BYTES;
    const bounded = trimBugReportTextHeadToMaxBytes(trimmed, maxUtf8Bytes).trim();
    return bounded || PLUGIN_ACTION_FAILURE_FALLBACK_MESSAGE;
  } catch {
    return PLUGIN_ACTION_FAILURE_FALLBACK_MESSAGE;
  }
}

/** Canonical durable/settings key for one contributed Action. */
export type QualifiedPluginActionId = `${string}/actions/${string}`;

/**
 * Formats the only supported qualified contributed-Action identity. Settings,
 * discovery, and invocation share this owner instead of reconstructing the
 * slash grammar at each boundary.
 */
export function formatQualifiedPluginActionId(
  identity: PluginContributionIdentityV1,
): QualifiedPluginActionId {
  const parsed = PluginContributionIdentityV1Schema.parse(identity);
  return `${parsed.pluginId}/actions/${parsed.localId}`;
}

/** Reads only the canonical qualified contributed-Action spelling. */
export function parseQualifiedPluginActionId(value: unknown): PluginContributionIdentityV1 | null {
  if (typeof value !== 'string') return null;
  const separator = '/actions/';
  const separatorIndex = value.indexOf(separator);
  if (separatorIndex <= 0) return null;
  const parsed = PluginContributionIdentityV1Schema.safeParse({
    pluginId: value.slice(0, separatorIndex),
    localId: value.slice(separatorIndex + separator.length),
  });
  if (!parsed.success || formatQualifiedPluginActionId(parsed.data) !== value) return null;
  return parsed.data;
}

export type PluginActionInvocationResult = Readonly<
  | { status: 'executed'; value: StrictJsonValue }
  | {
    status: 'unavailable';
    code: string;
    message: string;
    /** Present only when canonical admission proves the handler did not begin. */
    actionHandlerInvocation?: 'notStarted';
  }
  | {
    status: 'invalid';
    code: string;
    message: string;
    /** Exact bounded issues from the executable Protocol parser, when present. */
    issues?: readonly PluginActionInputParserIssue[];
  }
  | {
    status: 'failed';
    code: string;
    message: string;
    /** Present only for a proven canonical PluginError. */
    retryable?: boolean;
    /**
     * The target's own published PluginError contract payload. Plugins are
     * trusted code, so an author's structured failure detail reaches the
     * caller instead of being reduced to a bare code. It is absent when the
     * payload is not JSON-safe.
     */
    data?: StrictJsonValue;
  }
>;

export type PluginActionInputParserIssue = Readonly<{
  path: readonly (string | number)[];
  code: string;
  message: string;
}>;

export type PluginActionInputParserResult = Readonly<
  | { success: true; data: unknown }
  | { success: false; issues: readonly PluginActionInputParserIssue[] }
>;

/** Exact-generation executable semantics captured from a composable Action declaration. */
export type PluginActionInputParser = (
  input: StrictJsonValue,
) => PluginActionInputParserResult;
export type PluginActionResultParser = PluginActionInputParser;

/** Canonical terminal code when cancellation races an already-started Action. */
export const PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE = 'plugin_action_outcome_unknown';

/**
 * Canonical terminal code for a present user who DECLINED the confirmation.
 *
 * A decline is a decision, not an absence: it must stay distinguishable from
 * "this Action is not available" all the way to the caller, otherwise an
 * autonomous caller (Voice) reads a deliberate "no" as a transient gap and
 * asks again. Every realm that reports a rejected current intent uses this
 * one spelling so the projection at each caller boundary can recognize it.
 */
export const PLUGIN_ACTION_CURRENT_INTENT_REJECTED_CODE = 'plugin_action_current_intent_rejected';

/**
 * Projects only an unavailable cancellation/retirement outcome. A proved
 * non-start remains ordinary unavailable; absence of that proof after one of
 * these terminal signals means the handler may have effected before it settled.
 */
export function projectPluginActionUnavailableOutcomeCode(
  code: string,
  actionHandlerInvocation: 'notStarted' | undefined,
): string {
  if (
    actionHandlerInvocation === undefined
    && (code === 'plugin_action_aborted' || code === 'plugin_action_generation_retired')
  ) {
    return PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE;
  }
  return code;
}

export type PluginActionInvocationHandlerInput = Readonly<{
  input: StrictJsonValue;
  qualifiedId: string;
  signal: AbortSignal;
}>;

/**
 * A host-side admission denial after canonical input-schema validation. This
 * is intentionally an outcome rather than an exception so pre-handler
 * currentness checks cannot be misclassified as a handler failure.
 */
type PluginActionInvocationPreDispatchResult = Readonly<{
  status: 'unavailable';
  code: string;
  message: string;
}>;

const invalidInput = Object.freeze({
  status: 'invalid' as const,
  code: 'plugin_action_input_schema_invalid',
  message: 'Plugin action input does not match its manifest inputSchema',
});

function invalidInputFromParserIssues(
  issues: readonly PluginActionInputParserIssue[],
): PluginActionInvocationResult {
  const capturedIssues = Object.freeze(issues.map((issue) => Object.freeze({
    path: Object.freeze([...issue.path]),
    code: issue.code,
    message: issue.message,
  })));
  return Object.freeze({
    status: 'invalid' as const,
    code: 'plugin_action_input_schema_invalid',
    message: capturedIssues[0]?.message ?? invalidInput.message,
    issues: capturedIssues,
  });
}

const inputSchemaProjectionMismatch = Object.freeze({
  status: 'failed' as const,
  code: 'plugin_action_schema_projection_mismatch',
  message: 'Plugin action executable input semantics disagree with the manifest inputSchema',
});

const resultSchemaProjectionMismatch = Object.freeze({
  status: 'failed' as const,
  code: 'plugin_action_schema_projection_mismatch',
  message: 'Plugin action executable result semantics disagree with the manifest resultSchema',
});

function invalidResult(message: string): PluginActionInvocationResult {
  return Object.freeze({
    status: 'invalid',
    code: 'plugin_action_result_schema_invalid',
    message,
  });
}

function rehydrateActionParser(schema: object | undefined): PluginActionInputParser | undefined {
  if (!schema) return undefined;
  const rehydrated = rehydrateCanonicalProtocolComposableSchema(schema);
  if (!rehydrated) return undefined;
  return (input) => {
    const parsed = rehydrated.safeParse(input);
    return parsed.success
      ? Object.freeze({ success: true as const, data: parsed.data })
      : Object.freeze({ success: false as const, issues: parsed.error.issues });
  };
}

function unavailable(code: string, message: string): PluginActionInvocationResult {
  return Object.freeze({ status: 'unavailable', code, message });
}

function unavailableBeforeHandler(code: string, message: string): PluginActionInvocationResult {
  return Object.freeze({
    status: 'unavailable',
    code,
    message,
    actionHandlerInvocation: 'notStarted',
  });
}

function readPreDispatchUnavailableResult(
  value: unknown,
): PluginActionInvocationPreDispatchResult | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.status !== 'unavailable'
    || typeof record.code !== 'string'
    || typeof record.message !== 'string'
  ) return null;
  return Object.freeze({
    status: 'unavailable',
    code: record.code,
    message: record.message,
  });
}

function compileSchema(schema: object | undefined): ReturnType<typeof compilePluginJsonSchema> | null {
  if (schema === undefined) return null;
  return compilePluginJsonSchema(schema);
}

function validates(validator: ReturnType<typeof compilePluginJsonSchema> | null, value: StrictJsonValue): boolean {
  if (!validator) return true;
  return isValidPluginJsonSchemaValue(validator, value);
}

type PluginActionAbortSource = 'caller' | 'generation';

function linkAbortSignals(generationSignal: AbortSignal, callerSignal?: AbortSignal): Readonly<{
  signal: AbortSignal;
  abortSource(): PluginActionAbortSource | null;
  dispose(): void;
}> {
  const controller = new AbortController();
  const sources: readonly Readonly<{ source: PluginActionAbortSource; signal: AbortSignal }>[] = [
    { source: 'generation', signal: generationSignal },
    ...(callerSignal ? [{ source: 'caller' as const, signal: callerSignal }] : []),
  ];
  let firstAbortSource: PluginActionAbortSource | null = null;
  const abort = (source: Readonly<{ source: PluginActionAbortSource; signal: AbortSignal }>) => {
    if (!controller.signal.aborted) {
      firstAbortSource = source.source;
      controller.abort(source.signal.reason);
    }
  };
  const listeners = sources.map((source) => {
    const listener = () => abort(source);
    if (source.signal.aborted) abort(source);
    else source.signal.addEventListener('abort', listener, { once: true });
    return { source, listener };
  });
  return Object.freeze({
    signal: controller.signal,
    abortSource() {
      return firstAbortSource;
    },
    dispose() {
      for (const { source, listener } of listeners) {
        source.signal.removeEventListener('abort', listener);
      }
    },
  });
}

type PluginActionHandlerSettlement =
  | Readonly<{ kind: 'fulfilled'; value: unknown }>
  | Readonly<{ kind: 'rejected'; error: unknown }>
  | Readonly<{ kind: 'aborted' }>;

const abortedPluginActionHandlerSettlement = Object.freeze({ kind: 'aborted' as const });

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return typeof Reflect.get(value, 'then') === 'function';
}

function awaitPluginActionHandlerSettlementOrAbort(
  signal: AbortSignal,
  invoke: () => unknown | Promise<unknown>,
): Promise<PluginActionHandlerSettlement> {
  return new Promise<PluginActionHandlerSettlement>((resolve) => {
    let settled = false;
    let enteringHandler = false;
    let abortedDuringHandlerEntry = false;
    let resolveAbort: (() => void) | undefined;
    const abortSettlement = new Promise<typeof abortedPluginActionHandlerSettlement>((resolveAbortSettlement) => {
      resolveAbort = () => resolveAbortSettlement(abortedPluginActionHandlerSettlement);
    });
    function settle(settlement: PluginActionHandlerSettlement): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(settlement);
    }
    function onAbort(): void {
      if (enteringHandler) {
        abortedDuringHandlerEntry = true;
        return;
      }
      resolveAbort?.();
    }

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      settle(abortedPluginActionHandlerSettlement);
      return;
    }

    let value: unknown;
    try {
      enteringHandler = true;
      value = invoke();
    } catch (error) {
      settle(abortedDuringHandlerEntry
        ? abortedPluginActionHandlerSettlement
        : Object.freeze({ kind: 'rejected', error }));
      return;
    } finally {
      enteringHandler = false;
    }

    try {
      if (!isThenable(value)) {
        settle(abortedDuringHandlerEntry
          ? abortedPluginActionHandlerSettlement
          : Object.freeze({ kind: 'fulfilled', value }));
        return;
      }
      const handlerSettlement = Promise.resolve(value);
      if (abortedDuringHandlerEntry) {
        void handlerSettlement.then(
          () => undefined,
          () => undefined,
        );
        settle(abortedPluginActionHandlerSettlement);
        return;
      }
      // Both reactions are installed before invocation returns, so Promise
      // reaction order decides post-entry settlement without a timer.
      void Promise.race([handlerSettlement, abortSettlement]).then(
        (outcome) => settle(outcome === abortedPluginActionHandlerSettlement
          ? abortedPluginActionHandlerSettlement
          : Object.freeze({ kind: 'fulfilled', value: outcome })),
        (error) => settle(Object.freeze({ kind: 'rejected', error })),
      );
    } catch (error) {
      settle(abortedDuringHandlerEntry
        ? abortedPluginActionHandlerSettlement
        : Object.freeze({ kind: 'rejected', error }));
    }
  });
}

/**
 * Only a proven canonical PluginError may publish an author-chosen failure
 * code, `retryable` signal and contract payload. Plugins are trusted code, so
 * the author's own structured detail is the failure a caller receives rather
 * than a bare taxonomy code.
 *
 * `data` is the SDK-published contract representation, so it is the one thing
 * projected: `cause` is an Error rather than contract data and never becomes a
 * JSON payload. The payload passes the same JSON-safety admission as every
 * Action input and result; invalid JSON data is omitted without suppressing
 * the proven failure code.
 */
function readPluginError(error: unknown): Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  data?: StrictJsonValue;
}> | null {
  if (!isPluginError(error)) return null;
  const data = AgentRuntimeJsonValueV1Schema.safeParse(error.data);
  const failure = Object.freeze({
    code: projectPluginActionFailureCode(error.code),
    message: projectPluginActionFailureMessage(error.message),
  });
  return Object.freeze({
    code: failure.code,
    message: failure.message,
    retryable: error.retryable,
    ...(data.success ? { data: data.data } : {}),
  });
}

/**
 * The author vocabulary a canonical PluginError publishes alongside its code.
 * Protocol owns the wire decision so the daemon Action host and the SDK test
 * host read one payload the same way instead of each inventing a reader.
 */
export type PluginActionFailureAuthorPayloadV1 = Readonly<{
  details?: StrictJsonValue;
  remediation?: PluginDiagnosticRemediationV1;
  diagnostics?: readonly PluginDiagnosticDataV1[];
}>;

const PluginActionFailureDiagnosticsV1Schema = z.array(PluginDiagnosticDataV1Schema);

/**
 * Reads the author vocabulary out of a projected failure `data` payload. Each
 * field is admitted independently, so one field a target published in a shape
 * this version does not model cannot suppress the rest. Identity and
 * consistency fields are deliberately not read here: `code`, `message` and
 * `retryable` are already carried as proven top-level projection facts.
 */
export function readPluginActionFailureAuthorPayload(
  data: StrictJsonValue | undefined,
): PluginActionFailureAuthorPayloadV1 {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    return Object.freeze({});
  }
  const record = data as Readonly<Record<string, StrictJsonValue | undefined>>;
  const remediation = record.remediation === undefined
    ? undefined
    : PluginDiagnosticRemediationV1Schema.safeParse(record.remediation);
  const diagnostics = record.diagnostics === undefined
    ? undefined
    : PluginActionFailureDiagnosticsV1Schema.safeParse(record.diagnostics);
  return Object.freeze({
    ...(record.details === undefined ? {} : { details: record.details }),
    ...(remediation?.success ? { remediation: remediation.data } : {}),
    ...(diagnostics?.success ? { diagnostics: Object.freeze(diagnostics.data) } : {}),
  });
}

const PluginActionPresentUserAuthorizationScopeSchema = z.object({
  accountId: z.string().optional(),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  machineId: z.string().optional(),
  actorId: z.string().optional(),
}).strict();

const PluginActionPresentUserAuthorizationRequirementSchema = z.object({
  id: z.string(),
  required: z.boolean(),
  status: z.enum(['available', 'denied', 'unavailable', 'notApplicable']),
  code: z.string().optional(),
}).strict();

/**
 * The one wire-safe form of the canonical final-policy facts used by Action
 * admission. It deliberately excludes availability and confirmation because
 * those remain Action-present-user gate inputs rather than authorization facts.
 */
export const PluginActionPresentUserAuthorizationFactsSchema = z.object({
  generation: z.object({
    targetGeneration: z.string(),
    desiredGeneration: z.string().nullable(),
    appliedGeneration: z.string().nullable(),
    targetGenerationMode: z.enum(['current', 'retained']).optional(),
  }).strict(),
  resourceSelections: z.array(z.object({
    id: z.string(),
    required: z.boolean(),
    requestedResourceId: z.string().optional(),
    selectedResourceId: z.string().optional(),
  }).strict()),
  scopedGrants: z.array(z.object({
    id: z.string(),
    required: z.boolean(),
    status: z.enum(['active', 'missing', 'revoked']),
    requiredScope: PluginActionPresentUserAuthorizationScopeSchema,
    grantedScope: PluginActionPresentUserAuthorizationScopeSchema.optional(),
  }).strict()),
  serviceAvailability: z.array(PluginActionPresentUserAuthorizationRequirementSchema),
  operatingSystemAuthorization: z.array(PluginActionPresentUserAuthorizationRequirementSchema),
}).strict();

export type PluginActionPresentUserAuthorizationFacts = Readonly<
  Omit<PluginActionPolicyInput, 'availability' | 'confirmation'>
>;

/**
 * Normalized Action facts that participate in one present-user admission.
 * The caller resolves these from its own realm, but the shared gate owns their
 * surface/scope/policy decision and the resulting current-intent fingerprint.
 */
export type PluginActionPresentUserGatePolicy = Readonly<{
  qualifiedId: string;
  generation: string;
  dangerLevel: PluginActionDangerLevelV2;
  scopes: readonly string[];
  surfaces: readonly string[];
  confirmation?: PluginActionConfirmationV2;
  /**
   * Host-stamped Action-settings policy. This is deliberately distinct from
   * plugin-declared confirmation: a plugin cannot manufacture user consent by
   * supplying it as Action input or manifest presentation.
   */
  approvalRequiredByActionSettings?: true;
  availability?: PluginActionPolicyInput['availability'];
  authorization: PluginActionPresentUserAuthorizationFacts;
  /** Exact realm-owned facts not otherwise represented in the policy evaluator. */
  fingerprintContext?: unknown;
}>;

export type PluginActionPresentUserGateResolved<TAction> = Readonly<{
  status: 'resolved';
  action: TAction;
  policy: PluginActionPresentUserGatePolicy;
  /** A realm may retire a selection while consent is on screen. */
  isCurrent?: () => boolean;
}>;

export type PluginActionPresentUserGateResolution<TAction> =
  | PluginActionPresentUserGateResolved<TAction>
  | Readonly<{ status: 'unavailable'; code: string; message?: string }>
  | Readonly<{ status: 'failed'; code: string; message: string }>;

export type PluginActionCurrentIntentRequest<TAction> = Readonly<{
  action: TAction;
  fingerprint: string;
  /** Declared Action capability surface. */
  surface: string;
  /** Actual invoking host surface that the approval binds. */
  invocationSurface: string;
  signal?: AbortSignal;
}>;

export type PluginActionCurrentIntentResult = Readonly<
  | { status: 'approved'; fingerprint: string }
  | { status: 'deferred'; artifactId: string }
  | { status: 'rejected' | 'unavailable'; code: string }
>;

export type PluginActionPresentUserGateResult<TAction> = Readonly<
  | { status: 'admitted'; action: TAction }
  | { status: 'deferred'; artifactId: string }
  | { status: 'unavailable' | 'failed'; code: string; message: string }
>;

function presentUserUnavailable(code: string, message = code): PluginActionPresentUserGateResult<never> {
  return Object.freeze({ status: 'unavailable', code, message });
}

function presentUserFailed(code: string, message: string): PluginActionPresentUserGateResult<never> {
  return Object.freeze({ status: 'failed', code, message });
}

function presentUserDeferred(artifactId: string): PluginActionPresentUserGateResult<never> {
  return Object.freeze({ status: 'deferred', artifactId });
}

function isPresentUserResolutionCurrent<TAction>(
  resolution: PluginActionPresentUserGateResolved<TAction>,
): boolean {
  try {
    return resolution.isCurrent?.() !== false;
  } catch {
    return false;
  }
}

function requiresPresentUserIntent(
  policy: PluginActionPresentUserGatePolicy,
  invocationSurface: string,
): boolean {
  // A host-stamped Ask-first setting is explicit user policy and must not be
  // bypassed merely because the caller is a Plugin. If no current-intent
  // requester is available, the gate fails closed rather than executing.
  if (policy.approvalRequiredByActionSettings === true) return true;

  // Plugin/background execution otherwise has no present user to ask. Every
  // other execution realm must bind a non-safe Action to one live decision.
  return invocationSurface !== 'plugin'
    && invocationSurface !== 'background'
    && (
      policy.dangerLevel !== 'safe'
      || policy.confirmation !== undefined
    );
}

function evaluatePresentUserPolicy(
  policy: PluginActionPresentUserGatePolicy,
  args: Readonly<{ surface: string; invocationSurface: string; sessionId?: string }>,
): Readonly<{ outcome: 'visible' | 'disabled' | 'denied' | 'unavailable'; code: string; requiresCurrentIntent: boolean }> {
  const requiresCurrentIntent = requiresPresentUserIntent(policy, args.invocationSurface);
  if (!policy.surfaces.includes(args.surface)) {
    return Object.freeze({
      outcome: 'unavailable',
      code: 'plugin_action_surface_unavailable',
      requiresCurrentIntent,
    });
  }
  if (policy.scopes.includes('session') && !args.sessionId) {
    return Object.freeze({
      outcome: 'unavailable',
      code: 'plugin_action_session_required',
      requiresCurrentIntent,
    });
  }
  return evaluatePluginActionPolicy({
    ...policy.authorization,
    ...(policy.availability === undefined ? {} : { availability: policy.availability }),
    confirmation: requiresCurrentIntent ? 'currentIntentRequired' : 'notRequired',
  });
}

export function fingerprintPluginActionCurrentIntent(params: Readonly<{
  policy: PluginActionPresentUserGatePolicy;
  input: unknown;
  surface: string;
  invocationSurface: string;
  sessionId?: string;
}>): string {
  return computeCanonicalDomainSeparatedHexDigest(
    'happier.plugin-action.current-intent.v1',
    [createCanonicalJsonSigningInput({
      qualifiedId: params.policy.qualifiedId,
      generation: params.policy.generation,
      inputPresent: params.input !== undefined,
      ...(params.input === undefined ? {} : { input: params.input }),
      surface: params.surface,
      invocationSurface: params.invocationSurface,
      ...(params.sessionId === undefined ? {} : { sessionId: params.sessionId }),
      dangerLevel: params.policy.dangerLevel,
      scopes: params.policy.scopes,
      surfaces: params.policy.surfaces,
      ...(params.policy.confirmation === undefined
        ? {}
        : { confirmation: params.policy.confirmation }),
      ...(params.policy.approvalRequiredByActionSettings === true
        ? { approvalRequiredByActionSettings: true }
        : {}),
      ...(params.policy.availability === undefined
        ? {}
        : { availability: params.policy.availability }),
      authorization: params.policy.authorization,
      ...(params.policy.fingerprintContext === undefined
        ? {}
        : { fingerprintContext: params.policy.fingerprintContext }),
    })],
  );
}

/**
 * One realm-neutral current-intent gate for Action execution. It owns policy
 * admission, consent binding, cancellation, and the mandatory fresh resolve /
 * policy / fingerprint pass after approval; leaves own only realm-specific
 * selection and execution.
 */
export function createPluginActionPresentUserGate<TAction>(deps: Readonly<{
  resolve: () => PluginActionPresentUserGateResolution<TAction> | Promise<PluginActionPresentUserGateResolution<TAction>>;
  requestCurrentIntent?: (request: PluginActionCurrentIntentRequest<TAction>) => Promise<PluginActionCurrentIntentResult>;
}>): Readonly<{
  admit(args: Readonly<{
    input: unknown;
    surface: string;
    invocationSurface: string;
    sessionId?: string;
    signal?: AbortSignal;
    /** Host-only replay fence for an already-approved durable intent. */
    requireCurrentIntent?: true;
  }>): Promise<PluginActionPresentUserGateResult<TAction>>;
}> {
  const resolve = async (): Promise<PluginActionPresentUserGateResolution<TAction>> => {
    try {
      return await deps.resolve();
    } catch {
      return Object.freeze({
        status: 'unavailable' as const,
        code: 'plugin_action_selection_unavailable',
      });
    }
  };
  const readResolved = async (): Promise<PluginActionPresentUserGateResolved<TAction> | PluginActionPresentUserGateResult<TAction>> => {
    const resolution = await resolve();
    if (resolution.status === 'failed') return presentUserFailed(resolution.code, resolution.message);
    if (resolution.status === 'unavailable') return presentUserUnavailable(resolution.code, resolution.message);
    if (!isPresentUserResolutionCurrent(resolution)) {
      return presentUserUnavailable('plugin_action_generation_retired');
    }
    return resolution;
  };

  return Object.freeze({
    async admit(args) {
      if (args.signal?.aborted) return presentUserUnavailable('plugin_action_aborted');
      const initial = await readResolved();
      if ('status' in initial && initial.status !== 'resolved') return initial;
      const initialPolicy = evaluatePresentUserPolicy(initial.policy, args);
      if (initialPolicy.outcome !== 'visible') return presentUserUnavailable(initialPolicy.code);
      const requiresCurrentIntent = args.requireCurrentIntent === true
        || initialPolicy.requiresCurrentIntent;
      if (!requiresCurrentIntent) {
        return Object.freeze({ status: 'admitted' as const, action: initial.action });
      }

      const requestCurrentIntent = deps.requestCurrentIntent;
      if (!requestCurrentIntent) return presentUserUnavailable('plugin_action_current_intent_unavailable');
      let fingerprint: string;
      try {
        fingerprint = fingerprintPluginActionCurrentIntent({
          policy: initial.policy,
          input: args.input,
          surface: args.surface,
          invocationSurface: args.invocationSurface,
          ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        });
      } catch {
        return presentUserUnavailable('plugin_action_current_intent_unavailable');
      }
      let intent: PluginActionCurrentIntentResult;
      try {
        intent = await requestCurrentIntent({
          action: initial.action,
          fingerprint,
          surface: args.surface,
          invocationSurface: args.invocationSurface,
          ...(args.signal === undefined ? {} : { signal: args.signal }),
        });
      } catch {
        return args.signal?.aborted
          ? presentUserUnavailable('plugin_action_aborted')
          : presentUserUnavailable('plugin_action_current_intent_unavailable');
      }
      if (args.signal?.aborted) return presentUserUnavailable('plugin_action_aborted');
      if (!isPresentUserResolutionCurrent(initial)) {
        return presentUserUnavailable('plugin_action_generation_retired');
      }
      if (intent.status === 'deferred') {
        const artifactId = intent.artifactId.trim();
        return args.invocationSurface === 'api' && artifactId.length > 0
          ? presentUserDeferred(artifactId)
          : presentUserUnavailable('plugin_action_current_intent_unavailable');
      }
      if (intent.status !== 'approved') return presentUserUnavailable(intent.code);
      if (intent.fingerprint !== fingerprint) {
        return presentUserUnavailable('plugin_action_current_intent_mismatch');
      }

      const current = await readResolved();
      if ('status' in current && current.status !== 'resolved') return current;
      const currentPolicy = evaluatePresentUserPolicy(current.policy, args);
      if (currentPolicy.outcome !== 'visible') return presentUserUnavailable(currentPolicy.code);
      let currentFingerprint: string;
      try {
        currentFingerprint = fingerprintPluginActionCurrentIntent({
          policy: current.policy,
          input: args.input,
          surface: args.surface,
          invocationSurface: args.invocationSurface,
          ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        });
      } catch {
        return presentUserUnavailable('plugin_action_current_intent_unavailable');
      }
      if (currentFingerprint !== fingerprint) {
        return presentUserUnavailable('plugin_action_current_intent_mismatch');
      }
      return Object.freeze({ status: 'admitted' as const, action: current.action });
    },
  });
}

export function createPluginActionInvocation(params: Readonly<{
  pluginId: string;
  localId: string;
  inputSchema?: object;
  inputParser?: PluginActionInputParser;
  resultSchema?: object;
  resultParser?: PluginActionResultParser;
  generationSignal: AbortSignal;
  isCurrent(): boolean;
}>): Readonly<{
  qualifiedId: string;
  invoke(input: unknown, options: Readonly<{
    signal?: AbortSignal;
    /** Host-only admission that runs after input validation, before handler effects. */
    preDispatch?(input: PluginActionInvocationHandlerInput): (
      | PluginActionInvocationPreDispatchResult
      | null
      | Promise<PluginActionInvocationPreDispatchResult | null>
    );
    handler(input: PluginActionInvocationHandlerInput): unknown | Promise<unknown>;
  }>): Promise<PluginActionInvocationResult>;
}> {
  const qualifiedId = formatQualifiedPluginActionId({
    pluginId: params.pluginId,
    localId: params.localId,
  });
  const inputValidator = compileSchema(params.inputSchema);
  const resultValidator = compileSchema(params.resultSchema);
  const inputParser = params.inputParser ?? rehydrateActionParser(params.inputSchema);
  const resultParser = params.resultParser ?? rehydrateActionParser(params.resultSchema);

  return Object.freeze({
    qualifiedId,
    async invoke(input, options) {
      if (!params.isCurrent() || params.generationSignal.aborted) {
        return unavailableBeforeHandler('plugin_action_generation_retired', 'Plugin action generation is no longer current');
      }
      if (options.signal?.aborted) {
        return unavailableBeforeHandler('plugin_action_aborted', 'Plugin action invocation was aborted');
      }
      const parsedInput = AgentRuntimeJsonValueV1Schema.safeParse(input);
      if (!parsedInput.success) return invalidInput;
      let normalizedInput = parsedInput.data;
      if (inputParser) {
        let semanticResult: PluginActionInputParserResult;
        try {
          semanticResult = inputParser(parsedInput.data);
        } catch {
          return inputSchemaProjectionMismatch;
        }
        if (!semanticResult.success) {
          return invalidInputFromParserIssues(semanticResult.issues);
        }
        const parsedNormalizedInput = AgentRuntimeJsonValueV1Schema.safeParse(semanticResult.data);
        if (!parsedNormalizedInput.success) return inputSchemaProjectionMismatch;
        normalizedInput = parsedNormalizedInput.data;
      }
      if (!validates(inputValidator, normalizedInput)) {
        return inputParser ? inputSchemaProjectionMismatch : invalidInput;
      }

      const linked = linkAbortSignals(params.generationSignal, options.signal);
      try {
        const handlerInput = Object.freeze({
          input: normalizedInput,
          qualifiedId,
          signal: linked.signal,
        });
        const preDispatch = options.preDispatch;
        if (preDispatch) {
          const settlement = await awaitPluginActionHandlerSettlementOrAbort(
            linked.signal,
            () => preDispatch(handlerInput),
          );
          if (settlement.kind === 'aborted') {
            const abortSource = linked.abortSource();
            if (abortSource === 'caller') {
              return unavailableBeforeHandler('plugin_action_aborted', 'Plugin action invocation was aborted');
            }
            if (abortSource === 'generation' || !params.isCurrent() || params.generationSignal.aborted) {
              return unavailableBeforeHandler('plugin_action_generation_retired', 'Plugin action generation retired before dispatch');
            }
            return unavailableBeforeHandler('plugin_action_aborted', 'Plugin action invocation was aborted');
          }
          if (settlement.kind === 'rejected') {
            if (!params.isCurrent() || params.generationSignal.aborted) {
              return unavailableBeforeHandler('plugin_action_generation_retired', 'Plugin action generation retired before dispatch');
            }
            if (linked.signal.aborted) {
              return unavailableBeforeHandler('plugin_action_aborted', 'Plugin action invocation was aborted');
            }
            return unavailableBeforeHandler(
              'plugin_action_pre_dispatch_unavailable',
              'Plugin action invocation could not be admitted',
            );
          }
          if (!params.isCurrent() || params.generationSignal.aborted) {
            return unavailableBeforeHandler('plugin_action_generation_retired', 'Plugin action generation retired before dispatch');
          }
          const result = readPreDispatchUnavailableResult(settlement.value);
          if (result) return unavailableBeforeHandler(result.code, result.message);
          if (settlement.value !== null) {
            return unavailableBeforeHandler(
              'plugin_action_pre_dispatch_unavailable',
              'Plugin action invocation could not be admitted',
            );
          }
        }
        let actionHandlerStarted = false;
        const settlement = await awaitPluginActionHandlerSettlementOrAbort(
          linked.signal,
          () => {
            actionHandlerStarted = true;
            return options.handler(handlerInput);
          },
        );
        if (settlement.kind === 'aborted') {
          const unavailableAfterCancellation = actionHandlerStarted
            ? unavailable
            : unavailableBeforeHandler;
          const abortSource = linked.abortSource();
          if (abortSource === 'caller') {
            return unavailableAfterCancellation('plugin_action_aborted', 'Plugin action invocation was aborted');
          }
          if (abortSource === 'generation' || !params.isCurrent() || params.generationSignal.aborted) {
            return unavailableAfterCancellation('plugin_action_generation_retired', 'Plugin action generation retired during execution');
          }
          return unavailableAfterCancellation('plugin_action_aborted', 'Plugin action invocation was aborted');
        }
        if (settlement.kind === 'rejected') {
          const error = settlement.error;
          // A rejected handler settlement also already won the cancellation race.
          // Retirement afterwards cannot erase a known canonical failure.
          const pluginError = readPluginError(error);
          if (pluginError) {
            return Object.freeze({
              status: 'failed',
              code: pluginError.code,
              message: pluginError.message,
              retryable: pluginError.retryable,
              ...(pluginError.data === undefined ? {} : { data: pluginError.data }),
            });
          }
          return Object.freeze({
            status: 'failed',
            code: PLUGIN_ACTION_FAILURE_FALLBACK_CODE,
            message: projectPluginActionFailureMessage(
              error instanceof Error ? error.message : 'Plugin action execution failed',
            ),
          });
        }
        const value = settlement.value;
        // A fulfilled handler settlement already won the cancellation race.
        // Retirement afterwards cannot rewrite that known effect as unavailable,
        // or callers may blindly retry a mutation that already ran.
        const rawResult = value === undefined ? null : value;
        const parsedResult = AgentRuntimeJsonValueV1Schema.safeParse(rawResult);
        if (!parsedResult.success) return invalidResult('Plugin action result must be JSON-safe');
        let normalizedResult = parsedResult.data;
        if (resultParser) {
          let semanticResult: PluginActionInputParserResult;
          try {
            semanticResult = resultParser(parsedResult.data);
          } catch {
            return resultSchemaProjectionMismatch;
          }
          if (!semanticResult.success) {
            return invalidResult(semanticResult.issues[0]?.message ?? 'Plugin action result does not match its executable result schema');
          }
          const parsedNormalizedResult = AgentRuntimeJsonValueV1Schema.safeParse(semanticResult.data);
          if (!parsedNormalizedResult.success) return resultSchemaProjectionMismatch;
          normalizedResult = parsedNormalizedResult.data;
        }
        if (!validates(resultValidator, normalizedResult)) {
          return resultParser
            ? resultSchemaProjectionMismatch
            : invalidResult('Plugin action result does not match its manifest resultSchema');
        }
        return Object.freeze({ status: 'executed', value: normalizedResult });
      } finally {
        linked.dispose();
      }
    },
  });
}
