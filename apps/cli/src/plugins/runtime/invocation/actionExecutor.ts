import { createHash } from 'node:crypto';
import { createPluginActionPresentUserGate, projectPluginActionFailureCode, projectPluginActionUnavailableOutcomeCode, type PluginActionInputParserIssue, readPluginActionError } from '@happier-dev/protocol/plugins/actions/invocation';
import { ActionOperationCredentialUseV1Schema, type ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ApprovalExecutionV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ApprovalExecutionOriginV1, ApprovalRequesterConfirmationV1, PluginSourceCustodyV1, TargetActionApprovalReplayPlacementV1, PluginActionPresentUserGatePolicy } from '@happier-dev/protocol';
import { isPluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginActionHandlerInvocation } from '@happier-dev/plugin-sdk/actions';
import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';

import {
  projectTargetActionPresentUserAuthorizationFacts,
  type NormalizedTargetActionPolicy,
  type TargetActionAuthorizationFacts,
} from '../policy/evaluate';
import type {
  ResolveTargetActionHostPolicy,
  TargetActionHostAccessRequest,
} from '../hostAccess/resolve';
import { projectPluginFailureText } from '../lifecycle/utils';
import type { PluginInvocationServiceBinding } from './services/types';
import { projectTargetActionDiagnosticIssue, readTargetActionDiagnosticConfidentiality } from './diagnostics';

export type TargetActionExecutionResult = Readonly<
  | { status: 'executed'; value: JsonValue | null }
  | { status: 'deferred'; artifactId: string }
  | {
    status: 'unavailable' | 'invalid' | 'failed';
    code: string;
    message: string;
    issues?: readonly PluginActionInputParserIssue[];
    /** Failures only, and only for a proven canonical PluginError. */
    retryable?: boolean;
    /** Failures only: the target's own published PluginError contract payload. */
    data?: JsonValue;
    /** Present only when the generic Action owner proves the target handler never began. */
    actionHandlerInvocation?: PluginActionHandlerInvocation;
  }
>;

export type ResolvedTargetAction = NormalizedTargetActionPolicy & Readonly<{
  pluginId: string;
  localId: string;
  input: unknown;
  secretInputPaths?: readonly string[];
  secretInputLabels?: Readonly<Record<string, string>>;
  /** Executable declaration captured by the invocation owner, absent on catalog-only facts. */
  pluginVersion?: string;
  inputSchema?: object;
  accountId?: string;
  resourceId?: string;
  /** Durable source authority for replay; live admission remains occurrence-fenced. */
  sourceCustody: PluginSourceCustodyV1;
  policyFingerprint: string;
}>;

/**
 * Builds the one normalized Action policy used by both daemon Action
 * invocation and read-only Action projection. The manifest remains the
 * declaration owner; the supplied host-policy owner resolves its exact
 * HostAccess facts without requiring a daemon handler registration.
 */
export function resolveCatalogTargetActionPolicy(params: Readonly<{
  pluginId: string;
  localId: string;
  occurrenceId: string;
  sourceCustody: PluginSourceCustodyV1;
  dangerLevel: ResolvedTargetAction['dangerLevel'];
  scopes: ResolvedTargetAction['scopes'];
  surfaces: ResolvedTargetAction['surfaces'];
  hostAccessRequests: readonly TargetActionHostAccessRequest[];
  availability?: ResolvedTargetAction['availability'];
  confirmation?: ResolvedTargetAction['confirmation'];
  confirmationWhen?: ResolvedTargetAction['confirmationWhen'];
  resolveHostPolicy: ResolveTargetActionHostPolicy;
}>): ResolvedTargetAction {
  const action = Object.freeze({
    qualifiedId: `${params.pluginId}/actions/${params.localId}`,
    pluginId: params.pluginId,
    localId: params.localId,
    occurrenceId: params.occurrenceId,
    sourceCustody: params.sourceCustody,
    dangerLevel: params.dangerLevel,
    scopes: params.scopes,
    surfaces: params.surfaces,
    hostAccess: params.hostAccessRequests.map(({ request, required }) => ({
      id: request.id,
      required,
      status: 'unavailable' as const,
      code: 'plugin_host_access_context_unavailable',
      requestFingerprint: '',
    })),
    ...(params.availability === undefined ? {} : { availability: params.availability }),
    ...(params.confirmation === undefined ? {} : { confirmation: params.confirmation }),
    ...(params.confirmationWhen === undefined ? {} : { confirmationWhen: params.confirmationWhen }),
    input: null,
    policyFingerprint: '',
  });
  return params.resolveHostPolicy(action, {
    hostAccessRequests: params.hostAccessRequests,
    surface: 'catalog',
  }).action;
}

