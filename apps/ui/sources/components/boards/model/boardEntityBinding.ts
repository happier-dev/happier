import { buildWorkBoardItemKeyV1, type BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';

import { resolveServerScopedMachineInventory } from '@/sync/domains/machines/resolveServerScopedMachines';
import { readSessionListHomeObservationForServerId } from '@/sync/domains/session/listing/sessionListHomeObservation';
import { readSessionListRowForServerId, resolveSessionListHomeKey } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { isSessionRetiredForServer, type SessionsDomain } from '@/sync/store/domains/sessions';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { WorkflowRunWindow } from '@/components/workflows/library/workflowLibraryReads';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListRenderableDelta } from '@/sync/store/domains/sessionListIndexFinalization';
import { readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

type BoardEntitySourceState = 'ready' | 'loading' | 'settled' | 'retired' | 'failed';

/** A settled cache miss is unavailable here, not evidence that a Session was deleted. */
export function readBoardSessionSourceState(
    state: Pick<SessionsDomain, 'sessionListRowsByServerId' | 'deletedSessionIds' | 'concurrentSessionListCacheByServerId'> & Readonly<{
        machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
    }>,
    ref: BoardItemRefV1,
    previous?: BoardEntitySourceState,
): BoardEntitySourceState {
    const { serverId, id } = ref.qualifiedId;
    if (readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, id)) return 'ready';
    if (isSessionRetiredForServer(state.deletedSessionIds, id, serverId)) return 'retired';
    // The Home runtime withdraws Session observations on credential loss. Its scoped signed-out
    // fact is still an answer; absence of a cache entry must not turn that refusal into loading.
    const homeKey = resolveSessionListHomeKey(state.machineListStatusByServerId, serverId);
    const homeStatus = homeKey ? state.machineListStatusByServerId?.[homeKey] : undefined;
    if (homeStatus === 'signedOut') return 'failed';
    const observation = readSessionListHomeObservationForServerId(state.concurrentSessionListCacheByServerId, serverId);
    if (observation?.phase === 'error' || observation?.phase === 'offline') return 'failed';
    if ((!observation || observation.phase === 'loading' || observation.phase === 'refreshing') && previous && previous !== 'loading') return previous;
    return observation && (observation.lastSuccessAt !== null || observation.phase === 'ready') ? 'settled' : 'loading';
}

type BoardSessionSource = Readonly<{ state: BoardEntitySourceState; row: SessionListRenderableSession | null;
    readNextRefreshAtMs: (nowMs: number) => number | null }>;

export type BoardSessionSources = readonly BoardSessionSource[] & Readonly<{
    byKey: ReadonlyMap<string, BoardSessionSource>;
    token: object;
    /** Only the immediately preceding admission is identified; no snapshot chain is retained. */
    changes?: Readonly<{ previous: object; keys: readonly string[] }>;
}>;

