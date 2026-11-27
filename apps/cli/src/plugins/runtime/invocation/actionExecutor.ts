import { createHash } from 'node:crypto';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { logExternalActionCurrentIntentMismatch } from '@/daemon/externalActions/externalActionPhase';
import { createPluginActionPresentUserGate, pluginActionRequiresPresentUserIntent, readPluginActionError } from '@happier-dev/protocol/plugins/actions/invocation';
import { createApprovalAutomaticChecksV1 } from '@happier-dev/protocol/actions/executor/automaticApprovalContinuation';
import type { ApprovalAutomaticChecksV1 } from '@happier-dev/protocol/approvals/approvalAutomaticChecks';
import { readCurrentIntentMismatchFieldV1, type CurrentIntentMismatchV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { projectPluginFailureMessage } from '@happier-dev/protocol/plugins/failureProjection';
import { ActionFailureCauseV1Schema, ActionOperationCredentialUseV1Schema, projectApprovalExecutionOutcomeUnknownV1, type ActionFailureCauseV1, type ActionOperationCredentialUseV1, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ApprovalExecutionV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { ActionActorV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { sameStrictJsonValue, StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecutorContext, ApprovalExecutionOriginV1, ApprovalRequesterConfirmationV1, PluginSourceCustodyV1, TargetActionApprovalReplayPlacementV1, PluginActionPresentUserGatePolicy } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';
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
import type { PluginInvocationServiceBinding } from './services/types';
import { readTargetActionDiagnosticConfidentiality } from './diagnostics';
import { projectTargetActionFailure, readTargetActionProjectionCollapseCause, type TargetActionExecutionResult } from '@happier-dev/cli-common/plugins/registration';
import { projectContributedActionFailure } from './actions/contributedActionFailure';
export { projectTargetActionFailure, type TargetActionExecutionResult } from '@happier-dev/cli-common/plugins/registration';

export type ResolvedTargetAction = NormalizedTargetActionPolicy & Readonly<{
  pluginId: string;
  localId: string;
  input: unknown;
  secretInputPaths?: readonly string[];
  secretInputLabels?: Readonly<Record<string, string>>;
  /** Executable declaration captured by the invocation owner, absent on catalog-only facts. */
  pluginVersion?: string;
  inputSchema?: object;
  /** Canonical admitted Action declaration; excludes implementation/build identity. */
  declaration?: object;
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
  /** Host-private snapshot and ports retained by the incumbent approval owner. */
  automaticChecks?: ApprovalAutomaticChecksV1;
  automationContext?: ActionExecutorContext;
  /** Private live inputs resume only in their original captured invoking host. */
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
  /** Host-private: a daemon-held operation reports its live-only Ask before the person decides. */
  onLiveApprovalRequested?: (artifactId: string) => void | Promise<void>;
}>;

export type TargetActionCurrentIntentResult = Pick<ActionExecuteResult, 'automationNotices'> & Readonly<
  | {
    status: 'approved';
    fingerprint: string;
    /** Durable identity when approval is Artifact-owned. */
    artifactId?: string;
    /** Witnessed approval identity; null preserves an anonymous historical decision. */
    actor?: ActionActorV1 | null;
    /** Captured host writer for the caller-visible outcome. */
    settleExecution?: (args: Readonly<{
      artifactId: string;
      execution: Omit<ApprovalExecutionV2, 'executedAtMs'>;
    }>) => Promise<void>;
  }
  | { status: 'deferred'; artifactId: string }
  | { status: 'rejected' | 'unavailable'; code: string; mismatch?: CurrentIntentMismatchV1 }
>;

type TargetActionHostExecutionResult = TargetActionExecutionResult & Pick<ActionExecuteResult, 'automationNotices'>;

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
  declaration?: object;
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
    // Historical admission provenance; this is not compared again after approval.
    inputSchema: action.inputSchema,
    declaration: action.declaration,
  })).digest('hex');
}

function unavailable(code: string, data?: JsonValue): TargetActionExecutionResult {
  return Object.freeze({
    status: 'unavailable',
    code,
    message: code,
    actionHandlerInvocation: 'notStarted',
    ...(data === undefined ? {} : { data }),
  });
}

