import type { ActionExecuteResult, ActionExecutorContext, ActionId, ActionCaller, ActionExecutorDeps, WorkflowRunStartedByV1 } from '@happier-dev/protocol';
import { resolveWorkflowRunStartedByForActionCallerV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { parseQualifiedPluginActionId, formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { searchActionDefinitionSummaries } from '@happier-dev/protocol/actions/actionCatalog';

import type { PluginActionExecutionAttempt } from '@/plugins/runtime/invocation/actions/executeContributedAction';

type OccurrenceBoundActionExecutorContext = ActionExecutorContext & Readonly<{
  /** Host-stamped turn admission fence; never Action input or SDK surface. */
  expectedContributorOccurrenceId?: string;
}>;

type ActionExecutorLike = Readonly<{
  execute: (
    actionId: ActionId,
    input: unknown,
    context?: OccurrenceBoundActionExecutorContext,
  ) => Promise<ActionExecuteResult>;
}>;
type PluginActionExecutor = ActionExecutorLike & Readonly<{
  invokeContributedAction: NonNullable<ActionExecutorDeps['invokeContributedAction']>;
}>;
export type CurrentProcessPluginActionExecutionAttempt =
  | Readonly<{ matched: false; accountSelectionUnavailable?: true }>
  | Readonly<{ matched: true; result: ActionExecuteResult }>;

const PLUGIN_META_ACTION_IDS = new Set<string>([
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
  'action.invoke',
]);

/** These IDs must reach the placement-aware plugin owner before root transport. */
export function isPluginActionExecutionDispatchId(actionId: string): boolean {
  return PLUGIN_META_ACTION_IDS.has(actionId) || parseQualifiedPluginActionId(actionId) !== null;
}

/** Exact target shared by local placement and the daemon descriptor read. */
export function readPluginActionExecutionReference(actionId: string, input: unknown): PluginContributionIdentityV1 | null {
  const record = typeof input === 'object' && input !== null ? input : null;
  const metadataId = record && (actionId === 'action.spec.get' && 'id' in record ? record.id
    : actionId === 'action.options.resolve' && 'actionId' in record ? record.actionId : null);
  const reference = PluginContributionIdentityV1Schema.safeParse(actionId === 'action.invoke'
    && record && 'action' in record ? record.action
    : parseQualifiedPluginActionId(typeof metadataId === 'string' ? metadataId : actionId));
  return reference.success ? reference.data : null;
}

/**
 * Extends an existing first-party executor with the daemon's final external
 * action owner. The daemon route acquires the current runtime-registry lease,
 * activates the owning plugin when needed, and enforces target-action policy.
 */
export function createDaemonPluginActionExecutor(params: Readonly<{
  base: ActionExecutorLike;
  executeInCurrentProcess?: (actionId: string, input: unknown, context?: OccurrenceBoundActionExecutorContext) => Promise<CurrentProcessPluginActionExecutionAttempt>;
  requestPluginActionExecution?: PluginActionExecutionRequestOwner;
  /** Exact caller bound by the host, never inferred from a requested target or surface. */
  getInitiatingActionCaller?: () => ActionCaller | null;
  /** Host-stamped descriptive starter; never an authorization principal. */
  startedBy?: WorkflowRunStartedByV1;
}>): PluginActionExecutor {
  return createPluginActionExecutor({
    base: params.base,
    ...(params.executeInCurrentProcess ? { executeInCurrentProcess: params.executeInCurrentProcess } : {}),
    requestPluginActionExecution: params.requestPluginActionExecution
      ?? (async (request, options) => {
        const { requestDaemonPluginActionExecution } = await import('@/daemon/controlClient');
        return await requestDaemonPluginActionExecution(request, options);
      }),
    ...(params.getInitiatingActionCaller ? { getInitiatingActionCaller: params.getInitiatingActionCaller } : {}),
    ...(params.startedBy ? { startedBy: params.startedBy } : {}),
  });
}

export type PluginActionExecutionRequestOwner = (request: Readonly<{
    actionId: string;
    input: unknown;
    surface: 'cli' | 'mcp' | 'agent';
    defaultSessionId?: string;
    /** Bounded host-stamped descriptive fact; never permission ancestry. */
    startedBy?: WorkflowRunStartedByV1;
    expectedContributorOccurrenceId?: string;
    requiredDangerLevel?: 'safe';
  }>, options?: Readonly<{ signal?: AbortSignal }>) => Promise<PluginActionExecutionAttempt>;

/** Routes dynamic/meta Actions to one explicit execution owner before the built-in executor. */
export function createPluginActionExecutor(params: Readonly<{
  base: ActionExecutorLike;
  executeInCurrentProcess?: (actionId: string, input: unknown, context?: OccurrenceBoundActionExecutorContext) => Promise<CurrentProcessPluginActionExecutionAttempt>;
  requestPluginActionExecution?: PluginActionExecutionRequestOwner;
  getInitiatingActionCaller?: () => ActionCaller | null;
  /** Host-stamped descriptive fallback; an exact context caller takes precedence. */
  startedBy?: WorkflowRunStartedByV1;
}>): PluginActionExecutor {
  const requestContributed = async (
    actionId: string, input: unknown, context?: OccurrenceBoundActionExecutorContext,
  ) => {
    const surface: 'cli' | 'mcp' | 'agent' = context?.surface === 'mcp'
      ? 'mcp' : context?.surface === 'agent' ? 'agent' : 'cli';
    const admittingCaller = context?.actionCaller ?? params.getInitiatingActionCaller?.();
    if (params.getInitiatingActionCaller && !admittingCaller) return {
      matched: true as const,
      result: { ok: false as const, errorCode: 'target_unavailable', error: 'target_unavailable' },
    };
    const startedBy = admittingCaller
      ? resolveWorkflowRunStartedByForActionCallerV1(admittingCaller)
      : params.startedBy;
    const local = await params.executeInCurrentProcess?.(actionId, input, context);
    if (local?.matched && (actionId !== 'action.spec.search' || !params.requestPluginActionExecution)) return local;
    const contributedIdentity = parseQualifiedPluginActionId(actionId);
    const request = {
      actionId: contributedIdentity ? buildQualifiedPluginContributionKey(contributedIdentity) : actionId, input, surface,
      ...(context?.requiredContributedActionDangerLevel ? { requiredDangerLevel: context.requiredContributedActionDangerLevel } : {}),
      ...(startedBy ? { startedBy } : {}),
      ...(typeof context?.defaultSessionId === 'string' ? { defaultSessionId: context.defaultSessionId } : {}),
      ...(typeof context?.expectedContributorOccurrenceId === 'string'
        && context.expectedContributorOccurrenceId.trim().length > 0
        ? { expectedContributorOccurrenceId: context.expectedContributorOccurrenceId.trim() } : {}),
    };
    if (local?.matched) {
      if (!local.result.ok || !params.requestPluginActionExecution) return local;
      const parsedLocal = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.search'].safeParse(local.result.result);
      if (!parsedLocal.success) return { matched: true as const, result: { ok: false as const,
        errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' } };
      let remote: PluginActionExecutionAttempt;
      try { remote = await params.requestPluginActionExecution(request, context?.signal ? { signal: context.signal } : undefined); }
      catch { context?.signal?.throwIfAborted(); return local; }
      if (!remote.matched || !remote.result.ok) return local;
      const parsedRemote = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.search'].safeParse(remote.result.result);
      if (!parsedRemote.success) return local;
      const definitions = new Map([...parsedRemote.data.actionSpecs, ...parsedLocal.data.actionSpecs].map(definition => [definition.id, definition]));
      const query = typeof input === 'object' && input !== null && 'query' in input && typeof input.query === 'string' ? input.query : undefined;
      const limit = typeof input === 'object' && input !== null && 'limit' in input && typeof input.limit === 'number' ? input.limit : undefined;
      return { matched: true as const, result: { ok: true as const, result: {
        actionSpecs: searchActionDefinitionSummaries([...definitions.values()], { query, limit }),
      } } };
    }
    if (local && 'accountSelectionUnavailable' in local) {
      const reference = readPluginActionExecutionReference(actionId, input);
      const unavailable = { matched: true as const, result: { ok: false as const,
        errorCode: 'plugin_action_execution_placement_unavailable', error: 'plugin_action_execution_placement_unavailable' } };
      if (!reference) return unavailable;
      const id = formatQualifiedPluginActionId(reference);
      // This is the incumbent semantic descriptor read, not a second catalog
      // or an endpoint capability probe. Unknown/Account placement refuses.
      const descriptor = params.requestPluginActionExecution
        ? await params.requestPluginActionExecution({ ...request, actionId: 'action.spec.get', input: { id } },
          context?.signal ? { signal: context.signal } : undefined)
        : { matched: true as const, result: await params.base.execute('action.spec.get', { id }, context) };
      if (!descriptor.matched || !descriptor.result.ok) return unavailable;
      const parsed = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].safeParse(descriptor.result.result);
      if (!parsed.success || parsed.data.actionSpec.id !== id
        || (parsed.data.actionSpec.executionPlacement !== 'machine'
          && !(parsed.data.actionSpec.executionPlacement === 'client'
            && (params.requestPluginActionExecution !== undefined || actionId === 'action.spec.get')))) return unavailable;
      if (actionId === 'action.spec.get') return descriptor;
      if (!params.requestPluginActionExecution) return { matched: false as const };
      // The daemon's ordinary final owner rechecks its current declaration and
      // refuses Account placement immediately before any handler invocation.
    }
    if (!params.requestPluginActionExecution) return { matched: false as const };
    return context?.signal
      ? await params.requestPluginActionExecution(request, { signal: context.signal })
      : await params.requestPluginActionExecution(request);
  };
  return {
    invokeContributedAction: async (request) => {
      const attempt = await requestContributed('action.invoke', {
        action: request.action, input: request.input,
        ...(request.messageActionReference ? { messageActionReference: request.messageActionReference } : {}),
      }, { ...request.context,
        ...(request.requiredDangerLevel ? { requiredContributedActionDangerLevel: request.requiredDangerLevel } : {}),
        ...(request.signal ? { signal: request.signal } : {}) });
      // A nested invocation must never fall back to the same base Action owner.
      return attempt.matched ? attempt.result : {
        ok: false, errorCode: 'contributed_action_unavailable', error: 'contributed_action_unavailable',
      };
    },
    execute: async (actionId, input, context) => {
      const normalizedActionId = String(actionId);
      if (isPluginActionExecutionDispatchId(normalizedActionId)) {
        // Public discovery/Tool metadata use Action-qualified IDs. Only this
        // adapter crosses to the daemon's internal contribution registry key.
        const attempt = await requestContributed(normalizedActionId, input, context);
        if (attempt.matched) {
          return attempt.result;
        }
      }
      return await params.base.execute(actionId, input, context);
    },
  };
}
