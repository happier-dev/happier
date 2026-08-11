import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildAgentActivityEntryId,
    type SessionAgentActivityEntryV1,
    type SessionAgentActivityHeadlineV1,
} from '@happier-dev/protocol';

import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The unified spine, exercised where every surface consumes it.
 *
 * The deciding check is R-3: a session opened cold, whose transcript has not paged in the messages
 * that launched its agents, must still show every agent. That can only pass if the headline the CLI
 * publishes is actually read AND its entries are actually joined to local ones — a producer that
 * publishes into a consumer that ignores it looks identical to a working system in every other test.
 *
 * The join is what the second test guards, and it is the quiet failure of this phase: the CLI names
 * an agent `workflow_agent:<runId>:<toolUseId>`, this process derives the same Task as
 * `subagent_sidechain:<toolUseId>`, and merging by id alone renders every agent twice with every
 * schema valid.
 */

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/s1' }).module;
});

// Genuine system boundaries: the sync façade and the execution-run RPCs.
vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(async () => 'loaded' as const),
        getSyncTuning: () => ({ sidechainDemandHydrationConcurrencyLimit: 2 }),
    },
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunList: vi.fn(async () => ({ ok: true, runs: [] })),
    sessionExecutionRunStop: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/components/sessions/model/useDirectSessionRuntime', () => ({
    useDirectSessionRuntime: () => ({
        directSessionLink: null,
        status: null,
        refreshNow: async () => null,
    }),
}));

const SESSION_ID = 's1';
const IMPLICIT_RUN_ID = 'implicit:agent-activity';

let testkit: typeof import('@/dev/testkit');
let storage: typeof import('@/sync/domains/state/storageStore')['storage'];
let useSessionAgentActivity: typeof import('./useSessionAgentActivity')['useSessionAgentActivity'];
let previousStorageState: ReturnType<(typeof storage)['getState']> | null = null;

/** An agent named by the CLI, spelled through the protocol builder both sides import. */
function publishedAgent(params: Readonly<{
    key: string;
    title: string;
    status?: SessionAgentActivityEntryV1['status'];
    runId?: string;
}>): SessionAgentActivityEntryV1 {
    const runId = params.runId ?? IMPLICIT_RUN_ID;
    return {
        entryId: buildAgentActivityEntryId({
            kind: 'workflow_agent',
            runId,
            // The CLI knows an agent by the SDK tool-use id, which is the same string this process
            // sees as the transcript tool call's id and as its sidechain id.
            agentId: testkit.agentActivityFixtureSidechainId(params.key),
        }),
        kind: 'workflow_agent',
        title: params.title,
        status: params.status ?? 'running',
        updatedAt: 5_000,
        startedAt: 1_000,
        runId,
        parentId: buildAgentActivityEntryId({ kind: 'workflow_run', runId }),
    };
}

function publishedRun(runId = IMPLICIT_RUN_ID): SessionAgentActivityEntryV1 {
    return {
        entryId: buildAgentActivityEntryId({ kind: 'workflow_run', runId }),
        kind: 'workflow_run',
        title: 'Agent activity',
        status: 'running',
        updatedAt: 5_000,
        runId,
    };
}

function makeHeadline(entries: readonly SessionAgentActivityEntryV1[]): SessionAgentActivityHeadlineV1 {
    return {
        v: 1,
        backendId: 'claude',
        updatedAt: 5_000,
        activeEntries: [...entries],
    };
}

function seed(params: Readonly<{
    subagents?: readonly { key: string; title: string; status?: 'running' | 'succeeded' | 'failed' }[];
    headline?: SessionAgentActivityHeadlineV1 | null;
    flavor?: string;
}>) {
    const fixture = testkit.makeSessionAgentActivityFixture({
        sessionId: SESSION_ID,
        flavor: params.flavor ?? 'claude',
        subagents: params.subagents ?? [],
        session: params.headline
            // `path`/`host` are required by the metadata schema; the fixture merges the rest.
            ? { metadata: { path: '', host: '', sessionAgentActivityHeadlineV1: params.headline } }
            : {},
    });
    storage.setState((state) => ({
        ...state,
        sessions: { ...state.sessions, [fixture.sessionId]: fixture.session },
        sessionMessages: { ...state.sessionMessages, ...fixture.storeSessionMessagesBySessionId },
    }));
    return fixture;
}

