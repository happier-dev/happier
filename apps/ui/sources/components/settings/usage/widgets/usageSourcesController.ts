import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult,
    type ActionExecuteFailure, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { buildUsageSourceDismissalsKvKey, isDismissibleUsageSource, parseUsageSourceActionResult, USAGE_SOURCE_ACTION_INPUT_SCHEMAS, USAGE_SOURCE_CONSENT_DISCLOSURE,
    type UsageSourceActionId, type UsageSourceActionInputById, type UsageSourceDateRangeV1,
    type UsageSourcesActionListV1, type UsageSourceV1 } from '@happier-dev/protocol/usage/usageSources';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { canRetainUsageReadFailure } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { subscribeKvPrefixChanges } from '@/sync/engine/socket/kvUpdateDispatcher';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

export type UsageSourcesOperation = Readonly<{ actionId: UsageSourceActionId; sourceId?: string }>;
export type UsageSourcesSnapshot = Readonly<{
    sources: readonly UsageSourceV1[];
    dismissedSources: readonly UsageSourceV1[];
    loaded: boolean;
    retired: boolean;
    pending: readonly UsageSourcesOperation[];
    error: ActionExecuteFailure | null;
    approval: ActionApprovalRequestCreatedResult | null;
    historyDeletion: Readonly<{ sourceId: string; deletedEventCount: number; dateRange?: UsageSourceDateRangeV1 }> | null;
    /** The last whole-machine read failed: said once for the machine, while every source keeps its own status. */
    machineReadFailed: boolean;
}>;
export type UsageSourcesController = Readonly<{
    disclosure: typeof USAGE_SOURCE_CONSENT_DISCLOSURE;
    getSnapshot(): UsageSourcesSnapshot;
    subscribe(listener: () => void): () => void;
    discover(callerContext?: ActionExecutorContext): Promise<ActionExecuteResult>;
    refresh(sourceId?: string): Promise<ActionExecuteResult>;
    setConsent(sourceId: string, enabled: boolean): Promise<ActionExecuteResult>;
    notNow(sourceId: string): Promise<ActionExecuteResult>;
    restore(sourceId: string): Promise<ActionExecuteResult>;
    setRoot(sourceId: string, root: string | null, callerContext?: ActionExecutorContext): Promise<ActionExecuteResult>;
    stop(sourceId: string): Promise<ActionExecuteResult>;
    deleteHistory(sourceId: string, dateRange?: UsageSourceDateRangeV1): Promise<ActionExecuteResult>;
    dispose(): void;
}>;

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
const isRead = (id: UsageSourceActionId) => id === 'usage.sources.discover' || id === 'usage.sources.get';

/**
 * The last sources each Machine answered, per Account scope (stale-while-revalidate, R139): a revisit opens on
 * them while its own read refreshes them, never on loading rows. Keyed by the scope's lifetime, so another Account
 * (a new lifetime) never sees them and they go with it.
 */
type UsageSourcesInventory = Pick<UsageSourcesSnapshot, 'sources' | 'dismissedSources'>;
const lastKnownSources = new WeakMap<ServerAccountScopeLifetime, Map<string, UsageSourcesInventory>>();

export function readUsageSourcesLastKnown(lifetime: ServerAccountScopeLifetime | null, machineId: string): UsageSourcesInventory | null {
    return lifetime?.isCurrent() ? lastKnownSources.get(lifetime)?.get(machineId) ?? null : null;
}

/** Mounted UI state only. The Action owner admits effects; the Machine owns capture/status. */