/** Host-private, content-free diagnosis; never approval operands or exception text. */
export type TargetActionCurrentIntentUnavailableReason =
  | 'installed_account_unavailable' | 'installed_account_retired' | 'approval_factory_unavailable'
  | 'approval_not_required' | 'approval_input_unrepresentable' | 'approval_subject_invalid'
  | 'approval_presentation_unavailable' | 'approval_artifact_create_failed' | 'approval_artifact_id_unavailable';

export type TargetActionCurrentIntentRequest = Readonly<{
  /** Account execution resumes only in the original captured invoking host. */
  approvalInputCustody?: 'live_only';
  action: ResolvedTargetAction;
  fingerprint: string;
  /** Declared target capability surface. */
  surface: string;
  /** Actual host invocation surface that the approval binds. */
  invocationSurface?: string;
  /** Immutable admitting daemon for deferred replay or a live-only decision. */
  replayPlacement?: TargetActionApprovalReplayPlacementV1;
  /** Immutable outer Action authority captured before a deferred decision. */
  executionOriginV1?: ApprovalExecutionOriginV1;
  requesterConfirmation?: ApprovalRequesterConfirmationV1;
  signal?: AbortSignal;
  reportUnavailable?: (reason: TargetActionCurrentIntentUnavailableReason) => void;
}>;

export type TargetActionCurrentIntentResult = Readonly<
  | {
    status: 'approved';
    fingerprint: string;
    /** Durable identity when approval is Artifact-owned. */
    artifactId?: string;
    /** Live ingress proof retained only by the original invocation. */
    revalidateRequesterDecision?: () => Promise<boolean>;
    /** Captured host writer; raw input and handler output never enter this receipt. */
    settleExecution?: (args: Readonly<{
      artifactId: string;
      execution: Pick<ApprovalExecutionV2, 'ok' | 'effectAttempted' | 'errorCode' | 'operationCredentialUses'>;
    }>) => Promise<void>;
  }
  | { status: 'deferred'; artifactId: string }
  | { status: 'rejected' | 'unavailable'; code: string }
>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function fingerprintTargetActionPolicy(action: NormalizedTargetActionPolicy & Readonly<{
  secretInputPaths?: readonly string[];
  secretInputLabels?: Readonly<Record<string, string>>;
  pluginVersion?: string;
  inputSchema?: object;
}>): string {
  return createHash('sha256').update(stable({
    qualifiedId: action.qualifiedId,
    dangerLevel: action.dangerLevel,
    scopes: action.scopes,
    surfaces: action.surfaces,
    hostAccess: action.hostAccess,
    availability: action.availability,
    confirmation: action.confirmation,
    ...(action.confirmationWhen === undefined ? {} : { confirmationWhen: action.confirmationWhen }),
    approvalRequiredByActionSettings: action.approvalRequiredByActionSettings,
    secretInputPaths: action.secretInputPaths ?? [],
    ...(action.secretInputLabels === undefined ? {} : { secretInputLabels: action.secretInputLabels }),
    // Occurrences can repeat after restart. Bind the executable declaration in
    // the existing durable subject as well as its current policy and source.
    pluginVersion: action.pluginVersion,
    inputSchema: action.inputSchema,
  })).digest('hex');
}

function unavailable(code: string): TargetActionExecutionResult {
  return Object.freeze({
    status: 'unavailable',
    code,
    message: code,
    actionHandlerInvocation: 'notStarted',
  });
}

function failed(
  code: string,
  error: unknown,
  actionHandlerInvocation?: PluginActionHandlerInvocation,
): TargetActionExecutionResult {
  const pluginError = readPluginActionError(error);
  return Object.freeze({
    status: 'failed',
    ...(pluginError ?? { code, message: error instanceof Error ? error.message : code }),
    ...(actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation }),
  });
}

/**
 * A target's published failure payload crosses to its caller, so it must not
 * become the one unredacted route out of an invocation whose credential
 * redaction already owns the failure code and message. The same scoped
 * redactor is applied to strings and keys; a redactor failure is
 * caught by the caller, which then withholds the payload entirely.
 *
 * The payload already passed shared Action JSON admission. That carrier has no
 * generic depth quota, so redaction must use an iterative work list rather
 * than treating the JavaScript call stack as a privacy limit.
 */
