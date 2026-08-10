import type { Message } from '@/sync/domains/messages/messageTypes';

type StoreHooksModule = typeof import('@/sync/store/hooks');

type SessionMessagesResult = ReturnType<StoreHooksModule['useSessionMessages']>;
type SessionMessagesReducerState = ReturnType<StoreHooksModule['useSessionMessagesReducerState']>;
type SubagentSourceMessages = ReturnType<StoreHooksModule['useSessionSubagentSourceMessages']>;

const emptyTestkitSessionMessages = [] as Message[];
const emptyTestkitSubagentSourceMessages = [] as SubagentSourceMessages;
const emptyTestkitSessionReducerState = null as unknown as SessionMessagesReducerState;

/**
 * Live session state for one session id. Feeds both `@/sync/domains/state/storage` and
 * `@/sync/store/hooks`, which re-export the same three session-message hooks.
 */
export type TestkitSessionMessagesState = Readonly<{
    messages?: readonly Message[];
    isLoaded?: boolean;
    reducerState?: SessionMessagesReducerState | null;
    /** Defaults to `messages`; set it only when a test needs the two to diverge. */
    subagentSourceMessages?: readonly Message[];
}>;

export type CreateSessionMessagesHooksMockOptions = Readonly<{
    bySessionId?: Readonly<Record<string, TestkitSessionMessagesState>>;
}>;

export type SessionMessagesHooksMock = Pick<
    StoreHooksModule,
    'useSessionMessages' | 'useSessionMessagesReducerState' | 'useSessionSubagentSourceMessages'
>;

/**
 * Session-message hooks that can express live agent state instead of a pinned empty transcript.
 *
 * With no configured session the results are the storage stub's historical defaults, so existing
 * tests keep the behaviour they were written against; a configured session returns the fixture.
 * Spread the result into `createStorageModuleStub` / `installPartialStorageModuleMock` /
 * `installPartialStoreHooksModuleMock` overrides — it is not a separate installation mechanism.
 *
 * Scope is the three session-message hooks agent surfaces read. The storage stub's transcript hooks
 * (`useSessionMessagesById`, `useSessionTranscriptIds`, `useSessionMessagesVersion`) keep their own
 * empty defaults; a test needing those live should seed the store instead of the module stub.
 */
export function createSessionMessagesHooksMock(
    options: CreateSessionMessagesHooksMockOptions = {},
): SessionMessagesHooksMock {
    // Resolve every configured session once. Agent surfaces put these results straight into
    // `useMemo` dependency arrays, so allocating per render would thrash their derivations.
    const resolvedBySessionId = new Map<string, Readonly<{
        messages: SessionMessagesResult;
        reducerState: SessionMessagesReducerState;
        subagentSourceMessages: SubagentSourceMessages;
    }>>();
    for (const [sessionId, state] of Object.entries(options.bySessionId ?? {})) {
        const messages = (state.messages ?? emptyTestkitSessionMessages) as Message[];
        resolvedBySessionId.set(sessionId, {
            messages: { messages, isLoaded: state.isLoaded ?? true },
            reducerState: (state.reducerState ?? emptyTestkitSessionReducerState) as SessionMessagesReducerState,
            subagentSourceMessages: (state.subagentSourceMessages ?? messages) as SubagentSourceMessages,
        });
    }

    return {
        useSessionMessages: ((sessionId: string, hookOptions?: Readonly<{ enabled?: boolean }>) => {
            const resolved = resolvedBySessionId.get(sessionId);
            if (!resolved || hookOptions?.enabled === false) return { messages: [], isLoaded: true };
            return resolved.messages;
        }) as StoreHooksModule['useSessionMessages'],
        useSessionMessagesReducerState: ((sessionId: string) => (
            resolvedBySessionId.get(sessionId)?.reducerState ?? emptyTestkitSessionReducerState
        )) as StoreHooksModule['useSessionMessagesReducerState'],
        useSessionSubagentSourceMessages: ((sessionId: string) => (
            resolvedBySessionId.get(sessionId)?.subagentSourceMessages ?? emptyTestkitSubagentSourceMessages
        )) as StoreHooksModule['useSessionSubagentSourceMessages'],
    };
}
