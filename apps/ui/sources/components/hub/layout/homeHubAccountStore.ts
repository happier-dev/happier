import { getHomeHubDefaultLayoutV1, HomeHubMutationErrorV1, createHomeHubArtifactPortV1, type HomeHubArtifactTransportV1,
    type HomeHubLayoutIntent, type HomeHubLayoutValue, applyHomeHubLayoutIntent, HOME_HUB_BUILTIN_DEFINITIONS,
    buildHomeHubArtifactIdV1, HOME_HUB_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/home';
import { getDemoModeServerId, isSeededDemoHome } from '@/demoMode/runtime/enterExitDemoMode';

export type HomeHubReadState = Readonly<{
    layout: HomeHubLayoutValue;
    status: 'loading' | 'ready' | 'error';
    hasSnapshot: boolean;
    isWriting: boolean;
    /** Queue-owned outstanding intents, including the currently executing write. */
    pendingIntents: readonly HomeHubLayoutIntent[];
    errorCode?: string;
    failedIntent?: HomeHubLayoutIntent;
}>;

/** A validated mutation receipt survived, but its subsequent projection read did not. */
export class HomeHubAcknowledgedProjectionReadError extends Error {
    readonly code: string;
    constructor(error: unknown) {
        super('Home layout projection unavailable after acknowledgement');
        this.code = error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code : 'home_hub_projection_unavailable';
    }
}

/** A mounted projection of the Artifact owner. Only Actions admit and acknowledge edits. */
export function createHomeHubAccountStore(input: Readonly<{
    accountId: string;
    transport: HomeHubArtifactTransportV1;
    isCurrent(): boolean;
    execute(intent: HomeHubLayoutIntent): Promise<HomeHubLayoutValue>;
}>) {
    let state: HomeHubReadState = { layout: getHomeHubDefaultLayoutV1(), status: 'loading', hasSnapshot: false, isWriting: false, pendingIntents: [] };
    let writes = 0;
    let refreshing: Promise<void> | null = null;
    let tail: Promise<void> = Promise.resolve();
    const listeners = new Set<() => void>();
    const set = (next: HomeHubReadState) => {
        if (!input.isCurrent()) return;
        if (JSON.stringify(state) === JSON.stringify(next)) return;
        if (JSON.stringify(state.layout) === JSON.stringify(next.layout)) next = { ...next, layout: state.layout };
        state = next;
        for (const listener of listeners) listener();
    };
    const reader = createHomeHubArtifactPortV1(input.transport, { accountId: input.accountId, shouldContinue: input.isCurrent });
    const errorCode = (error: unknown) => error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'home_hub_unavailable';
    const refresh = () => {
        if (!input.isCurrent()) return Promise.resolve();
        if (refreshing) return refreshing;
        const before = writes;
        refreshing = reader.read().then(layout => {
            if (before === writes) set({ layout, status: state.failedIntent ? 'error' : 'ready', hasSnapshot: true,
                isWriting: state.isWriting, pendingIntents: state.pendingIntents,
                ...(state.failedIntent ? { failedIntent: state.failedIntent, errorCode: state.errorCode } : {}) });
        }, error => { if (before === writes) set({ ...state, status: 'error', errorCode: errorCode(error) }); })
            .finally(() => { refreshing = null; });
        return refreshing;
    };
    const dispatch = (intent: HomeHubLayoutIntent, options?: Readonly<{ rethrow?: boolean }>) => {
        // Each invocation has its own queue entry even when two callers submit the same intent object.
        const queuedIntent = { ...intent };
        if (input.isCurrent()) set({ ...state, isWriting: true, pendingIntents: [...state.pendingIntents, queuedIntent] });
        const operation = tail.then(async () => {
            if (!input.isCurrent()) {
                if (options?.rethrow) throw new HomeHubMutationErrorV1('home_hub_scope_retired');
                return;
            }
            writes++;
            try {
                const layout = await input.execute(queuedIntent);
                set({ layout, status: 'ready', hasSnapshot: true, isWriting: state.isWriting, pendingIntents: state.pendingIntents });
            } catch (error) {
                if (error instanceof HomeHubAcknowledgedProjectionReadError) {
                    // The invoker keeps its actual ACK. Recovery rereads the projection,
                    // never replays the mutation whose receipt was already validated.
                    set({ layout: state.layout, status: 'error', hasSnapshot: state.hasSnapshot,
                        isWriting: state.isWriting, pendingIntents: state.pendingIntents, errorCode: errorCode(error) });
                    return;
                }
                set({ ...state, status: 'error', failedIntent: queuedIntent, errorCode: errorCode(error) });
                if (options?.rethrow) throw error;
            }
        });
        // A checked caller observes failure without poisoning the existing retry/write queue.
        const queuedCompletion = operation.catch(() => {});
        tail = queuedCompletion;
        void operation.finally(() => {
            const pendingIntents = state.pendingIntents.filter(entry => entry !== queuedIntent);
            set({ ...state, pendingIntents, isWriting: pendingIntents.length > 0 });
        }).catch(() => {});
        return operation;
    };
    return {
        getSnapshot: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        refresh, dispatch,
        retire() {
            // Retirement publishes no new Account content; it only ends this old queue's busy presentation.
            if (!state.isWriting) return;
            state = { ...state, isWriting: false, pendingIntents: [] };
            for (const listener of listeners) listener();
        },
        retry: (options?: Readonly<{ rethrow?: boolean }>) => state.failedIntent ? dispatch(state.failedIntent, options) : refresh(),
        cancelFailedIntent: () => {
            if (!state.failedIntent) return;
            // Discard only the rejected intent. The acknowledged layout and Artifact writer stay intact.
            set({ layout: state.layout, status: state.hasSnapshot ? 'ready' : 'loading', hasSnapshot: state.hasSnapshot,
                isWriting: state.isWriting, pendingIntents: state.pendingIntents });
        },
    };
}

let demoProjection: ReturnType<typeof createHomeHubAccountStore> | null = null;

/** The same Artifact projection, hydrated without credentials for the seeded Home only. */
export function getDemoHomeHubAccountProjection(serverId: string) {
    return isSeededDemoHome(serverId) ? demoProjection : null;
}

export async function setDemoHomeHubAccountProjection(serverId: string | null): Promise<void> {
    demoProjection?.retire();
    demoProjection = null;
    if (!serverId) return;
    if (getDemoModeServerId() !== serverId) throw new Error('Demo Home layout requires an active seeded Home');
    const refuse = async (): Promise<never> => { throw new Error('Demo Home layout is read only'); };
    const layout = applyHomeHubLayoutIntent(getHomeHubDefaultLayoutV1(), HOME_HUB_BUILTIN_DEFINITIONS, [],
        { kind: 'visibility', sectionId: 'setup', hidden: true });
    const projection: ReturnType<typeof createHomeHubAccountStore> = createHomeHubAccountStore({
        accountId: 'demo-home',
        transport: { read: async () => ({ artifactId: buildHomeHubArtifactIdV1('demo-home'), ownerAccountId: 'demo-home',
            header: { kind: HOME_HUB_ARTIFACT_KIND_V1, v: 1 }, body: JSON.stringify(layout),
            revision: { headerVersion: 1, bodyVersion: 1 } }), create: refuse, update: refuse },
        isCurrent: () => getDemoModeServerId() === serverId && demoProjection === projection,
        execute: refuse,
    });
    demoProjection = projection;
    await projection.refresh();
}
