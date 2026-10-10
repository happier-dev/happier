import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult,
    type ActionExecuteFailure, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { parseUsageSourceActionResult, USAGE_SOURCE_ACTION_INPUT_SCHEMAS, USAGE_SOURCE_CONSENT_DISCLOSURE,
    type UsageSourceActionId, type UsageSourceActionInputById, type UsageSourceDateRangeV1,
    type UsageSourceV1 } from '@happier-dev/protocol/usage/usageSources';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type UsageSourcesOperation = Readonly<{ actionId: UsageSourceActionId; sourceId?: string }>;
export type UsageSourcesSnapshot = Readonly<{
    sources: readonly UsageSourceV1[];
    loaded: boolean;
    retired: boolean;
    pending: readonly UsageSourcesOperation[];
    error: ActionExecuteFailure | null;
    approval: ActionApprovalRequestCreatedResult | null;
    dismissedSourceIds: readonly string[];
    historyDeletion: Readonly<{ sourceId: string; deletedEventCount: number; dateRange?: UsageSourceDateRangeV1 }> | null;
}>;
export type UsageSourcesController = Readonly<{
    disclosure: typeof USAGE_SOURCE_CONSENT_DISCLOSURE;
    getSnapshot(): UsageSourcesSnapshot;
    subscribe(listener: () => void): () => void;
    discover(): Promise<ActionExecuteResult>;
    refresh(sourceId?: string): Promise<ActionExecuteResult>;
    setConsent(sourceId: string, enabled: boolean): Promise<ActionExecuteResult>;
    notNow(sourceId: string): Promise<ActionExecuteResult>;
    setRoot(sourceId: string, root: string | null): Promise<ActionExecuteResult>;
    stop(sourceId: string): Promise<ActionExecuteResult>;
    deleteHistory(sourceId: string, dateRange?: UsageSourceDateRangeV1): Promise<ActionExecuteResult>;
    dispose(): void;
}>;

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
const isRead = (id: UsageSourceActionId) => id === 'usage.sources.discover' || id === 'usage.sources.get';

/** Mounted UI state only. The Action owner admits effects; the Machine owns capture/status. */

