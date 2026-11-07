import { buildWorkBoardItemKeyV1, type BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';
import type { PluginWorkItemV1 } from '@happier-dev/protocol/plugins/contributions/workItems';
import {
    resolvePluginUiClientWorkItemsRegistration,
    type PluginUiClientExecutableRegistrationReader,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createBoardTaskActionContext } from './boardTaskActionContext';

export type BoardTaskSource = Parameters<typeof resolvePluginUiClientWorkItemsRegistration>[0]['source'];
export type BoardTaskItems = Readonly<{
    refs: readonly BoardItemRefV1[];
    /** Only proven filter discoveries, never unrelated explicit picks. */
    linkedRefs: readonly BoardItemRefV1[];
    items: ReadonlyMap<string, PluginWorkItemV1 | null>;
    complete: boolean;
    /** Every demanded reader has answered, including incomplete or unavailable answers. */
    settled: boolean;
    /** Re-read the demanded batch after a source Action, including sources without watch. */
    refresh?: () => void;
}>;

/** The visit's demanded reads and watches share the same public contribution lifetimes. */
export function subscribeBoardTaskItems(input: Parameters<typeof readBoardTaskItems>[0], publish: (items: BoardTaskItems) => void) {
    let stopped = false;
    let watchesComplete = true;
    const states = new Map<BoardTaskSource, { pending: Promise<void> | null; again: boolean; result: BoardTaskItems | null }>();
    const publishCurrent = () => {
        if (stopped || input.signal.aborted) return;
        const refs = new Map<string, BoardItemRefV1>(input.refs.filter(ref => ref.kind === 'task').map(ref => [buildWorkBoardItemKeyV1(ref), ref]));
        const linked = new Map<string, BoardItemRefV1>();
        const items = new Map<string, PluginWorkItemV1 | null>([...refs.keys()].map(key => [key, null]));
        let complete = watchesComplete;
        let settled = true;
        for (const source of input.sources) {
            const state = states.get(source);
            if (!state) continue;
            if (!state.result) { complete = false; settled = false; continue; }
            complete &&= state.result.complete;
            for (const ref of state.result.refs) refs.set(buildWorkBoardItemKeyV1(ref), ref);
            for (const ref of state.result.linkedRefs) linked.set(buildWorkBoardItemKeyV1(ref), ref);
            for (const [key, item] of state.result.items) items.set(key, item);
        }
        publish({ refs: [...refs.values()], linkedRefs: [...linked.values()], items, complete, settled });
    };
    const refreshSource = (source: BoardTaskSource): Promise<void> => {
        const state = states.get(source);
        if (!state || stopped || input.signal.aborted) return Promise.resolve();
        if (state.pending) { state.again = true; return state.pending; }
        const refs = input.refs.filter(ref => ref.kind === 'task' && ref.pluginId === source.pluginId);
        state.pending = (async () => {
            do {
                state.again = false;
                try {
                    state.result = await readBoardTaskItems({ ...input, refs, sources: [source] });
                } catch {
                    state.result = { refs, linkedRefs: [], items: new Map(), complete: false, settled: true };
                }
                publishCurrent();
            } while (state.again && !stopped && !input.signal.aborted);
        })().finally(() => { state.pending = null; });
        return state.pending;
    };
    const stops: (() => void)[] = [];
    for (const source of input.sources) {
        const registration = resolvePluginUiClientWorkItemsRegistration({ source, platform: input.platform, reader: input.reader });
        const runtime = registration?.runtime;
        const itemIds = input.refs.filter(ref => ref.kind === 'task' && ref.pluginId === source.pluginId
            && areServerProfileIdentifiersEquivalent(ref.qualifiedId.serverId, input.serverId)).map(ref => ref.qualifiedId.id);
        if (itemIds.length === 0 && input.sessions.length === 0) continue;
        states.set(source, { pending: null, again: false, result: null });
        try {
            if (runtime?.watch && registration) {
                const owner = createBoardTaskActionContext({ ...input, source, registration: registration.registration });
                try {
                    const stop = runtime.watch({ serverId: input.serverId, itemIds,
                        sessionIds: input.sessions.map(session => session.sessionId) }, () => { void refreshSource(source); }, owner.context);
                    stops.push(() => { try { stop(); } finally { owner.dispose(); } });
                } catch (error) { owner.dispose(); throw error; }
            }
        } catch { watchesComplete = false; states.delete(source); }
    }
    const refresh = async () => { await Promise.all([...states.keys()].map(refreshSource)); if (states.size === 0) publishCurrent(); };
    void refresh();
    return { refresh, stop() { if (stopped) return; stopped = true; for (const stop of stops) stop(); } };
}

/** Resolves only demanded work through the existing current client registration; stores no task data. */
export async function readBoardTaskItems(input: Readonly<{
    serverId: string;
    refs: readonly BoardItemRefV1[];
    sessions: readonly Readonly<{ serverId: string; sessionId: string }>[];
    sources: readonly BoardTaskSource[];
    platform: Parameters<typeof resolvePluginUiClientWorkItemsRegistration>[0]['platform'];
    reader?: PluginUiClientExecutableRegistrationReader;
    signal: AbortSignal;
    accountLifetime?: Parameters<typeof createBoardTaskActionContext>[0]['accountLifetime'];
    pluginUiProjection?: Parameters<typeof createBoardTaskActionContext>[0]['pluginUiProjection'];
}>): Promise<BoardTaskItems> {
    const refs = new Map(input.refs.filter(ref => ref.kind === 'task').map(ref => [buildWorkBoardItemKeyV1(ref), ref]));
    const items = new Map<string, PluginWorkItemV1 | null>([...refs.keys()].map(key => [key, null]));
    const linkedRefs = new Map<string, BoardItemRefV1>();
    const sessionIds = [...new Set(input.sessions.filter(session => areServerProfileIdentifiersEquivalent(session.serverId, input.serverId))
        .map(session => session.sessionId))];
    const results = await Promise.all(input.sources.map(async source => {
        const selected = [...refs.values()].filter(ref => ref.kind === 'task' && ref.pluginId === source.pluginId
            && areServerProfileIdentifiersEquivalent(ref.qualifiedId.serverId, input.serverId));
        const result: { entries: [string, PluginWorkItemV1 | null][]; linked: Extract<BoardItemRefV1, { kind: 'task' }>[]; complete: boolean } = {
            entries: [], linked: [], complete: true,
        };
        if (selected.length === 0 && sessionIds.length === 0) return result;
        const registration = resolvePluginUiClientWorkItemsRegistration({ source, platform: input.platform, reader: input.reader });
        if (!registration) return { ...result, complete: false };
        let owner: ReturnType<typeof createBoardTaskActionContext> | undefined;
        try {
            owner = createBoardTaskActionContext({ ...input, source, registration: registration.registration });
            const discovery = sessionIds.length > 0 && registration.runtime.findLinked
                ? await registration.runtime.findLinked({ serverId: input.serverId, sessionIds }, owner.context)
                : { itemIds: [], complete: true };
            result.complete = discovery.complete;
            const linked = discovery.itemIds;
            const ids = [...new Set([...selected.map(ref => ref.qualifiedId.id), ...linked])];
            if (ids.length === 0) return result;
            const resolved = await registration.runtime.resolve({ serverId: input.serverId, itemIds: ids }, owner.context);
            input.signal.throwIfAborted();
            for (const id of ids) {
                const item = resolved[id] ?? null;
                const explicit = selected.filter(ref => ref.qualifiedId.id === id);
                for (const ref of explicit) result.entries.push([buildWorkBoardItemKeyV1(ref), item]);
                // A source lookup discovers candidates; the same returned live link facts prove filter membership.
                if (!item || !linked.includes(id) || !item.linkedSessions.some(session =>
                    areServerProfileIdentifiersEquivalent(session.serverId, input.serverId) && sessionIds.includes(session.sessionId))) continue;
                const ref: Extract<BoardItemRefV1, { kind: 'task' }> = explicit[0] ?? { kind: 'task', pluginId: source.pluginId, qualifiedId: { serverId: input.serverId, id } };
                const key = buildWorkBoardItemKeyV1(ref);
                result.linked.push(ref);
                result.entries.push([key, item]);
            }
        } catch (error) {
            if (input.signal.aborted) throw error;
            return { ...result, entries: [], linked: [], complete: false };
        } finally { owner?.dispose(); }
        return result;
    }));
    input.signal.throwIfAborted();
    // Source order, not network completion order, determines the Board's discovery order.
    for (const result of results) {
        for (const [key, item] of result.entries) items.set(key, item);
        for (const ref of result.linked) {
            const key = buildWorkBoardItemKeyV1(ref);
            refs.set(key, ref);
            linkedRefs.set(key, ref);
        }
    }
    return { refs: [...refs.values()], linkedRefs: [...linkedRefs.values()], items, complete: results.every(result => result.complete), settled: true };
}