function redactTargetActionFailureData(
  value: JsonValue,
  redact: (value: string) => string,
  confidentiality?: ReturnType<typeof readTargetActionDiagnosticConfidentiality>,
): JsonValue {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;

  type PendingRedaction =
    | Readonly<{
      kind: 'array';
      source: readonly JsonValue[];
      destination: JsonValue[];
      path: readonly string[];
    }>
    | Readonly<{
      kind: 'record';
      source: Readonly<Record<string, JsonValue>>;
      destination: Record<string, JsonValue>;
      path: readonly string[];
    }>;
  const isJsonArray = (candidate: JsonValue): candidate is readonly JsonValue[] => (
    Array.isArray(candidate)
  );
  const root: PendingRedaction = isJsonArray(value)
    ? { kind: 'array', source: value, destination: [], path: [] }
    : { kind: 'record', source: value, destination: {}, path: [] };
  const pending: PendingRedaction[] = [root];
  const confidentialPaths = new Set(confidentiality?.paths);
  const project = (candidate: JsonValue, path: readonly string[]): JsonValue => {
    // PluginError owns the outer envelope. Only details carry plugin operands;
    // its original paths are checked before keys or text are redacted.
    if (path[0] === 'details' && confidentialPaths.has(path.slice(1).join('.'))) return '[REDACTED]';
    const issue = path[0] === 'details' && confidentiality
      ? projectTargetActionDiagnosticIssue(candidate, confidentiality) : null;
    if (issue) candidate = { path: [...issue.path], code: issue.code, message: issue.message };
    if (typeof candidate === 'string') return redact(candidate);
    if (candidate === null || typeof candidate !== 'object') return candidate;
    if (isJsonArray(candidate)) {
      const next: PendingRedaction = {
        kind: 'array',
        source: candidate,
        destination: [],
        path,
      };
      pending.push(next);
      return next.destination;
    }
    const next: PendingRedaction = {
      kind: 'record',
      source: candidate,
      destination: {},
      path,
    };
    pending.push(next);
    return next.destination;
  };

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (current.kind === 'array') {
      for (let index = 0; index < current.source.length; index += 1) {
        current.destination[index] = project(current.source[index]!, confidentialPaths.size > 0 ? [...current.path, String(index)] : current.path);
      }
      continue;
    }
    for (const [key, candidate] of Object.entries(current.source)) {
      current.destination[redact(key)] = project(candidate, confidentialPaths.size > 0 ? [...current.path, key] : current.path);
    }
  }

  return root.destination;
}

/** One diagnostic projection for parser admission and execution failures. */
export function projectTargetActionFailure(
  result: TargetActionExecutionResult,
  redact?: (value: string) => string,
  confidentialInput?: Readonly<{
    input: unknown;
    secretInputPaths: readonly string[];
    rawConfidentiality?: ReturnType<typeof readTargetActionDiagnosticConfidentiality>;
  }>,
): TargetActionExecutionResult {
  if (result.status === 'executed' || result.status === 'deferred') return result;
  let code = projectPluginActionFailureCode(result.code);
  let message = result.message;
  let data = result.data;
  let issues = result.issues;
  let confidentiality: ReturnType<typeof readTargetActionDiagnosticConfidentiality> | undefined;
  if (confidentialInput) {
    try {
      const classified = readTargetActionDiagnosticConfidentiality(
        confidentialInput.input, confidentialInput.secretInputPaths, confidentialInput.rawConfidentiality,
      );
      confidentiality = classified;
      const { nonStringPaths } = classified;
      issues = issues?.map(issue => projectTargetActionDiagnosticIssue(issue, classified) ?? issue);
      const firstIssue = issues?.[0];
      if (firstIssue && firstIssue !== result.issues?.[0]) message = firstIssue.message;
      if (nonStringPaths.length > 0 && result.code === 'plugin_action_result_schema_invalid' && !result.issues) {
        // The Protocol result parser retains only prose, losing issue provenance.
        // Use its content-free schema failure rather than guessing operand text.
        message = 'Plugin action result does not match its executable result schema';
      }
    } catch {
      code = 'plugin_action_execution_failed';
      message = code;
      data = undefined;
      issues = undefined;
    }
  }
  if (redact || confidentiality) {
    const redactText = redact ?? ((value: string) => value);
    const projected = { code, message, data, issues };
    code = 'plugin_action_execution_failed';
    message = code;
    data = undefined;
    issues = undefined;
    try {
      const redactedCode = redactText(projected.code);
      code = redactedCode === projected.code ? projectPluginActionFailureCode(projected.code) : code;
      message = redactText(projected.message);
      data = projected.data === undefined ? undefined : redactTargetActionFailureData(projected.data, redactText, confidentiality);
      issues = projected.issues?.map(issue => Object.freeze({
        path: Object.freeze(issue.path.map(segment => typeof segment === 'string' ? redactText(segment) : segment)),
        code: redactText(issue.code), message: redactText(issue.message),
        ...(issue.expected === undefined ? {} : { expected: redactText(issue.expected) }),
        ...(issue.acceptedValues === undefined ? {} : {
          acceptedValues: Object.freeze(issue.acceptedValues.map(value => typeof value === 'string' ? redactText(value) : value)),
        }),
      }));
    } catch {
      // A failed scoped redactor cannot disclose a partially projected diagnostic.
      code = 'plugin_action_execution_failed';
      message = code;
      data = undefined;
      issues = undefined;
    }
  }
  return Object.freeze({
    status: result.status, code, message: projectPluginFailureText(new Error(message)),
    ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
    ...(data === undefined ? {} : { data }),
    ...(issues === undefined ? {} : { issues }),
    ...(result.actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation: result.actionHandlerInvocation }),
  });
}