async function renderActivity() {
    return testkit.renderHook(() => useSessionAgentActivity({ sessionId: SESSION_ID }));
}

/**
 * The units of WORK in the one list the hook publishes.
 *
 * The hook used to publish this partition as a second `rows` field that no host read. Applying it
 * here instead keeps the assertions the same while leaving the hook with a single roster-shaped
 * value, which is what stops a future reader from asking the wrong one what exists.
 */
function workEntries<T extends Readonly<{ kind: string }>>(entries: readonly T[]): readonly T[] {
    return entries.filter((entry) => entry.kind !== 'workflow_run');
}

describe('useSessionAgentActivity', () => {
    beforeAll(async () => {
        testkit = await import('@/dev/testkit');
        ({ storage } = await import('@/sync/domains/state/storageStore'));
        ({ useSessionAgentActivity } = await import('./useSessionAgentActivity'));
    }, 300_000);

    beforeEach(() => {
        previousStorageState = storage.getState();
    });

    afterEach(() => {
        testkit.standardCleanup();
        if (previousStorageState) storage.setState(previousStorageState);
        // Reseeding one session id is "this session's transcript memory was released and rebuilt".
        // Without the production release seam, the per-session LRU behind
        // `useSessionSubagentSourceMessages` still holds the previous test's messages at the same
        // `subagentSourceVersion` and silently serves them to the next one.
        clearSessionTranscriptDerivedCachesForSession(SESSION_ID);
    });

    // R-3, the deciding check. No subagent tool call is in the transcript at all — this is a long
    // session whose agents were launched hundreds of messages ago — and the roster is still complete.
    it('serves a complete roster from the headline with no transcript to derive from', async () => {
        seed({
            subagents: [],
            headline: makeHeadline([
                publishedRun(),
                publishedAgent({ key: 'alpha', title: 'Audit the auth flow' }),
                publishedAgent({ key: 'beta', title: 'Write the migration' }),
                publishedAgent({ key: 'gamma', title: 'Review the diff', status: 'succeeded' }),
            ]),
        });

        const { getCurrent } = await renderActivity();
        const activity = getCurrent();

        expect(activity.headlineSource).toBe('agentActivity');
        expect(workEntries(activity.entries).map((row) => row.title)).toEqual([
            'Audit the auth flow',
            'Write the migration',
            'Review the diff',
        ]);
        // INV-2: a headline entry with nothing loaded behind it still renders, and says so.
        expect(activity.entries.every((row) => row.provenance === 'headline')).toBe(true);
        expect(activity.entries.every((row) => row.detailState === 'unloaded')).toBe(true);
        // The grouping the CLI publishes around them is in the model and out of the roster, so
        // "Agent activity" is not a row and is not a fourth agent.
        expect(activity.entries).toHaveLength(4);
        expect(activity.counts).toMatchObject({ total: 3, live: 2 });
    }, 120_000);

    // THE quiet failure this phase exists to prevent.
    it('renders one row for an agent both the headline and the transcript describe', async () => {
        seed({
            subagents: [
                { key: 'alpha', title: 'Audit the auth flow', status: 'running' },
                { key: 'beta', title: 'Write the migration', status: 'running' },
            ],
            headline: makeHeadline([
                publishedRun(),
                publishedAgent({ key: 'alpha', title: 'Audit the auth flow' }),
                publishedAgent({ key: 'beta', title: 'Write the migration' }),
            ]),
        });

        const { getCurrent } = await renderActivity();
        const activity = getCurrent();

        const work = workEntries(activity.entries);
        expect(work).toHaveLength(2);
        expect(work.every((row) => row.provenance === 'merged')).toBe(true);
        expect(activity.counts.total).toBe(2);
        // The headline's id wins, so a surface keys this agent the same way whichever source it saw
        // first — and the local subagent behind it is still reachable for actions and navigation.
        expect(work[0]?.id).toContain('workflow_agent:');
        expect(activity.readSubagentForEntry(work[0]!.id)?.id)
            .toBe(testkit.agentActivityFixtureSubagentId('alpha'));
        expect(work[0]?.actions.length).toBeGreaterThan(0);
    }, 120_000);

    // INV-1: the CLI has terminal evidence this process does not; the roster must not keep claiming
    // the agent is running just because its tool call has no result yet.
    it('takes the headline status over the locally derived one', async () => {
        seed({
            subagents: [{ key: 'alpha', title: 'Audit the auth flow', status: 'running' }],
            headline: makeHeadline([
                publishedAgent({ key: 'alpha', title: 'Audit the auth flow', status: 'failed' }),
            ]),
        });

        const { getCurrent } = await renderActivity();

        expect(workEntries(getCurrent().entries)[0]?.status).toBe('failed');
        expect(getCurrent().counts).toMatchObject({ live: 0, failed: 1 });
    }, 120_000);

    // The §5.2 degrade, as a first-class case: the publisher is composed for Claude only, so a
    // Codex, Gemini or OpenCode session has no headline at all and must be indistinguishable from
    // today rather than empty or broken.
    it('serves the local roster for a backend that publishes no headline', async () => {
        seed({
            flavor: 'codex',
            subagents: [
                { key: 'alpha', title: 'Audit the auth flow', status: 'running' },
                { key: 'beta', title: 'Write the migration', status: 'succeeded' },
            ],
            headline: null,
        });

        const { getCurrent } = await renderActivity();
        const activity = getCurrent();

        expect(activity.headlineSource).toBe('none');
        expect(activity.entries).toHaveLength(2);
        expect(activity.entries.every((row) => row.provenance === 'local')).toBe(true);
        expect(activity.counts).toMatchObject({ total: 2, live: 1 });
    }, 120_000);

    // INV-3. The tempting wrong implementation is the repo's own "preserve last-known-good" habit:
    // hold the previous roster so a headline republish cannot flash the pane empty. Applied to
    // existence it turns a removed agent into a permanent ghost at its last known status.
    it('drops an entry both sources stopped reporting instead of freezing its last status', async () => {
        const withAgent = makeHeadline([
            publishedAgent({ key: 'alpha', title: 'Audit the auth flow' }),
            publishedAgent({ key: 'beta', title: 'Write the migration' }),
        ]);
        seed({ subagents: [], headline: withAgent });

        const { getCurrent } = await renderActivity();
        expect(getCurrent().entries).toHaveLength(2);

        await act(async () => {
            storage.setState((state) => {
                const session = state.sessions[SESSION_ID]!;
                return {
                    ...state,
                    sessions: {
                        ...state.sessions,
                        [SESSION_ID]: {
                            ...session,
                            metadata: {
                                ...(session.metadata ?? { path: '', host: '' }),
                                sessionAgentActivityHeadlineV1: makeHeadline([
                                    publishedAgent({ key: 'alpha', title: 'Audit the auth flow' }),
                                ]),
                            },
                        },
                    },
                };
            });
            await testkit.flushHookEffects();
        });

        expect(getCurrent().entries.map((row) => row.title)).toEqual(['Audit the auth flow']);
    }, 120_000);

    // INV-4. The rows are memoized on these entry objects, so a store tick that republishes an equivalent
    // headline must not hand the list a fresh array of fresh objects: the merge is pure and rebuilds
    // everything, and only the reconciliation step keeps a roster from re-rendering wholesale on
    // every metadata write. Rerendering with unchanged props would prove nothing — the memos would
    // not even run.
    it('keeps entry identity when the store republishes an equivalent headline', async () => {
        seed({
            subagents: [{ key: 'alpha', title: 'Audit the auth flow', status: 'running' }],
            headline: makeHeadline([publishedAgent({ key: 'alpha', title: 'Audit the auth flow' })]),
        });

        const { getCurrent } = await renderActivity();
        const before = getCurrent();
        expect(before.entries).toHaveLength(1);

        await act(async () => {
            storage.setState((state) => {
                const session = state.sessions[SESSION_ID]!;
                return {
                    ...state,
                    sessions: {
                        ...state.sessions,
                        [SESSION_ID]: {
                            ...session,
                            // A new metadata object carrying the same facts — exactly what a
                            // progress-tick republish looks like from this side.
                            metadata: {
                                ...(session.metadata ?? { path: '', host: '' }),
                                sessionAgentActivityHeadlineV1: makeHeadline([
                                    publishedAgent({ key: 'alpha', title: 'Audit the auth flow' }),
                                ]),
                            },
                        },
                    },
                };
            });
            await testkit.flushHookEffects();
        });

        const after = getCurrent();
        expect(after.entries).toBe(before.entries);
        expect(after.entries[0]).toBe(before.entries[0]);
    }, 120_000);

    /**
     * R-11, as an executable guard rather than a comment.
     *
     * This hook feeds the composer badge, the session header glyph and the Agents tab badge — three
     * surfaces that need a number and must not re-render per streamed token to get it. The measured
     * defect (P-2) was exactly that: agent surfaces reading the full transcript instead of the
     * subagent-source projection. The rule is easy to break by accident — one extra
     * `useSessionMessages` or `useSessionMessagesReducerSnapshot` anywhere below this hook restores
     * it — and nothing else in the suite would notice.
     *
     * The control render is what makes this discriminating: it proves the store really changed, so
     * a green here cannot come from a mutation that did nothing. Assert only the narrow side and a
     * typo in the fixture would look identical to a perfectly narrow hook.
     */
    it('does not re-render for a transcript message the roster does not read', async () => {
        seed({ subagents: [{ key: 'alpha', title: 'Audit the auth flow', status: 'running' }] });

        let narrowRenders = 0;
        let transcriptRenders = 0;
        await testkit.renderHook(() => {
            narrowRenders += 1;
            return useSessionAgentActivity({ sessionId: SESSION_ID });
        });
        const { useSessionMessages } = await import('@/sync/domains/state/storage');
        await testkit.renderHook(() => {
            transcriptRenders += 1;
            return useSessionMessages(SESSION_ID);
        });

        const narrowRendersBefore = narrowRenders;
        const transcriptRendersBefore = transcriptRenders;

        await act(async () => {
            storage.setState((state) => {
                const sessionMessages = state.sessionMessages[SESSION_ID]!;
                // A plain assistant line: real transcript traffic, and nothing an agent roster reads.
                const message = {
                    kind: 'agent-text' as const,
                    id: 'msg_prose',
                    localId: null,
                    createdAt: 2_000,
                    text: 'Looking at the auth flow now.',
                };
                return {
                    ...state,
                    sessionMessages: {
                        ...state.sessionMessages,
                        [SESSION_ID]: {
                            ...sessionMessages,
                            messageIdsOldestFirst: [...sessionMessages.messageIdsOldestFirst, message.id],
                            messagesById: { ...sessionMessages.messagesById, [message.id]: message },
                            messagesMap: { ...sessionMessages.messagesMap, [message.id]: message },
                            messagesVersion: sessionMessages.messagesVersion + 1,
                        },
                    },
                };
            });
            await testkit.flushHookEffects();
        });

        expect(transcriptRenders).toBeGreaterThan(transcriptRendersBefore);
        expect(narrowRenders).toBe(narrowRendersBefore);
    }, 120_000);
});