export function createUsageSourcesController(options: Readonly<{
    machineId: string;
    lifetime: ServerAccountScopeLifetime;
    credentials?: AuthCredentials;
    executor?: Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'>;
}>): UsageSourcesController {
    const target = USAGE_SOURCE_ACTION_INPUT_SCHEMAS['usage.sources.discover'].parse({
        serverId: options.lifetime.scope.serverId, machineId: options.machineId,
    });
    const lastKnown = readUsageSourcesLastKnown(options.lifetime, options.machineId);
    let snapshot: UsageSourcesSnapshot = { ...(lastKnown ?? { sources: [], dismissedSources: [] }),
        loaded: lastKnown !== null, retired: false, pending: [], error: null, approval: null, historyDeletion: null, machineReadFailed: false };
    const listeners = new Set<() => void>();
    const operations = new Map<AbortController, UsageSourcesOperation>();
    let retirement: Readonly<{ dispose(): void }> | undefined;
    let unsubscribeWake: (() => void) | undefined;
    let refreshRequested = false;
    const publish = (next: UsageSourcesSnapshot) => {
        snapshot = next;
        if (!next.retired && options.lifetime.isCurrent()) {
            const known = lastKnownSources.get(options.lifetime) ?? new Map<string, UsageSourcesInventory>();
            if (next.loaded) known.set(options.machineId, { sources: next.sources, dismissedSources: next.dismissedSources });
            else known.delete(options.machineId);
            lastKnownSources.set(options.lifetime, known);
        }
        for (const listener of listeners) listener();
    };
    const dispose = () => {
        if (snapshot.retired) return;
        for (const controller of operations.keys()) controller.abort();
        operations.clear();
        refreshRequested = false;
        unsubscribeWake?.();
        retirement?.dispose();
        publish({ sources: [], dismissedSources: [], loaded: false, retired: true, pending: [], error: null, approval: null,
            historyDeletion: null, machineReadFailed: false });
    };
    const current = () => {
        if (!options.lifetime.isCurrent()) dispose();
        return !snapshot.retired;
    };
    const execute = createFrontDoorActionExecute(options.executor);
    const reconcile = (sources: readonly UsageSourceV1[], previousSources = snapshot.sources) => {
        const next = sources.map(source => {
            const previous = previousSources.find(row => row.sourceId === source.sourceId);
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
        return next.length === previousSources.length && next.every((row, index) => row === previousSources[index])
            ? previousSources : next;
    };
    // A machine read that reports a source last known failed only as re-checking ('reading', no error) has not
    // answered for it yet: the Machine clears the error on rediscovery and re-checks. It keeps its failed status until
    // its own answer arrives (ready, or failed again), so a revisit never flips that row away and back (R141).
    const keepFailedThroughRecheck = (sources: readonly UsageSourceV1[]): UsageSourceV1[] => sources.map(source => {
        const previous = snapshot.sources.find(row => row.sourceId === source.sourceId);
        return previous && (previous.status === 'unavailable' || previous.status === 'error')
            && source.status === 'reading' && source.errorCode === undefined
            ? { ...source, status: previous.status, ...(previous.errorCode === undefined ? {} : { errorCode: previous.errorCode }) }
            : source;
    });
    const publishFailure = (actionId: UsageSourceActionId, sourceId: string | undefined, error: ActionExecuteFailure) => {
        if (!isRead(actionId)) { publish({ ...snapshot, error }); return; }
        const retain = canRetainUsageReadFailure(error.errorCode);
        // A whole-machine read that fails says nothing new about any one source: each keeps its last-known status
        // until its own read answers, and the failure is the machine's, said once (R140).
        if (sourceId === undefined && retain) { publish({ ...snapshot, error, machineReadFailed: true }); return; }
        const sources = snapshot.sources.flatMap(source => sourceId !== undefined && source.sourceId !== sourceId ? [source]
            : !retain ? [] : [source.status === 'unavailable' ? source : { ...source, status: 'unavailable' as const }]);
        const dismissedSources = retain ? snapshot.dismissedSources : snapshot.dismissedSources.filter(source =>
            sourceId !== undefined && source.sourceId !== sourceId);
        publish({ ...snapshot, sources: reconcile(sources), dismissedSources,
            loaded: retain ? snapshot.loaded : sources.length + dismissedSources.length > 0, error,
            ...(!retain ? { historyDeletion: null } : {}) });
    };

    async function run<K extends UsageSourceActionId>(actionId: K, input: UsageSourceActionInputById[K], callerContext?: ActionExecutorContext): Promise<ActionExecuteResult> {
        if (!current()) return failure('action_account_scope_changed');
        subscribeWake();
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
        publish({ ...snapshot, pending: [...operations.values()], error: null, approval: null, machineReadFailed: false });
        try {
            let discovered: UsageSourcesActionListV1 | undefined;
            const result = await execute(actionId, input, {
                ...(callerContext ?? { surface: 'ui' as const }),
                serverId: target.serverId, expectedAccountId: options.lifetime.scope.accountId,
                signal: controller.signal,
                ...(actionId === 'usage.sources.discover' && callerContext ? {
                    captureUsageSourceDiscovery: inventory => { discovered = inventory; },
                } : {}),
            });
            if (!current()) return failure('action_account_scope_changed');
            if (!operations.has(controller)) return failure('cancelled');
            if (!result.ok) {
                publishFailure(actionId, sourceId, result);
                return result;
            }
            const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
            if (approval.success && approval.data.actionId === actionId) {
                publish({ ...snapshot, approval: approval.data });
                return result;
            }
            const data = parseUsageSourceActionResult(actionId, input, discovered ?? result.result, 'action');
            if (!data) {
                const invalid = failure(isRead(actionId) ? 'usage_source_response_invalid' : 'usage_source_mutation_outcome_unknown');
                publishFailure(actionId, sourceId, invalid);
                return invalid;
            }
            if ('sources' in data) {
                const sources = sourceId === undefined ? keepFailedThroughRecheck(data.sources) : snapshot.sources.filter(source => source.sourceId !== sourceId);
                if (sourceId !== undefined) {
                    const index = snapshot.sources.findIndex(source => source.sourceId === sourceId);
                    sources.splice(index < 0 ? sources.length : index, 0, ...data.sources);
                }
                publish({ ...snapshot, sources: reconcile(sources), loaded: true,
                    dismissedSources: sourceId === undefined
                        ? reconcile(data.dismissedSources ?? [], snapshot.dismissedSources) : snapshot.dismissedSources });
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
            } else if ('status' in data) {
                if (data.status === 'unavailable') publish({ ...snapshot, error: failure('usage_source_dismiss_unavailable') });
                else if (data.status === 'dismissed') {
                    const source = snapshot.sources.find(row => row.sourceId === sourceId && isDismissibleUsageSource(row));
                    if (source) publish({ ...snapshot, sources: snapshot.sources.filter(row => row !== source),
                        dismissedSources: [...snapshot.dismissedSources, source] });
                } else {
                    const source = snapshot.dismissedSources.find(row => row.sourceId === sourceId);
                    if (source) publish({ ...snapshot, sources: [...snapshot.sources, source],
                        dismissedSources: snapshot.dismissedSources.filter(row => row !== source) });
                }
            }
            return discovered ? result : { ...result, result: data };
        } catch {
            if (!current()) return failure('action_account_scope_changed');
            const error = failure(controller.signal.aborted ? 'cancelled'
                : isRead(actionId) || actionId === 'usage.sources.dismiss' ? 'usage_source_unavailable' : 'usage_source_mutation_outcome_unknown');
            if (operations.has(controller)) publishFailure(actionId, sourceId, error);
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
    // A retained list can be displayed before its mounted Action engine binds.
    // Push reads start with the first explicit demand, never with presentation alone.
    function subscribeWake() {
        if (unsubscribeWake) return;
        const requestRefresh = () => {
            if (!current() || !snapshot.loaded) return;
            refreshRequested = true;
            drainRefresh();
        };
        const offHome = subscribeHomeAccountChange(requestRefresh,
            { serverIds: [target.serverId], usageSourcesMachineIds: [target.machineId], reconnect: 'refresh' });
        const key = buildUsageSourceDismissalsKvKey(target.machineId);
        const offDismissals = options.credentials ? subscribeKvPrefixChanges(key, changes => {
            if (changes.some(change => change.key === key || change.key === null)) requestRefresh();
        }, { credentials: options.credentials, shouldContinue: current }) : undefined;
        unsubscribeWake = () => { offHome(); offDismissals?.(); };
    }
    retirement = options.lifetime.onRetire(dispose);
    if (!current()) retirement.dispose();
    return {
        disclosure: USAGE_SOURCE_CONSENT_DISCLOSURE,
        getSnapshot: () => { current(); return snapshot; },
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        discover: callerContext => run('usage.sources.discover', target, callerContext),
        refresh: sourceId => {
            const source = sourceId === undefined ? undefined : snapshot.sources.find(source => source.sourceId === sourceId);
            // Retry restarts the Machine's existing consented capture lifetime;
            // status/push reads remain passive and never grant disabled consent.
            return source?.consent === 'enabled' && (source.status === 'unavailable' || source.status === 'error')
                ? run('usage.sources.consent.set', { ...target, sourceId: source.sourceId, enabled: true })
                : run('usage.sources.get', { ...target, ...(sourceId === undefined ? {} : { sourceId }) });
        },
        setConsent: (sourceId, enabled) => run('usage.sources.consent.set', { ...target, sourceId, enabled }),
        notNow: sourceId => run('usage.sources.dismiss', { ...target, sourceId }),
        restore: sourceId => run('usage.sources.dismiss', { ...target, sourceId, dismissed: false }),
        setRoot: (sourceId, root, callerContext) => run('usage.sources.root.set', { ...target, sourceId, root }, callerContext),
        stop: sourceId => run('usage.sources.stop', { ...target, sourceId }),
        deleteHistory: (sourceId, dateRange) => run('usage.sources.history.delete', { ...target, sourceId,
            ...(dateRange === undefined ? {} : { dateRange }) }),
        dispose,
    };
}