function isCurrentServiceBinding(
  action: ResolvedTargetAction,
  serviceBinding: PluginInvocationServiceBinding,
): boolean {
  return serviceBinding.occurrenceId === action.occurrenceId;
}

function bindResolvedPolicy(action: ResolvedTargetAction): ResolvedTargetAction {
  return Object.freeze({
    ...action,
    policyFingerprint: fingerprintTargetActionPolicy(action),
  });
}

export function resolvePresentUserGatePolicy(
  action: ResolvedTargetAction,
  authorization: TargetActionAuthorizationFacts,
): PluginActionPresentUserGatePolicy {
  return Object.freeze({
    qualifiedId: action.qualifiedId,
    occurrenceId: action.occurrenceId,
    dangerLevel: action.dangerLevel,
    scopes: action.scopes,
    surfaces: action.surfaces,
    ...(action.confirmation === undefined ? {} : { confirmation: action.confirmation }),
    ...(action.confirmationWhen === undefined ? {} : { confirmationWhen: action.confirmationWhen }),
    ...(action.approvalRequiredByActionSettings === undefined
      ? {}
      : { approvalRequiredByActionSettings: action.approvalRequiredByActionSettings }),
    ...(action.availability === undefined ? {} : { availability: action.availability }),
    authorization: Object.freeze(projectTargetActionPresentUserAuthorizationFacts(
      authorization,
      action.hostAccess.map((access) => ({
        id: access.id,
        required: true,
        status: access.status,
        ...(access.code === undefined ? {} : { code: access.code }),
      })),
    )),
    // The Protocol gate already fingerprints normalized policy facts. Preserve
    // the daemon-only binding choices that are not expressed by the generic
    // evaluator so approval cannot authorize a replacement service selection.
    // Exact API replay placement is instead a durable approval-subject field:
    // it is captured only after this gate determines that an approval is
    // needed, then checked again before replay. Including it here would force
    // a materialized execution origin before an Allowed Action can run.
    fingerprintContext: Object.freeze({
      input: action.input,
      accountId: action.accountId ?? null,
      resourceId: action.resourceId ?? null,
      policyFingerprint: action.policyFingerprint,
      hostAccess: action.hostAccess,
    }),
  });
}

