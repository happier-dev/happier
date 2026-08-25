import { createHash } from 'node:crypto';
import {
  createPluginActionPresentUserGate,
  projectPluginActionFailureCode,
  type TargetActionApprovalReplayPlacementV1,
  type PluginActionPresentUserGatePolicy,
} from '@happier-dev/protocol';
import { isPluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginActionHandlerInvocation } from '@happier-dev/plugin-sdk/actions';

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

export type TargetActionExecutionResult = Readonly<
  | { status: 'executed'; value: JsonValue | null }
  | { status: 'deferred'; artifactId: string }
  | {
    status: 'unavailable' | 'invalid' | 'failed';
    code: string;
    message: string;
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
  accountId?: string;
  resourceId?: string;
  /** Host-stamped Action-settings decision, distinct from plugin confirmation. */
  approvalRequiredByActionSettings?: true;
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
  generation: string;
  dangerLevel: ResolvedTargetAction['dangerLevel'];
  scopes: ResolvedTargetAction['scopes'];
  surfaces: ResolvedTargetAction['surfaces'];
  hostAccessRequests: readonly TargetActionHostAccessRequest[];
  availability?: ResolvedTargetAction['availability'];
  confirmation?: ResolvedTargetAction['confirmation'];
  resolveHostPolicy: ResolveTargetActionHostPolicy;
}>): ResolvedTargetAction {
  const action = Object.freeze({
    qualifiedId: `${params.pluginId}/actions/${params.localId}`,
    pluginId: params.pluginId,
    localId: params.localId,
    generation: params.generation,
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
    input: null,
    policyFingerprint: '',
  });
  return params.resolveHostPolicy(action, {
    hostAccessRequests: params.hostAccessRequests,
    surface: 'catalog',
  }).action;
}

export type TargetActionCurrentIntentRequest = Readonly<{
  action: ResolvedTargetAction;
  fingerprint: string;
  /** Declared target capability surface. */
  surface: string;
  /** Actual host invocation surface that the approval binds. */
  invocationSurface?: string;
  /** Immutable host-stamped target for a deferred API approval replay. */
  replayPlacement?: TargetActionApprovalReplayPlacementV1;
  signal?: AbortSignal;
}>;

export type TargetActionCurrentIntentResult = Readonly<
  | { status: 'approved'; fingerprint: string }
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

type TargetActionPolicyFingerprintInput = NormalizedTargetActionPolicy & Readonly<{
  approvalRequiredByActionSettings?: true;
}>;