/** Visit-local settled facts for the demanded Sessions. A re-read is not a new result. */
export function createBoardSessionSourceProjection() {
    const sourceKey = (ref: BoardItemRefV1) => buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: {
        serverId: resolveServerProfileScopeIdForIdentifier(ref.qualifiedId.serverId) || ref.qualifiedId.serverId,
        id: ref.qualifiedId.id,
    } });
    let previous = new Map<string, BoardSessionSource>();
    type State = Parameters<typeof readBoardSessionSourceState>[0] & { sessionListRenderableDelta?: SessionListRenderableDelta };
    let previousState: State | null = null;
    let previousRefs: readonly BoardItemRefV1[] | null = null;
    let sources: BoardSessionSources = Object.assign([], { byKey: previous, token: {} });
    let indicesById = new Map<string, number[]>();
    const read = (state: State, ref: BoardItemRefV1, old?: BoardSessionSource): BoardSessionSource => {
        const row = readSessionListRowForServerId(state.sessionListRowsByServerId, ref.qualifiedId.serverId, ref.qualifiedId.id);
        const phase = row ? 'ready' : readBoardSessionSourceState(state, ref, old?.state);
        const retained = row ?? (phase === 'ready' ? old?.row ?? null : null);
        if (old?.state === phase && old.row === retained) return old;
        let refreshAt: number | null | undefined;
        return { state: phase, row: retained, readNextRefreshAtMs: nowMs => {
            // An unchanged source has the same next status boundary until that boundary arrives.
            // Keep that admitted projection beside the row, rather than reclassifying the fleet
            // whenever one other Session changes. The shared clock still owns the actual wake.
            if (refreshAt === undefined || refreshAt !== null && nowMs >= refreshAt) {
                refreshAt = retained ? readSessionStatusNextRefreshAtMs(retained, nowMs) : null;
            }
            return refreshAt;
        } };
    };
    return (state: State, refs: readonly BoardItemRefV1[]): BoardSessionSources => {
        const sameSelection = refs === previousRefs;
        const sameLifecycle = previousState !== null
            && previousState.deletedSessionIds === state.deletedSessionIds
            && previousState.concurrentSessionListCacheByServerId === state.concurrentSessionListCacheByServerId
            && previousState.machineListStatusByServerId === state.machineListStatusByServerId;
        const delta = state.sessionListRenderableDelta;
        if (sameSelection && sameLifecycle && previousState) {
            if (previousState.sessionListRowsByServerId !== state.sessionListRowsByServerId) {
                // The row writer's consecutive publication identifies all changed ids. Other writers,
                // skipped publications and lifecycle changes fall back to the complete source read.
                if (delta && previousState.sessionListRenderableDelta
                    && delta.revision === previousState.sessionListRenderableDelta.revision + 1) {
                    let next: BoardSessionSource[] | null = null;
                    let nextByKey: Map<string, BoardSessionSource> | null = null;
                    const keys: string[] = [];
                    for (const id of new Set([...delta.changedSessionIds, ...delta.removedSessionIds])) {
                        for (const index of indicesById.get(id) ?? []) {
                            const ref = refs[index]!;
                            const old = sources[index]!;
                            const source = read(state, ref, old);
                            if (source === old) continue;
                            next ??= sources.slice();
                            next[index] = source;
                            const key = buildWorkBoardItemKeyV1(ref);
                            nextByKey ??= new Map(previous);
                            nextByKey.set(sourceKey(ref), source);
                            keys.push(key);
                        }
                    }
                    if (next && nextByKey) {
                        previous = nextByKey;
                        sources = Object.assign(next, { byKey: previous, token: {}, changes: { previous: sources.token, keys } });
                    }
                    previousState = state;
                    return sources;
                }
            } else {
                previousState = state;
                return sources;
            }
        }
        if (!sameSelection) {
            indicesById = new Map();
            refs.forEach((ref, index) => {
                const indices = indicesById.get(ref.qualifiedId.id) ?? [];
                indices.push(index);
                indicesById.set(ref.qualifiedId.id, indices);
            });
        }
        const next = new Map<string, BoardSessionSource>();
        const nextSources = refs.map(ref => {
            const key = sourceKey(ref);
            const old = previous.get(key);
            const source = read(state, ref, old);
            next.set(key, source);
            return source;
        });
        if (sources.length !== nextSources.length || nextSources.some((source, index) => source !== sources[index])) {
            sources = Object.assign(nextSources, { byKey: next, token: {} });
        }
        previous = next;
        previousState = state;
        previousRefs = refs;
        return sources;
    };
}

export function readBoardMachineSourceState(state: Readonly<{
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>, ref: BoardItemRefV1): BoardEntitySourceState {
    const inventory = resolveServerScopedMachineInventory<Machine>({
        serverId: ref.qualifiedId.serverId, activeServerId: '', activeMachines: [],
        machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId,
    });
    if (inventory.machines?.some(machine => machine.id === ref.qualifiedId.id)) return 'ready';
    return inventory.status === 'error' || inventory.status === 'signedOut'
        || inventory.status === 'idle' && inventory.machines !== null ? 'settled' : 'loading';
}

type PagedEntitySource = Pick<WorkflowRunWindow, 'status' | 'hasMore' | 'loadingMore' | 'loadMoreFailed'>;

/** The Workflow and Run readers own continuation and failure; the Board consumes that same lifecycle. */
export function readBoardPagedEntitySourceState(source: PagedEntitySource): 'settled' | 'loading' {
    return source.status === 'failed' || source.loadMoreFailed || source.status === 'loaded' && !source.hasMore
        ? 'settled' : 'loading';
}

export function shouldLoadNextBoardEntityPage(source: PagedEntitySource, missing: boolean): boolean {
    return missing && source.status === 'loaded' && source.hasMore && !source.loadingMore && !source.loadMoreFailed;
}
