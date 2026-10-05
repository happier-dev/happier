import { HOME_HUB_DEFAULT_LAYOUT, HomeHubMutationErrorV1, createHomeHubArtifactPortV1, type HomeHubArtifactTransportV1,
    type HomeHubLayoutIntent, type HomeHubLayoutValue } from '@happier-dev/protocol/home';

export type HomeHubReadState = Readonly<{
    layout: HomeHubLayoutValue;
    status: 'loading' | 'ready' | 'error';
    hasSnapshot: boolean;
    errorCode?: string;
    failedIntent?: HomeHubLayoutIntent;
}>;

/** A mounted projection of the Artifact owner. Only Actions admit and acknowledge edits. */
export function createHomeHubAccountStore(input: Readonly<{
    accountId: string;
    transport: HomeHubArtifactTransportV1;
    isCurrent(): boolean;
    execute(intent: HomeHubLayoutIntent): Promise<HomeHubLayoutValue>;
}>) {
    let state: HomeHubReadState = { layout: HOME_HUB_DEFAULT_LAYOUT, status: 'loading', hasSnapshot: false };
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
                ...(state.failedIntent ? { failedIntent: state.failedIntent, errorCode: state.errorCode } : {}) });
        }, error => { if (before === writes) set({ ...state, status: 'error', errorCode: errorCode(error) }); })
            .finally(() => { refreshing = null; });
        return refreshing;
    };
    const dispatch = (intent: HomeHubLayoutIntent, options?: Readonly<{ rethrow?: boolean }>) => {
        const operation = tail.then(async () => {
            if (!input.isCurrent()) {
                if (options?.rethrow) throw new HomeHubMutationErrorV1('home_hub_scope_retired');
                return;
            }
            writes++;
            try {
                const layout = await input.execute(intent);
                set({ layout, status: 'ready', hasSnapshot: true });
            } catch (error) {
                set({ ...state, status: 'error', failedIntent: intent, errorCode: errorCode(error) });
                if (options?.rethrow) throw error;
            }
        });
        // A checked caller observes failure without poisoning the existing retry/write queue.
        tail = operation.catch(() => {});
        return operation;
    };
    return {
        getSnapshot: () => state,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        refresh, dispatch,
        retry: () => state.failedIntent ? dispatch(state.failedIntent) : refresh(),
        cancelFailedIntent: () => {
            if (!state.failedIntent) return;
            // Discard only the rejected intent. The acknowledged layout and Artifact writer stay intact.
            set({ layout: state.layout, status: state.hasSnapshot ? 'ready' : 'loading', hasSnapshot: state.hasSnapshot });
        },
    };
}