/** The wrapped handler's Protocol-projected cause; only its closed schema fields reach a diagnostic. */
function readDiagnosticFailureCause(result: TargetActionExecutionResult): Readonly<{ failureCause: ActionFailureCauseV1 }> | Record<string, never> {
  if (result.status !== 'failed' && result.status !== 'unavailable') return {};
  const data = 'data' in result ? result.data : undefined;
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? (data as Readonly<Record<string, unknown>>).failureCause : undefined;
  const parsed = raw === undefined ? null : ActionFailureCauseV1Schema.safeParse(raw);
  return parsed?.success ? { failureCause: parsed.data } : {};
}

/** Closed, content-free facts naming an untyped handler throw for the failure diagnostic only. */
type UntypedFailureCause = Readonly<{ causeClass: string; causeCode?: string }>;
const untypedFailureCauses = new WeakMap<object, UntypedFailureCause>();
const CAUSE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;

function failed(
  code: string,
  error: unknown,
  actionHandlerInvocation?: PluginActionHandlerInvocation,
) {
  const pluginError = readPluginActionError(error);
  const result = Object.freeze({
    status: 'failed',
    ...(pluginError ?? { code, message: error instanceof Error ? error.message : code }),
    ...(actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation }),
  });
  if (!pluginError) {
    const name = error instanceof Error ? error.name : typeof error;
    const errorCode = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code : undefined;
    untypedFailureCauses.set(result, { causeClass: CAUSE_IDENTIFIER.test(name) ? name : 'Error',
      ...(errorCode && CAUSE_IDENTIFIER.test(errorCode) ? { causeCode: errorCode } : {}) });
  }
  return result;
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
    /** The gate admitted these exact operands as a host-reviewed child. */
    reviewedChild?: true;
  }>, serviceBinding: PluginInvocationServiceBinding) => Promise<TargetActionExecutionResult>;
  /** Projects failures and, with `purpose: 'result'`, successful values. */
  redactFailureText?: (action: ResolvedTargetAction, value: string, purpose?: 'result') => string;
  /** In-process host consumer: return the executed value unredacted as native operands. */
  hostConsumesExecutedValue?: true;
  /** Captured before executable normalization can consume confidential operands. */
  rawDiagnosticConfidentiality?: ReturnType<typeof readTargetActionDiagnosticConfidentiality>;
  diagnostic?: (fact: Readonly<{ qualifiedId: string; occurrenceId: string; surface: string; status: string; code?: string;
    /** An untyped handler throw: its class and identifier-like code, never its message or data. */
    causeClass?: string; causeCode?: string;
    /** Redaction replaced the handler's code with the stable generic code. */
    projectionCollapsed?: true;
    /** The handler wrapper's closed cause (phase, class, code), already projected by the Protocol owner. */
    failureCause?: ActionFailureCauseV1 }>) => void | Promise<void>;
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
    /** Require consent for this admission even when the initial policy does not ask. */
    requireCurrentIntent?: true;
    approvalContext?: ActionExecutorContext;
    requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
  }>;

  const prepare = async (args: ExecuteArgs): Promise<Readonly<
    | { kind: 'settled'; result: TargetActionHostExecutionResult }
    | { kind: 'ready'; actor?: ActionActorV1 | null; run: () => Promise<TargetActionHostExecutionResult> }
  >> => {
      let action: ResolvedTargetAction | null = null;
      let approvalArtifactId: string | undefined;
      let actor: ActionActorV1 | null | undefined;
      let automationNotices: ActionExecuteResult['automationNotices'];
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
      const finish = async (result: TargetActionExecutionResult): Promise<TargetActionHostExecutionResult> => {
        if (result.status === 'unavailable' && result.code === 'plugin_action_current_intent_mismatch') {
          // Emit only the owner's closed category, never either compared value or plugin-authored data.
          const field = readCurrentIntentMismatchFieldV1(readRecord(readRecord(readRecord(result.data).details).currentIntentMismatch).field);
          if (field) logExternalActionCurrentIntentMismatch(field);
        }
        const redactedAction = action;
        const redactFailureText = deps.redactFailureText;
        const publicResult = result.status === 'executed' && deps.hostConsumesExecutedValue
          ? result
          : projectTargetActionFailure(result, redactedAction && redactFailureText
          ? value => redactFailureText(redactedAction, value, result.status === 'executed' ? 'result' : undefined)
          : result.status === 'failed' ? projectPluginFailureMessage : undefined,
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
            ...untypedFailureCauses.get(result),
            ...readTargetActionProjectionCollapseCause(publicResult),
            ...readDiagnosticFailureCause(publicResult),
            ...(readTargetActionProjectionCollapseCause(publicResult) || ('code' in result && 'code' in publicResult
              && result.code !== publicResult.code && publicResult.code === 'plugin_action_execution_failed')
              ? { projectionCollapsed: true as const } : {}),
          });
        } catch { /* Diagnostics are failure-isolated from authorization and execution. */ }
        observingCredentialUse = false;
        if (settleExecution && approvalArtifactId && publicResult.status !== 'deferred') {
          // The caller can receive private operands. The approval Artifact
          // gets the result only when those operands were absent.
          const resultIsPrivate = deps.hostConsumesExecutedValue || deps.rawDiagnosticConfidentiality?.paths.length;
          const execution = publicResult.status === 'executed'
            ? { ok: true as const, ...(resultIsPrivate ? {} : { result: publicResult.value }) }
            : projectContributedActionFailure({ ...publicResult, errorCode: publicResult.code, error: publicResult.message });
          try {
            await settleExecution({ artifactId: approvalArtifactId, execution: {
              ...execution, ...(operationCredentialUses.length ? { operationCredentialUses } : {}),
            } });
          } catch {
            // The effect may have finished before its receipt acknowledgement
            // was lost. Never retry the live operands or claim nonexecution.
            const failure = projectApprovalExecutionOutcomeUnknownV1(execution.ok ? undefined : execution);
            const details = StrictJsonValueSchema.safeParse(failure.requestId === undefined
              ? failure.details : { ...readRecord(failure.details), requestId: failure.requestId });
            return Object.freeze({
              status: 'failed', code: failure.errorCode, message: failure.error,
              ...(details.success || failure.failureCause || failure.effectAttempted === true ? { data: {
                ...(details.success ? { details: details.data } : {}),
                ...(failure.failureCause ? { failureCause: failure.failureCause } : {}),
                ...(failure.effectAttempted === true ? { effectAttempted: true } : {}),
              } } : {}),
            });
          }
        }
        return automationNotices ? { ...publicResult, automationNotices } : publicResult;
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
            return failed('plugin_action_selection_failed', error);
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
            return failed('plugin_action_selection_failed', error);
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
                ...(args.approvalContext?.actionAutomationAdmission ? {
                  automaticChecks: createApprovalAutomaticChecksV1(args.approvalContext.actionAutomationAdmission.selection,
                    !request.reviewedChild && pluginActionRequiresPresentUserIntent(request.action.action, invocationSurface, args.input, args.invocationAuthority)),
                  automationContext: args.approvalContext,
                } : {}),
                ...(args.replayPlacement === undefined
                  ? {}
                  : { replayPlacement: args.replayPlacement }),
                ...(request.signal === undefined ? {} : { signal: request.signal }),
              });
              automationNotices = intent.automationNotices;
              if (intent.status === 'approved' && intent.fingerprint === request.fingerprint) {
                approvalArtifactId = intent.artifactId;
                actor = intent.actor;
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
        ...(args.approvalContext ? { reviewedChildContext: args.approvalContext } : {}),
      });
      if (admission.status !== 'admitted') {
        if (admission.status === 'failed') {
          return Object.freeze({
            kind: 'settled' as const,
            result: await finish({ ...admission, actionHandlerInvocation: 'notStarted' }),
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
          result: await finish(unavailable(admission.code, admission.data)),
        });
      }
      const { action: admittedAction, serviceBinding } = admission.action;
      action = admittedAction;
      if (settleExecution && admission.artifactId !== approvalArtifactId) {
        return Object.freeze({ kind: 'settled' as const, result: await finish(unavailable('plugin_action_current_intent_mismatch',
          { details: { currentIntentMismatch: { field: 'binding' } } })) });
      }
      approvalArtifactId = admission.artifactId;
      let runPromise: Promise<TargetActionHostExecutionResult> | null = null;
      const run = (): Promise<TargetActionHostExecutionResult> => {
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
              ...(admission.reviewedChild ? { reviewedChild: true as const } : {}),
            }, serviceBinding);
          } catch (error) {
            result = failed('plugin_action_execution_failed', error);
          }
          return await finish(result);
        })();
        return runPromise;
      };
      return Object.freeze({ kind: 'ready' as const, ...(actor === undefined ? {} : { actor }), run });
  };

  return Object.freeze({
    prepare,
    async execute(args: ExecuteArgs): Promise<TargetActionHostExecutionResult> {
      const prepared = await prepare(args);
      return prepared.kind === 'settled' ? prepared.result : await prepared.run();
    },
  });
}
