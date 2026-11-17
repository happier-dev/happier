import * as React from 'react';
import type { OtherAccountFollowV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { GetOtherAccountFollowResponseV1Schema, SetOtherAccountFollowResponseV1Schema } from '@happier-dev/protocol/sessions/follow/api';
import { followDeliveryMuteScopeKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { readAccountSessionFollowRelations } from '@/sync/api/session/sessionFollowApi';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isAccountFollowConfigurationChangeRelevant } from '@/components/sessions/follow/sessionFollowAccountChange';
import { subscribeSessionRunningExecutionRunRoster } from '@/hooks/session/useSessionRunningExecutionRuns';
import { readRunningExecutionRunRosterSnapshot, refreshRunningExecutionRunRoster } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { useExecutionRunHeaders } from '@/hooks/session/useExecutionRunHeaders';
import { classifyInboxExecutionRun, readInboxExecutionRunOnceDeliveries, type InboxExecutionRun } from '@/components/inbox/inboxItems';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import type { OtherFollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/followSourceRefTransportV1';
import { useWorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import { exactWorkflowRunWindowId } from '@/sync/domains/workflows/workflowRunListActions';
import { useWorkflowAttentionSource } from './useWorkflowAttentionSource';
import { useEventCallback } from '@/hooks/ui/useEventCallback';

type RunWorkNotificationSource = Extract<OtherFollowSourceRefV1, { kind: 'execution_run' | 'workflow_run' }>;
type RunFollow = OtherAccountFollowV1 & Readonly<{ source: RunWorkNotificationSource }>;
type Source = Readonly<{
    entries: readonly InboxExecutionRun[];
    workflowFollows: readonly RunFollow[];
    loading: boolean;
    failed: boolean;
    count: number;
    markOpened: (source: RunWorkNotificationSource) => Promise<void>;
    /** Read again only what failed: the Follow census, failed Run headers, the Workflow window, Session rosters. */
    retry: () => void;
}>;
const EMPTY_ENTRIES: readonly InboxExecutionRun[] = Object.freeze([]);
const EMPTY_FOLLOWS: readonly RunFollow[] = Object.freeze([]);
const EMPTY_SOURCE: Source = Object.freeze({ entries: EMPTY_ENTRIES, workflowFollows: EMPTY_FOLLOWS,
    loading: false, failed: false, count: 0, markOpened: async () => {}, retry: () => {} });
const SourceContext = React.createContext<(Source & Readonly<{ acquireDetails: () => () => void }>) | null>(null);
const CountContext = React.createContext(0);
const sourceKey = (source: RunWorkNotificationSource) => followDeliveryMuteScopeKeyV1({ kind: 'source', source });
const hasRunInterest = (follow: OtherAccountFollowV1) => follow.following && follow.persistent
    || Boolean(follow.once?.length || follow.onceDeliveries?.length);

/** Follow supplies interest/receipts; demanded source headers and existing rosters supply live facts. */
function useCreateSource(detailsDemanded: boolean): Source {
    const lifetime = useActiveServerAccountScopeLifetime();
    const scope = lifetime?.scope;
    const enabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId: scope?.serverId ?? '' });
    const workflowAttention = useWorkflowAttentionSource();
    const [census, setCensus] = React.useState<Readonly<{
        lifetime: typeof lifetime; follows: readonly RunFollow[]; loading: boolean; failed: boolean;
    }> | null>(null);
    const censusRef = React.useRef(census);
    censusRef.current = census;
    const refreshCensusRef = React.useRef<(() => void) | null>(null);
    React.useEffect(() => {
        if (!enabled || !lifetime?.isCurrent()) return;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        let running = false;
        let dirty = false;
        const refresh = async () => {
            if (running) { dirty = true; return; }
            running = true;
            try {
                do {
                    dirty = false;
                    // Revalidating a settled census keeps it current: only a first or failed read is loading.
                    setCensus(previous => previous?.lifetime === lifetime && !previous.loading && !previous.failed ? previous
                        : { lifetime, follows: previous?.lifetime === lifetime ? previous.follows : EMPTY_FOLLOWS, loading: true, failed: false });
                    const follows: RunFollow[] = [];
                    let cursor: string | undefined;
                    do {
                        const result = await readAccountSessionFollowRelations(lifetime.scope,
                            { sourceKinds: ['execution_run', 'workflow_run'], ...(cursor ? { cursor } : {}) }, controller.signal);
                        if (controller.signal.aborted || !lifetime.isCurrent()) return;
                        if (result.kind !== 'ok') throw new Error('unavailable');
                        for (const follow of result.value.follows) {
                            if ('source' in follow && (follow.source.kind === 'execution_run' || follow.source.kind === 'workflow_run')
                                && hasRunInterest(follow)) {
                                follows.push({ ...follow, source: follow.source });
                            }
                        }
                        cursor = result.value.continuation;
                    } while (cursor);
                    setCensus(previous => ({ lifetime,
                        follows: previous?.lifetime === lifetime && JSON.stringify(previous.follows) === JSON.stringify(follows) ? previous.follows : follows,
                        loading: false, failed: false }));
                } while (dirty && !controller.signal.aborted && lifetime.isCurrent());
            } catch {
                if (!controller.signal.aborted && lifetime.isCurrent()) setCensus(previous => ({ lifetime,
                    follows: previous?.lifetime === lifetime ? previous.follows : EMPTY_FOLLOWS, loading: false, failed: true }));
            } finally { running = false; }
        };
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (lifetime.isCurrent() && areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)
                && isAccountFollowConfigurationChangeRelevant(event)) void refresh();
        }, { reconnect: { readNotCurrent: () => {
            const current = censusRef.current;
            return current?.lifetime !== lifetime || current.loading || current.failed;
        } } });
        refreshCensusRef.current = () => { void refresh(); };
        void refresh();
        return () => { refreshCensusRef.current = null; controller.abort(); retirement.dispose(); unsubscribe(); };
    }, [enabled, lifetime]);
    const follows = enabled && lifetime?.isCurrent() && census?.lifetime === lifetime ? census.follows : null;
    const workflowFollows = React.useMemo(() => workflowAttention.available
        ? follows?.filter(follow => follow.source.kind === 'workflow_run' && follow.onceDeliveries?.length) ?? EMPTY_FOLLOWS : EMPTY_FOLLOWS,
    [follows, workflowAttention.available]);
    const publishSource = React.useRef<() => void>(() => {});
    const sessionAddresses = React.useMemo(() => {
        const addresses = new Map<string, SessionAddress>();
        for (const follow of follows ?? []) {
            if (lifetime && follow.source.kind === 'execution_run' && 'sessionId' in follow.source && follow.following && follow.persistent) {
                const address = { serverId: lifetime.scope.serverId, sessionId: follow.source.sessionId };
                addresses.set(sessionAddressKey(address), address);
            }
        }
        return addresses;
    }, [follows, lifetime]);
    const sessionAddressKeys = JSON.stringify([...sessionAddresses.keys()].sort());
    React.useEffect(() => {
        if (!lifetime?.isCurrent()) return;
        const disposables = [...sessionAddresses.values()].map(address => subscribeSessionRunningExecutionRunRoster(address,
            () => publishSource.current()));
        const dispose = () => { for (const unsubscribe of disposables) unsubscribe(); };
        const retirement = lifetime.onRetire(dispose);
        return () => { retirement.dispose(); dispose(); };
    }, [lifetime, sessionAddressKeys]);
    const executionFollows = React.useMemo(() => follows?.filter(follow => follow.source.kind === 'execution_run') ?? EMPTY_FOLLOWS, [follows]);
    const headerReferences = React.useMemo(() => executionFollows.flatMap(follow => follow.source.kind !== 'execution_run' ? [] : [{
        source: follow.source, refreshKey: JSON.stringify(follow.onceDeliveries ?? []),
        demanded: Boolean('machineId' in follow.source && follow.following && follow.persistent
            || follow.onceDeliveries?.some(delivery => delivery.event.kind === 'needs_you')
            || detailsDemanded && follow.onceDeliveries?.length),
    }]), [executionFollows, detailsDemanded]);
    const headerReads = useExecutionRunHeaders(lifetime, headerReferences);
    React.useEffect(() => publishSource.current(), [headerReads.revision]);
    const workflowWindowId = React.useMemo(() => exactWorkflowRunWindowId(workflowFollows.map(follow => follow.source.runId)), [workflowFollows]);
    const workflowWindow = useWorkflowRunWindow(workflowWindowId, { enabled: workflowFollows.length > 0,
        demanded: detailsDemanded, readMode: 'complete' });
    const workflowFailed = React.useCallback((runId: string) => workflowWindow.status === 'failed'
        || workflowWindow.knownAt !== null && !workflowWindow.runIds.includes(runId), [workflowWindow.status, workflowWindow.knownAt, workflowWindow.runIds]);
    const [projection, setProjection] = React.useState<Readonly<{
        follows: typeof follows; entries: readonly InboxExecutionRun[]; loading: boolean; failed: boolean;
    }> | null>(null);
    React.useEffect(() => {
        if (!follows || !lifetime?.isCurrent()) return;
        const addresses = sessionAddresses;
        const publish = () => {
            if (!lifetime.isCurrent()) return;
            const entries: InboxExecutionRun[] = [];
            const rosters = new Map([...addresses].map(([key, address]) => [key, readRunningExecutionRunRosterSnapshot(address)]));
            for (const follow of executionFollows) {
                if (follow.source.kind !== 'execution_run') continue;
                const header = headerReads.owner?.read(follow.source);
                const sourceFailed = header?.failed ?? false;
                const address = 'sessionId' in follow.source
                    ? { serverId: lifetime.scope.serverId, sessionId: follow.source.sessionId }
                    : { serverId: lifetime.scope.serverId, machineId: follow.source.machineId };
                const run = header?.run ?? (!sourceFailed && address.sessionId !== undefined
                    ? rosters.get(sessionAddressKey({ serverId: address.serverId, sessionId: address.sessionId }))?.runs.find(run => run.runId === follow.source.runId) : undefined);
                if (!run) continue;
                const entry = { address, run, unavailable: header?.unavailable, persistent: follow.following && follow.persistent,
                    onceDeliveries: follow.onceDeliveries ?? [] };
                const deliveries = readInboxExecutionRunOnceDeliveries(entry);
                // A source outage cannot erase a delivered, already-readable terminal notice.
                // Keep its Account-scoped header, not stale live activity or actionable requests.
                if (sourceFailed && (run.status === 'running'
                    || !deliveries.some(delivery => delivery.event.kind !== 'needs_you'))) continue;
                if (entry.persistent && classifyInboxExecutionRun(run) || deliveries.length) entries.push(entry);
            }
            const loading = detailsDemanded && workflowFollows.length > 0 && workflowWindow.status === 'loading'
                || headerReferences.some(reference => reference.demanded && headerReads.owner?.read(reference.source).loading)
                || [...rosters.values()].some(roster => roster.loading);
            const failed = workflowFollows.some(follow => workflowFailed(follow.source.runId))
                || headerReferences.some(reference => headerReads.owner?.read(reference.source).failed)
                || [...rosters.values()].some(roster => roster.failed);
            setProjection(previous => {
                const unchangedEntries = previous?.follows === follows && JSON.stringify(entries) === JSON.stringify(previous.entries);
                if (unchangedEntries && previous.loading === loading && previous.failed === failed) return previous;
                return { follows, entries: unchangedEntries ? previous.entries : entries, loading, failed };
            });
        };
        publishSource.current = publish;
        const retirement = lifetime.onRetire(() => setProjection(null));
        publish();
        return () => { retirement.dispose(); };
    }, [follows, lifetime, detailsDemanded, workflowFollows, workflowWindow.status, workflowFailed, headerReferences, headerReads.owner]);
    const markOpened = React.useCallback(async (source: RunWorkNotificationSource) => {
        if (!lifetime?.isCurrent()) throw new Error('action_account_scope_changed');
        const current = await callWorkflowAction({ actionId: 'follow.get', input: { receiver: { kind: 'account' }, source },
            accountLifetime: lifetime, parseResult: value => GetOtherAccountFollowResponseV1Schema.parse(value) });
        if (!current.follow?.onceDeliveries?.length) return;
        const result = await callWorkflowAction({ actionId: 'follow.set', input: { receiver: { kind: 'account' }, source,
            once: current.follow.once ?? [], clearOnceDeliveries: true }, accountLifetime: lifetime,
            parseResult: value => SetOtherAccountFollowResponseV1Schema.parse(value) });
        setCensus(previous => !lifetime.isCurrent() || previous?.lifetime !== lifetime ? previous : { ...previous,
            follows: previous.follows.flatMap(follow => sourceKey(follow.source) !== sourceKey(source) ? [follow]
                : hasRunInterest(result.follow) ? [{ ...result.follow, source }] : []) });
    }, [lifetime]);
    // Stable identity: a Retry press reads the latest sub-sources without re-keying the source on every render.
    const retry = useEventCallback(() => {
        if (!lifetime?.isCurrent()) return;
        const current = censusRef.current;
        if (current?.lifetime === lifetime && current.failed) refreshCensusRef.current?.();
        headerReads.owner?.retryFailed();
        if (workflowFollows.length > 0 && workflowWindow.status === 'failed') workflowWindow.retry();
        for (const address of sessionAddresses.values()) {
            if (readRunningExecutionRunRosterSnapshot(address).failed) refreshRunningExecutionRunRoster(address);
        }
    });
    return React.useMemo(() => {
        if (!enabled || !lifetime?.isCurrent()) return EMPTY_SOURCE;
        const entries = follows && projection?.follows === follows ? projection.entries : EMPTY_ENTRIES;
        const countable = new Set(entries.map(entry => sourceKey({ kind: 'execution_run', runId: entry.run.runId,
            ...(entry.address.sessionId !== undefined ? { sessionId: entry.address.sessionId } : { machineId: entry.address.machineId }) })));
        for (const follow of follows ?? []) {
            if (follow.source.kind === 'execution_run') {
                const header = headerReads.owner?.read(follow.source);
                if (header?.failed || header?.unavailable) continue;
            } else if (workflowFailed(follow.source.runId)) continue;
            if (follow.source.kind === 'execution_run' && follow.onceDeliveries?.some(delivery => delivery.event.kind !== 'needs_you')) countable.add(sourceKey(follow.source));
            if (workflowAttention.available && follow.source.kind === 'workflow_run' && !workflowAttention.runIds.includes(follow.source.runId)
                && follow.onceDeliveries?.some(delivery => delivery.event.kind !== 'needs_you')) countable.add(sourceKey(follow.source));
        }
        const availableWorkflowFollows = workflowFollows.filter(follow => !workflowFailed(follow.source.runId));
        return { entries, workflowFollows: availableWorkflowFollows, count: countable.size, markOpened, retry,
            loading: census?.lifetime !== lifetime || census.loading || Boolean(follows && (projection?.follows !== follows || projection.loading)),
            failed: census?.lifetime === lifetime && (census.failed || Boolean(projection?.follows === follows && projection.failed)) };
    }, [enabled, lifetime, follows, projection, census, workflowFollows, workflowAttention.available, workflowAttention.runIds, markOpened, retry, headerReads, workflowFailed]);
}

function SourceProvider(props: Readonly<{ children: React.ReactNode }>) {
    const [details, setDetails] = React.useState(0);
    const source = useCreateSource(details > 0);
    const acquireDetails = React.useCallback(() => {
        setDetails(value => value + 1);
        return () => setDetails(value => value - 1);
    }, []);
    const value = React.useMemo(() => ({ ...source, acquireDetails }), [source, acquireDetails]);
    return <CountContext.Provider value={source.count}><SourceContext.Provider value={value}>{props.children}</SourceContext.Provider></CountContext.Provider>;
}

export function InboxExecutionRunSourceBoundary(props: Readonly<{ children: React.ReactNode }>) {
    const existing = React.useContext(SourceContext);
    return existing ? <>{props.children}</> : <SourceProvider>{props.children}</SourceProvider>;
}
export function useInboxExecutionRunSource(): Source {
    const source = React.useContext(SourceContext);
    React.useEffect(() => source?.acquireDetails(), [source?.acquireDetails]);
    return source ?? EMPTY_SOURCE;
}
export function useInboxExecutionRunCount(): number { return React.useContext(CountContext); }