export function fingerprintTargetActionPolicy(action: TargetActionPolicyFingerprintInput): string {
  return createHash('sha256').update(stable({
    qualifiedId: action.qualifiedId,
    generation: action.generation,
    dangerLevel: action.dangerLevel,
    scopes: action.scopes,
    surfaces: action.surfaces,
    hostAccess: action.hostAccess,
    availability: action.availability,
    confirmation: action.confirmation,
    approvalRequiredByActionSettings: action.approvalRequiredByActionSettings === true,
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
  return Object.freeze({
    status: 'failed',
    code,
    message: error instanceof Error ? error.message : code,
    ...(actionHandlerInvocation === undefined ? {} : { actionHandlerInvocation }),
  });
}

/**
 * A target's published failure payload crosses to its caller, so it must not
 * become the one unredacted route out of an invocation whose credential
 * redaction already owns the failure code and message. The same scoped
 * redactor is applied to every string leaf and key; a redactor failure is
 * caught by the caller, which then withholds the payload entirely.
 *
 * The payload already passed shared Action JSON admission. That carrier has no
 * generic depth quota, so redaction must use an iterative work list rather
 * than treating the JavaScript call stack as a privacy limit.
 */
function redactTargetActionFailureData(
  value: JsonValue,
  redact: (value: string) => string,
): JsonValue {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;

  type PendingRedaction =
    | Readonly<{
      kind: 'array';
      source: readonly JsonValue[];
      destination: JsonValue[];
    }>
    | Readonly<{
      kind: 'record';
      source: Readonly<Record<string, JsonValue>>;
      destination: Record<string, JsonValue>;
    }>;
  const isJsonArray = (candidate: JsonValue): candidate is readonly JsonValue[] => (
    Array.isArray(candidate)
  );
  const root: PendingRedaction = isJsonArray(value)
    ? { kind: 'array', source: value, destination: [] }
    : { kind: 'record', source: value, destination: {} };
  const pending: PendingRedaction[] = [root];
  const project = (candidate: JsonValue): JsonValue => {
    if (typeof candidate === 'string') return redact(candidate);
    if (candidate === null || typeof candidate !== 'object') return candidate;
    if (isJsonArray(candidate)) {
      const next: PendingRedaction = {
        kind: 'array',
        source: candidate,
        destination: [],
      };
      pending.push(next);
      return next.destination;
    }
    const next: PendingRedaction = {
      kind: 'record',
      source: candidate,
      destination: {},
    };
    pending.push(next);
    return next.destination;
  };

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (current.kind === 'array') {
      for (let index = 0; index < current.source.length; index += 1) {
        current.destination[index] = project(current.source[index]!);
      }
      continue;
    }
    for (const [key, candidate] of Object.entries(current.source)) {
      current.destination[redact(key)] = project(candidate);
    }
  }

  return root.destination;
}

function isCurrentServiceBinding(
  action: ResolvedTargetAction,
  serviceBinding: PluginInvocationServiceBinding,
): boolean {
  return serviceBinding.generation === action.generation;
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
    generation: action.generation,
    dangerLevel: action.dangerLevel,
    scopes: action.scopes,
    surfaces: action.surfaces,
    ...(action.confirmation === undefined ? {} : { confirmation: action.confirmation }),
    ...(action.approvalRequiredByActionSettings === true
      ? { approvalRequiredByActionSettings: true }
      : {}),
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
  invoke: (action: ResolvedTargetAction, args: Readonly<{ surface: string; sessionId?: string; signal?: AbortSignal }>, serviceBinding: PluginInvocationServiceBinding) => Promise<TargetActionExecutionResult>;
  redactFailureText?: (action: ResolvedTargetAction, value: string) => string;
  diagnostic?: (fact: Readonly<{ qualifiedId: string; generation: string; surface: string; status: string; code?: string }>) => void | Promise<void>;
}>) {
  type ExecuteArgs = Readonly<{
    pluginId: string;
    localId: string;
    input: unknown;
    surface: string;
    invocationSurface?: string;
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
      const invocationSurface = args.invocationSurface ?? args.surface;
      const finish = async (result: TargetActionExecutionResult): Promise<TargetActionExecutionResult> => {
        let publicResult = result;
        if (result.status === 'failed') {
          let code = projectPluginActionFailureCode(result.code);
          let message = result.message;
          let data = result.data;
          const redactedAction = action;
          if (redactedAction && deps.redactFailureText) {
            const redactFailureText = deps.redactFailureText;
            code = 'plugin_action_execution_failed';
            message = code;
            data = undefined;
            try {
              const redactedCode = redactFailureText(redactedAction, result.code);
              code = redactedCode === result.code
                ? projectPluginActionFailureCode(result.code)
                : 'plugin_action_execution_failed';
              message = redactFailureText(redactedAction, result.message);
              data = result.data === undefined
                ? undefined
                : redactTargetActionFailureData(
                  result.data,
                  (value) => redactFailureText(redactedAction, value),
                );
            } catch {
              // Error projection is a privacy boundary. If the scoped redactor is
              // unavailable, retain only the host-owned stable failure taxonomy.
            }
          }
          publicResult = Object.freeze({
            status: 'failed',
            code,
            message: projectPluginFailureText(new Error(message)),
            ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
            ...(data === undefined ? {} : { data }),
            ...(result.actionHandlerInvocation === undefined
              ? {}
              : { actionHandlerInvocation: result.actionHandlerInvocation }),
          });
        }
        try {
          await deps.diagnostic?.({
            qualifiedId: action?.qualifiedId ?? `${args.pluginId}/actions/${args.localId}`,
            generation: action?.generation ?? 'unavailable',
            surface: args.surface, status: publicResult.status, ...('code' in publicResult ? { code: publicResult.code } : {}),
          });
        } catch { /* Diagnostics are failure-isolated from authorization and execution. */ }
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
            requestCurrentIntent: async (request) => await (args.requestCurrentIntent ?? deps.requestCurrentIntent)!({
              action: request.action.action,
              fingerprint: request.fingerprint,
              surface: request.surface,
              invocationSurface: request.invocationSurface,
              ...(args.replayPlacement === undefined
                ? {}
                : { replayPlacement: args.replayPlacement }),
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            }),
          }
          : {}),
      });
      const admission = await gate.admit({
        input: args.input,
        surface: args.surface,
        invocationSurface,
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