export function createUsageSourcesController(options: Readonly<{
    machineId: string;
    lifetime: ServerAccountScopeLifetime;
    executor?: Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'>;
}>): UsageSourcesController {
    const target = USAGE_SOURCE_ACTION_INPUT_SCHEMAS['usage.sources.discover'].parse({
        serverId: options.lifetime.scope.serverId, machineId: options.machineId,
    });
    let snapshot: UsageSourcesSnapshot = { sources: [], loaded: false, retired: false, pending: [], error: null,
        approval: null, dismissedSourceIds: [], historyDeletion: null };
    const listeners = new Set<() => void>();
    const operations = new Map<AbortController, UsageSourcesOperation>();
    let retirement: Readonly<{ dispose(): void }> | undefined;
    let unsubscribeWake: (() => void) | undefined;
    let refreshRequested = false;
    const publish = (next: UsageSourcesSnapshot) => {
        snapshot = next;
        for (const listener of listeners) listener();
    };
    const dispose = () => {
        if (snapshot.retired) return;
        for (const controller of operations.keys()) controller.abort();
        operations.clear();
        refreshRequested = false;
        unsubscribeWake?.();
        retirement?.dispose();
        publish({ sources: [], loaded: false, retired: true, pending: [], error: null, approval: null,
            dismissedSourceIds: [], historyDeletion: null });
    };
    const current = () => {
        if (!options.lifetime.isCurrent()) dispose();
        return !snapshot.retired;
    };
    const execute = createFrontDoorActionExecute(options.executor, {
        // Not now is an admitted client-local fact, scoped to this mounted card lifetime.
        usageSourceDismiss: async (input, context) => {
            context.signal?.throwIfAborted();
            return { status: current() && input.serverId === target.serverId && input.machineId === target.machineId
                && snapshot.sources.some(source => source.sourceId === input.sourceId && source.consent === 'disabled')
                ? 'dismissed' : 'unavailable' };
        },
    });
    const reconcile = (sources: readonly UsageSourceV1[]) => {
        const next = sources.map(source => {
            const previous = snapshot.sources.find(row => row.sourceId === source.sourceId);
            if (!previous) return source;
            if (sameStrictJsonValue(previous, source)) return previous;
            // Progress changes must not retire a mounted candidate listing for the
            // same admitted producer/root. Preserve unchanged metadata references.
            return { ...source,
                agent: sameStrictJsonValue(previous.agent, source.agent) ? previous.agent : source.agent,
                root: sameStrictJsonValue(previous.root, source.root) ? previous.root : source.root,
                ...(source.externalSessionSource === undefined ? {} : { externalSessionSource:
                    previous.externalSessionSource && sameStrictJsonValue(previous.externalSessionSource, source.externalSessionSource)
                        ? previous.externalSessionSource : source.externalSessionSource }),
            };
        });
        return next.length === snapshot.sources.length && next.every((row, index) => row === snapshot.sources[index])
            ? snapshot.sources : next;
    };

    async function run<K extends UsageSourceActionId>(actionId: K, input: UsageSourceActionInputById[K]): Promise<ActionExecuteResult> {
        if (!current()) return failure('action_account_scope_changed');
        const sourceId = 'sourceId' in input ? input.sourceId : undefined;
        // A root/consent transition must not be overwritten by an older metadata read.
        for (const [controller, operation] of operations) {
            if (isRead(operation.actionId) && (!isRead(actionId) || operation.sourceId === sourceId)) {
                operations.delete(controller);
                controller.abort();
            }
        }
        const controller = new AbortController();
        const operation = { actionId, ...(sourceId === undefined ? {} : { sourceId }) };
        operations.set(controller, operation);
        publish({ ...snapshot, pending: [...operations.values()], error: null, approval: null });
        try {
            const result = await execute(actionId, input, {
                surface: 'ui', serverId: target.serverId, expectedAccountId: options.lifetime.scope.accountId,
                signal: controller.signal,
            });
            if (!current()) return failure('action_account_scope_changed');
            if (!operations.has(controller)) return failure('cancelled');
            if (!result.ok) {
                publish({ ...snapshot, error: result });
                return result;
            }
            const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
            if (approval.success && approval.data.actionId === actionId) {
                publish({ ...snapshot, approval: approval.data });
                return result;
            }
            const data = parseUsageSourceActionResult(actionId, input, result.result);
            if (!data) {
                const invalid = failure(isRead(actionId) ? 'usage_source_response_invalid' : 'usage_source_mutation_outcome_unknown');
                publish({ ...snapshot, error: invalid });
                return invalid;
            }
            if ('sources' in data) {
                const sources = sourceId === undefined ? data.sources : snapshot.sources.filter(source => source.sourceId !== sourceId);
                if (sourceId !== undefined) {
                    const index = snapshot.sources.findIndex(source => source.sourceId === sourceId);
                    sources.splice(index < 0 ? sources.length : index, 0, ...data.sources);
                }
                publish({ ...snapshot, sources: reconcile(sources), loaded: true });
            } else if ('source' in data) {
                // root.set may legitimately replace its opaque source identity.
                const sources = snapshot.sources.filter(source => source.sourceId !== sourceId && source.sourceId !== data.source.sourceId);
                const index = snapshot.sources.findIndex(source => source.sourceId === sourceId);
                sources.splice(index < 0 ? sources.length : index, 0, data.source);
                publish({ ...snapshot, sources: reconcile(sources) });
            } else if ('deletedEventCount' in data && sourceId !== undefined) {
                const range = 'dateRange' in input ? input.dateRange : undefined;
                publish({ ...snapshot, historyDeletion: { sourceId, deletedEventCount: data.deletedEventCount,
                    ...(range === undefined ? {} : { dateRange: range }) } });
            } else if ('status' in data && data.status === 'dismissed' && sourceId !== undefined) {
                if (!snapshot.dismissedSourceIds.includes(sourceId)) {
                    publish({ ...snapshot, dismissedSourceIds: [...snapshot.dismissedSourceIds, sourceId] });
                }
            } else if ('status' in data && data.status === 'unavailable') {
                publish({ ...snapshot, error: failure('usage_source_dismiss_unavailable') });
            }
            return { ok: true, result: data };
        } catch {
            if (!current()) return failure('action_account_scope_changed');
            const error = failure(controller.signal.aborted ? 'cancelled'
                : isRead(actionId) || actionId === 'usage.sources.dismiss' ? 'usage_source_unavailable' : 'usage_source_mutation_outcome_unknown');
            if (operations.has(controller)) publish({ ...snapshot, error });
            return error;
        } finally {
            if (operations.delete(controller)) publish({ ...snapshot, pending: [...operations.values()] });
            drainRefresh();
        }
    }
    function drainRefresh() {
        if (!refreshRequested || operations.size > 0 || !current() || !snapshot.loaded) return;
        refreshRequested = false;
        void run('usage.sources.get', target);
    }
    unsubscribeWake = subscribeHomeAccountChange(event => {
        if (!current() || !snapshot.loaded || !areServerProfileIdentifiersEquivalent(event.serverId, target.serverId)) return;
        refreshRequested = true;
        drainRefresh();
    });
    retirement = options.lifetime.onRetire(dispose);
    if (!current()) retirement.dispose();
    return {
        disclosure: USAGE_SOURCE_CONSENT_DISCLOSURE,
        getSnapshot: () => { current(); return snapshot; },
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        discover: () => run('usage.sources.discover', target),
        refresh: sourceId => run('usage.sources.get', { ...target, ...(sourceId === undefined ? {} : { sourceId }) }),
        setConsent: (sourceId, enabled) => run('usage.sources.consent.set', { ...target, sourceId, enabled }),
        notNow: sourceId => run('usage.sources.dismiss', { ...target, sourceId }),
        setRoot: (sourceId, root) => run('usage.sources.root.set', { ...target, sourceId, root }),
        stop: sourceId => run('usage.sources.stop', { ...target, sourceId }),
        deleteHistory: (sourceId, dateRange) => run('usage.sources.history.delete', { ...target, sourceId,
            ...(dateRange === undefined ? {} : { dateRange }) }),
        dispose,
    };
}