export function createTargetActionExecutor(deps: Readonly<{
  resolve: (args: Readonly<{ pluginId: string; localId: string; input: unknown }>) => ResolvedTargetAction | null;
  resolveAuthorizationFacts: (action: ResolvedTargetAction) => TargetActionAuthorizationFacts;
  resolveHostBinding: (action: ResolvedTargetAction) => Promise<Readonly<{
    action: ResolvedTargetAction;
    serviceBinding: PluginInvocationServiceBinding;
  }> | null>;
  requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
  invoke: (action: ResolvedTargetAction, args: Readonly<{ surface: string; sessionId?: string; signal?: AbortSignal;
    recordOperationCredentialUse?: (use: ActionOperationCredentialUseV1) => void;
  }>, serviceBinding: PluginInvocationServiceBinding) => Promise<TargetActionExecutionResult>;
  redactFailureText?: (action: ResolvedTargetAction, value: string) => string;
  /** Captured before executable normalization can consume confidential operands. */
  rawDiagnosticConfidentiality?: ReturnType<typeof readTargetActionDiagnosticConfidentiality>;
  diagnostic?: (fact: Readonly<{ qualifiedId: string; occurrenceId: string; surface: string; status: string; code?: string }>) => void | Promise<void>;
}>) {
  type ExecuteArgs = Readonly<{
    pluginId: string;
    localId: string;
    input: unknown;
    surface: string;
    invocationSurface?: string;
    invocationAuthority?: ActionRequiredAuthority;
    sessionId?: string;
    signal?: AbortSignal;
    /** Immutable replay subject injected only by the host dispatcher. */
    replayPlacement?: TargetActionApprovalReplayPlacementV1;
    /** Revalidate a persisted approval even if current policy no longer asks. */
    requireCurrentIntent?: true;
    requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
  }>;

  const prepare = async (args: ExecuteArgs): Promise<Readonly<
    | { kind: 'settled'; result: TargetActionExecutionResult }
    | { kind: 'ready'; run: () => Promise<TargetActionExecutionResult> }
  >> => {
      let action: ResolvedTargetAction | null = null;
      let approvalArtifactId: string | undefined;
      let settleExecution: Extract<TargetActionCurrentIntentResult, { status: 'approved' }>['settleExecution'];
      const operationCredentialUses: ActionOperationCredentialUseV1[] = [];
      let observingCredentialUse = true;
      const recordOperationCredentialUse = (use: ActionOperationCredentialUseV1) => {
        if (!observingCredentialUse) return;
        const parsed = ActionOperationCredentialUseV1Schema.safeParse(use);
        if (parsed.success && !operationCredentialUses.some(existing => sameStrictJsonValue(existing, parsed.data))) {
          operationCredentialUses.push(parsed.data);
        }
      };
      const invocationSurface = args.invocationSurface ?? args.surface;
      const finish = async (result: TargetActionExecutionResult): Promise<TargetActionExecutionResult> => {
        const redactedAction = action;
        const redactFailureText = deps.redactFailureText;
        const publicResult = projectTargetActionFailure(result, redactedAction && redactFailureText
          ? value => redactFailureText(redactedAction, value) : undefined,
          redactedAction ? {
            input: redactedAction.input,
            secretInputPaths: redactedAction.secretInputPaths ?? [],
            rawConfidentiality: deps.rawDiagnosticConfidentiality,
          } : undefined);
        try {
          await deps.diagnostic?.({
            qualifiedId: action?.qualifiedId ?? `${args.pluginId}/actions/${args.localId}`,
            occurrenceId: action?.occurrenceId ?? 'unavailable',
            surface: args.surface, status: publicResult.status, ...('code' in publicResult ? { code: publicResult.code } : {}),
          });
        } catch { /* Diagnostics are failure-isolated from authorization and execution. */ }
        observingCredentialUse = false;
        if (settleExecution && approvalArtifactId && publicResult.status !== 'deferred') {
          const errorCode = publicResult.status === 'executed' ? undefined
            : publicResult.status === 'unavailable'
              ? projectPluginActionUnavailableOutcomeCode(publicResult.code, publicResult.actionHandlerInvocation)
              : publicResult.code;
          try {
            await settleExecution({ artifactId: approvalArtifactId, execution: {
              ok: publicResult.status === 'executed',
              effectAttempted: publicResult.status === 'executed' || publicResult.actionHandlerInvocation !== 'notStarted',
              ...(errorCode === undefined ? {} : { errorCode }),
              ...(operationCredentialUses.length ? { operationCredentialUses } : {}),
            } });
          } catch {
            // The effect may have finished before its receipt acknowledgement
            // was lost. Never retry the live operands or claim nonexecution.
            return Object.freeze({ status: 'failed', code: 'approval_execution_outcome_unknown', message: 'approval_execution_outcome_unknown' });
          }
        }
        return publicResult;
      };
      const gate = createPluginActionPresentUserGate<Readonly<{
        action: ResolvedTargetAction;
        serviceBinding: PluginInvocationServiceBinding;
      }>>({
        resolve: async () => {
          let resolved: ResolvedTargetAction | null;
          try {
            resolved = deps.resolve(args);
          } catch (error) {
            return Object.freeze({
              status: 'failed' as const,
              code: isPluginError(error) ? error.code : 'plugin_action_selection_failed',
              message: error instanceof Error ? error.message : 'plugin_action_selection_failed',
            });
          }
          if (!resolved) {
            return Object.freeze({
              status: 'unavailable' as const,
              code: 'plugin_action_handler_missing',
            });
          }
          action = resolved;
          let binding: Readonly<{
            action: ResolvedTargetAction;
            serviceBinding: PluginInvocationServiceBinding;
          }> | null;
          try {
            binding = await deps.resolveHostBinding(resolved);
          } catch (error) {
            return Object.freeze({
              status: 'failed' as const,
              code: isPluginError(error) ? error.code : 'plugin_action_selection_failed',
              message: error instanceof Error ? error.message : 'plugin_action_selection_failed',
            });
          }
          if (!binding) {
            return Object.freeze({
              status: 'unavailable' as const,
              code: 'plugin_action_selection_unavailable',
            });
          }
          const boundAction = bindResolvedPolicy(binding.action);
          action = boundAction;
          if (!isCurrentServiceBinding(boundAction, binding.serviceBinding)) {
            return Object.freeze({
              status: 'unavailable' as const,
              code: 'plugin_action_generation_retired',
            });
          }
          return Object.freeze({
            status: 'resolved' as const,
            action: Object.freeze({ action: boundAction, serviceBinding: binding.serviceBinding }),
            policy: resolvePresentUserGatePolicy(
              boundAction,
              deps.resolveAuthorizationFacts(boundAction),
            ),
            isCurrent: () => isCurrentServiceBinding(boundAction, binding.serviceBinding),
          });
        },
        ...(args.requestCurrentIntent || deps.requestCurrentIntent
          ? {
            requestCurrentIntent: async (request) => {
              const intent = await (args.requestCurrentIntent ?? deps.requestCurrentIntent)!({
                action: request.action.action,
                fingerprint: request.fingerprint,
                surface: request.surface,
                invocationSurface: request.invocationSurface,
                ...(args.replayPlacement === undefined
                  ? {}
                  : { replayPlacement: args.replayPlacement }),
                ...(request.signal === undefined ? {} : { signal: request.signal }),
              });
              if (intent.status === 'approved' && intent.fingerprint === request.fingerprint) {
                approvalArtifactId = intent.artifactId;
                settleExecution = intent.settleExecution;
              }
              return intent;
            },
          }
          : {}),
      });
      const admission = await gate.admit({
        input: args.input,
        surface: args.surface,
        invocationSurface,
        ...(args.invocationAuthority === undefined ? {} : { invocationAuthority: args.invocationAuthority }),
        ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
        ...(args.requireCurrentIntent === true ? { requireCurrentIntent: true as const } : {}),
      });
      if (admission.status !== 'admitted') {
        if (admission.status === 'failed') {
          return Object.freeze({
            kind: 'settled' as const,
            result: await finish(failed(admission.code, new Error(admission.message), 'notStarted')),
          });
        }
        if (admission.status === 'deferred') {
          return Object.freeze({
            kind: 'settled' as const,
            result: Object.freeze({ status: 'deferred' as const, artifactId: admission.artifactId }),
          });
        }
        return Object.freeze({
          kind: 'settled' as const,
          result: await finish(unavailable(admission.code)),
        });
      }
      const { action: admittedAction, serviceBinding } = admission.action;
      action = admittedAction;
      if (settleExecution && admission.artifactId !== approvalArtifactId) {
        return Object.freeze({ kind: 'settled' as const, result: await finish(unavailable('plugin_action_current_intent_mismatch')) });
      }
      approvalArtifactId = admission.artifactId;
      let runPromise: Promise<TargetActionExecutionResult> | null = null;
      const run = (): Promise<TargetActionExecutionResult> => {
        if (runPromise) return runPromise;
        runPromise = (async () => {
          if (args.signal?.aborted) return await finish(unavailable('plugin_action_aborted'));
          let result: TargetActionExecutionResult;
          try {
            result = await deps.invoke(admittedAction, {
              surface: args.surface,
              ...(args.sessionId ? { sessionId: args.sessionId } : {}),
              ...(args.signal ? { signal: args.signal } : {}),
              ...(settleExecution ? { recordOperationCredentialUse } : {}),
            }, serviceBinding);
          } catch (error) {
            result = failed('plugin_action_execution_failed', error);
          }
          return await finish(result);
        })();
        return runPromise;
      };
      return Object.freeze({ kind: 'ready' as const, run });
  };

  return Object.freeze({
    prepare,
    async execute(args: ExecuteArgs): Promise<TargetActionExecutionResult> {
      const prepared = await prepare(args);
      return prepared.kind === 'settled' ? prepared.result : await prepared.run();
    },
  });
}
