import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { Message, UserTextMessage } from "@happier-dev/session-core/messages";
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { EnsureSessionVisibleForRouteResult } from '@/sync/domains/session/sessionRouteHydrationState';

const attributionBoundaries = vi.hoisted(() => ({
    push: vi.fn(), transcriptCommits: vi.fn(),
    // The sync orchestrator is the by-id read boundary a cold sender is demanded through.
    ensureSession: vi.fn(async (sessionId: string, options?: { serverId?: string }): Promise<EnsureSessionVisibleForRouteResult> => ({ kind: 'missing', sessionId, serverId: options?.serverId, cause: 'not_found' })),
}));
vi.mock('@/sync/sync', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/sync')>()),
    sync: { ensureSessionVisibleForMessageRoute: attributionBoundaries.ensureSession },
}));
installMessageViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { push: attributionBoundaries.push } }).module;
    },
});
// Install boundary options before evaluating app modules: the testkit/store graph
// can reach the destination router and otherwise capture the default router mock.
const { createSessionFixture, renderScreen: renderBareScreen, standardCleanup } = await import('@/dev/testkit');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
const { storage } = await import('@/sync/domains/state/storage');
const { createWorkflowInvocationIndexFixture, createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
const { createWorkflowInvocationRoute } = await import('@/sync/domains/workflows/workflowRunRoute');
const { createReadOnlySessionTranscriptSource } = await import('./source/readOnlySessionTranscriptSource');
const { SessionTranscriptSourceProvider } = await import('./source/SessionTranscriptSourceContext');
const { MessageView, MessageViewWithSessionCommon } = await import('./MessageView');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');

// These cases prove the real Home-scoped store-to-authorship path, not snapshot bylines.
function renderScreen(element: React.ReactElement<{ sessionId: string; serverId?: string | null }>) {
    return renderBareScreen(
        <AppSessionTranscriptSourceProvider sessionId={element.props.sessionId} serverId={element.props.serverId}>
            <React.Profiler id="message-attribution" onRender={attributionBoundaries.transcriptCommits}>{element}</React.Profiler>
        </AppSessionTranscriptSourceProvider>,
    );
}

// The persisted shape of an answer another session returned to an Ask (QA15 seq15), with its text.
function returnedAnswerMessage(serverId: string, origin: 'host' | 'happierSession', text: string): UserTextMessage {
    return {
        kind: 'user-text', id: 'returned-answer', localId: 'returned-local', createdAt: 1, text,
        meta: {
            happierProvenanceV1: origin === 'host'
                ? { v: 1, kind: 'host', producer: 'sessionAction' }
                : { v: 1, kind: 'happierSession', sourceSessionId: 'answerer', via: 'mcp' },
            happierInputAuthorityV1: { v: 1, producer: 'sessionAction', permission: { admittedPermissionCeiling: 'read-only' },
                caller: { kind: 'host' },
                returnedAnswer: { requestSessionId: 'answerer', requestLocalId: 'question/1', outcome: 'answer', delivery: 'wake',
                    senderSessionId: 'answerer', sourceMessageRef: { kind: 'session',
                        session: { serverId, sessionId: 'answerer' }, messageId: 'answer-message' } } },
        },
    };
}

afterEach(() => {
    standardCleanup();
    storage.setState(storage.getInitialState(), true);
    attributionBoundaries.push.mockClear();
    attributionBoundaries.transcriptCommits.mockClear();
    attributionBoundaries.ensureSession.mockClear();
});

describe('MessageView Account attribution', () => {
    it.each([false, true])('shows onboarding provenance and a selectable example without exposing its model prompt (display facts: %s)', async (displayFacts) => {
        const { normalizeRawMessage } = await import('@happier-dev/session-core/raw');
        const { createReducer, reducer } = await import('@happier-dev/session-core/reducer');
        const { UserMessageBubble } = await import('./UserMessageBubble');
        const { TranscriptEventRow } = await import('./events/TranscriptEventRow');
        const prompt = 'Host startup instructions containing the example task';
        const normalized = normalizeRawMessage('onboarding', 'creation-first-input', 1, {
            role: 'user', content: { type: 'text', text: prompt }, meta: {
                ...(displayFacts ? { happierHostOnboardingV1: { v: 1, templateName: 'Garden', templateVersion: '1.2.3',
                    authorDisplayName: 'Ana', firstTask: 'Review my change' } } : {}),
                happierProvenanceV1: { v: 1, kind: 'host', producer: 'hostOnboarding' },
                happierInputAuthorityV1: { v: 1, producer: 'hostOnboarding', caller: { kind: 'host' },
                    permission: { admittedPermissionCeiling: 'read-only' } },
            },
        }, { seq: 1 });
        expect(normalized).not.toBeNull();
        const messages = reducer(createReducer(), [normalized!]).messages;
        const source = createReadOnlySessionTranscriptSource({ sessionId: 'bot', messages,
            reducerState: null, metadata: null, agentState: null });
        const screen = await renderBareScreen(<SessionTranscriptSourceProvider source={source}>
            <MessageView sessionId="bot" metadata={null} message={messages[0]} />
        </SessionTranscriptSourceProvider>);
        expect(screen.findAllByType(UserMessageBubble)).toHaveLength(0);
        expect(screen.findAllByType(TranscriptEventRow)).toHaveLength(1);
        expect(screen.getTextContent()).not.toContain(prompt);
        expect(screen.getTextContent()).toContain(displayFacts ? 'Ana' : 'Happier');
        if (displayFacts) {
            expect(screen.getTextContent()).toContain('v1.2.3');
            expect(screen.findByTestId('bot-template-first-task-chip')).toBeTruthy();
        }
        expect(attributionBoundaries.ensureSession).not.toHaveBeenCalled();
    });
    it.each([false, true])('renders retained next-turn Follow sources without inventing accepted wakes (cards: %s)', async (cards) => {
        const { normalizeRawMessage } = await import('@happier-dev/session-core/raw');
        const { createReducer, reducer } = await import('@happier-dev/session-core/reducer');
        const { resolveTranscriptHostWakeCountByMessageId } = await import('./events/transcriptEventEmphasis');
        const { TranscriptFollowSourceNotice } = await import('./events/TranscriptEventRow');
        const { UserMessageBubble } = await import('./UserMessageBubble');
        // Redacted retained producer shape from seq267–273: next_turn, message-backed
        // terminal event, no accepted Turn or turn-start witness. The text is synthetic.
        const prompt = 'Synthetic model-only Follow instructions';
        const normalized = ['finished', 'failed_or_stopped', 'message'].map((kind, index) => normalizeRawMessage(
            `retained-${index}`, `follow-original:${index}`, index + 1,
            { role: 'user', content: { type: 'text', text: prompt }, meta: {
                happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
                happierInputAuthorityV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
                    permission: { admittedPermissionCeiling: 'default' }, followDeliveryV1: {
                        v: 1, delivery: 'next_turn', original: { sourceSessionId: 'worker',
                            sourceMessage: { localId: `source-${index}`, seq: index + 1 } }, event: { kind },
                    } },
            } }, { seq: index + 1 },
        ));
        expect(normalized.every(message => message !== null)).toBe(true);
        const messages = reducer(createReducer(), normalized.filter((message): message is NonNullable<typeof message> => message !== null)).messages;
        if (cards) messages.push(...messages.map((message): Extract<Message, { kind: 'agent-event' }> => ({
            kind: 'agent-event', id: `card-${message.id}`, localId: null, createdAt: 4,
            event: { type: 'worker-update', followInputLocalId: message.localId!, update: {
                v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'finished',
                headline: 'Finished its turn', canInspect: false,
            } },
        })));
        else messages.push({ kind: 'agent-event', id: 'unrelated-card', localId: null, createdAt: 4,
            event: { type: 'worker-update', followInputLocalId: 'another-original', update: {
                v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'finished',
                headline: 'Finished its turn', canInspect: false,
            } } });
        const messagesById = Object.fromEntries(messages.map(message => [message.id, message]));
        const counts = resolveTranscriptHostWakeCountByMessageId({ messageIdsOldestFirst: messages.map(message => message.id), messagesById });
        expect(counts).toEqual({});
        const source = createReadOnlySessionTranscriptSource({ sessionId: 'bot', messages,
            reducerState: null, metadata: null, agentState: null });
        const screen = await renderBareScreen(<SessionTranscriptSourceProvider source={source}>
            {messages.map(message => <MessageView key={message.id} sessionId="bot" metadata={null}
                message={message} hostWakeCount={counts[message.id]} />)}
        </SessionTranscriptSourceProvider>);
        expect(screen.findAllByType(TranscriptFollowSourceNotice)).toHaveLength(cards ? 0 : 3);
        expect(screen.findAllByType(UserMessageBubble)).toHaveLength(0);
        expect(screen.findAllHostsByTestId('transcript-event-host-wake')).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain(prompt);
        // Source notices read held identity; presenting N originals must issue zero by-id hydration reads.
        expect(attributionBoundaries.ensureSession).not.toHaveBeenCalled();
    });

    it.each(['next_turn', 'wake', 'generated'] as const)('keeps committed host %s context outside the person’s bubble and defers Follow notices to delivery facts', async (delivery) => {
        const { normalizeRawMessage } = await import('@happier-dev/session-core/raw');
        const { createReducer, reducer } = await import('@happier-dev/session-core/reducer');
        const { UserMessageBubble } = await import('./UserMessageBubble');
        const { TranscriptEventRow } = await import('./events/TranscriptEventRow');
        // Persisted producer shape observed in QA-R42 Bot seq 101/135/136/137.
        const text = delivery === 'generated' ? 'SCM diff summary generator. Return only valid JSON.'
            : 'Followed source changed. Read the original source context.';
        const meta = {
            happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
            happierInputAuthorityV1: {
                v: 1, producer: 'sessionAction', caller: { kind: 'host' },
                permission: { admittedPermissionCeiling: 'default' },
                ...(delivery === 'generated' ? {} : { followDeliveryV1: { v: 1, delivery,
                    original: { sourceSessionId: 'cmvgukay000kdmcyhj5avwapl',
                        sourceMessage: { localId: '73a3dbcc-6d07-4fac-b2bb-671af06ccf80', seq: 6 } },
                    event: { kind: 'message' } } }),
            },
        };
        const normalized = [
            normalizeRawMessage('follow', 'follow-original:test', 1, { role: 'user', content: { type: 'text', text }, meta }, { seq: 1 }),
            // The words do not classify authorship: a real person can write the same sentence.
            normalizeRawMessage('person', 'person', 2, { role: 'user', content: { type: 'text', text },
                meta: { happierProvenanceV1: { v: 1, kind: 'happierApp', actor: { kind: 'owner' } } } }, { seq: 2 }),
            // Unvalidated authority must not turn an ordinary input into a host notice.
            normalizeRawMessage('invalid-follow', 'invalid-follow', 3, { role: 'user', content: { type: 'text', text },
                meta: { ...meta, happierInputAuthorityV1: { ...meta.happierInputAuthorityV1, followDeliveryV1: { v: 1, delivery } } } }, { seq: 3 }),
        ];
        const messages = reducer(createReducer(), normalized.filter((message): message is NonNullable<typeof message> => message !== null)).messages;
        expect(messages).toHaveLength(3);
        const screen = await renderBareScreen(<AppSessionTranscriptSourceProvider sessionId="bot">
            {messages.map((message) => <MessageViewWithSessionCommon key={message.id}
                sessionId="bot" metadata={null} message={message}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }} />)}
        </AppSessionTranscriptSourceProvider>);
        expect(screen.findAllByType(UserMessageBubble)).toHaveLength(2);
        expect(screen.findAllByType(TranscriptEventRow)).toHaveLength(1);
        expect(screen.getTextContent()).toContain(text);
    });

    it.each([false, true])('shows an accepted Follow wake once as structured host facts without the model prompt (cards: %s)', async (cards) => {
        const { resolveTranscriptHostWakeCountByMessageId } = await import('./events/transcriptEventEmphasis');
        const { indexFollowWorkerCardsByInputLocalId } = await import('./events/followWorkerCardDelivery');
        const text = 'Followed source changed. Read the original source context.';
        const messages: Message[] = [1, 2, 3].map((seq): UserTextMessage => ({
            kind: 'user-text', id: `follow-${seq}`, localId: `follow-input-${seq}`, createdAt: seq, text,
            followDeliveryProjection: { status: 'woke', reason: null },
            meta: {
                happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
                happierInputAuthorityV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
                    permission: { admittedPermissionCeiling: 'default' },
                    followDeliveryV1: { v: 1, delivery: 'wake', original: { sourceSessionId: 'worker',
                        sourceMessage: { localId: `original-${seq}`, seq } }, event: { kind: 'message' } } },
            },
        }));
        if (cards) messages.push(...[1, 2, 3].map((seq): Extract<Message, { kind: 'agent-event' }> => ({
            kind: 'agent-event', id: `card-${seq}`, localId: null, createdAt: seq + 3,
            event: { type: 'worker-update', followInputLocalId: `follow-input-${seq}`, update: {
                v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'finished',
                headline: 'Finished its turn', canInspect: false,
            } },
        })));
        const counts = resolveTranscriptHostWakeCountByMessageId({ messageIdsOldestFirst: messages.map(m => m.id),
            messagesById: Object.fromEntries(messages.map(m => [m.id, m])) });
        const source = createReadOnlySessionTranscriptSource({ sessionId: 'bot', messages,
            reducerState: null, metadata: null, agentState: null });
        const followWorkerCardsByInputLocalId = indexFollowWorkerCardsByInputLocalId(Object.fromEntries(messages.map(message => [message.id, message])));
        const screen = await renderBareScreen(<SessionTranscriptSourceProvider source={source}>
            {messages.map(message => <MessageViewWithSessionCommon key={message.id} sessionId="bot" metadata={null}
                message={message} hostWakeCount={counts[message.id]}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null, followWorkerCardsByInputLocalId }} />)}
        </SessionTranscriptSourceProvider>);
        expect(screen.getTextContent()).not.toContain(text);
        expect(screen.findAllHostsByTestId('transcript-event-host-wake')).toHaveLength(1);
        expect(screen.getTextContent()).toContain('sessionWork.workerUpdate.wokenBy(count=3)');
    });

    it.each(['follow', 'generated'] as const)('keeps host %s origin visible while queued or discarded without removing queue controls', async (kind) => {
        const { PendingMessagesTranscriptBlock } = await import('../pending/PendingMessagesTranscriptBlock');
        const { TranscriptEventRow } = await import('./events/TranscriptEventRow');
        const text = kind === 'generated' ? 'SCM diff summary generator. Return only valid JSON.'
            : 'Followed source changed. Read the original source context.';
        storage.getState().applySessions([createSessionFixture({ id: 'cmvgukay000kdmcyhj5avwapl',
            metadata: { path: '/work', host: 'test', summary: { text: 'Rollback review', updatedAt: 1 } } })]);
        const follow = {
            id: 'queued-follow', localId: 'queued-follow', text, createdAt: 1, updatedAt: 1,
            pendingDeliveryStatus: 'server_delivering' as const,
            rawRecord: { role: 'user', content: { type: 'text', text }, meta: {
                happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
                happierInputAuthorityV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
                    permission: { admittedPermissionCeiling: 'default' },
                    ...(kind === 'generated' ? {} : { followDeliveryV1: { v: 1, delivery: 'next_turn',
                        original: { sourceSessionId: 'cmvgukay000kdmcyhj5avwapl',
                            sourceMessage: { localId: '73a3dbcc-6d07-4fac-b2bb-671af06ccf80', seq: 6 } },
                        event: { kind: 'message' } } }) },
            } },
        };
        const screen = await renderBareScreen(<AppSessionTranscriptSourceProvider sessionId="bot">
            <PendingMessagesTranscriptBlock sessionId="bot" pendingMessages={[follow]}
                discardedMessages={[{ ...follow, id: 'discarded-follow', localId: 'discarded-follow', discardedAt: 2, discardedReason: 'manual' }]} />
        </AppSessionTranscriptSourceProvider>);
        expect(screen.findAllByType(TranscriptEventRow)).toHaveLength(2);
        expect(screen.findHostByTestId('pendingMessages.message:queued-follow')).not.toBeNull();
        expect(screen.findHostByTestId('pendingMessages.discarded.message:discarded-follow')).not.toBeNull();
        if (kind === 'follow') {
            expect(screen.getTextContent()).not.toContain(text);
            expect(screen.getTextContent()).toContain('message.provenanceFrom(source=Rollback review)');
            expect(screen.getTextContent()).not.toContain('session.pendingMessages.deliveryStatus.nextTurn');
        } else expect(screen.getTextContent()).toContain(text);
    });

    it('keeps the LIVE-11B app turn distinct from an adjacent workflow-injected turn', async () => {
        const run = createWorkflowRunSummaryFixture({ id: 'daily-digest' });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run, { kind: 'available', value: { title: 'Daily digest' } })]);
        const messages: UserTextMessage[] = [
            {
                kind: 'user-text', id: 'cmv3woe8e010jm24a1ua7n6ed', seq: 58, localId: null, createdAt: 1,
                text: 'List the starter templates using an empty input.',
                // Canonical seq 58 metadata from live11b-actions.jsonl; app ownership is independent of source/sentFrom.
                meta: { source: 'ui', sentFrom: 'web', happierProvenanceV1: { v: 1, kind: 'happierApp', actor: { kind: 'owner' } } },
            },
            {
                kind: 'user-text', id: 'daily-digest-input', seq: 59, localId: null, createdAt: 2,
                text: 'Summarize today.',
                meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: run.id, invocationRecordId: 'digest-step' } },
            },
        ];
        const screen = await renderBareScreen(<AppSessionTranscriptSourceProvider sessionId="session-b">
            {messages.map((message) => <MessageViewWithSessionCommon key={message.id}
                sessionId="session-b" metadata={null} message={message}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }} />)}
        </AppSessionTranscriptSourceProvider>);
        expect(screen.findHostByTestId('transcript-provenance-attribution:cmv3woe8e010jm24a1ua7n6ed')).toBeNull();
        expect(screen.findHostByTestId('transcript-provenance-attribution:daily-digest-input')?.props.accessibilityLabel)
            .toBe('message.provenanceFrom(source=Daily digest)');
        await screen.pressByTestIdAsync('transcript-provenance-attribution:daily-digest-input');
        expect(attributionBoundaries.push).toHaveBeenCalledWith(createWorkflowInvocationRoute(run.id, 'digest-step'));
    });

    it('opens the producing workflow step and scopes live attribution to that exact run and invocation', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://workflow-source.example.test' });
        storage.setState({ profileScope: { serverId: home.id, accountId: 'viewer-a' } });
        const run = createWorkflowRunSummaryFixture({ id: 'run-a' });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run, { kind: 'available', value: { title: 'Daily digest' } })]);
        const invocation = createWorkflowInvocationIndexFixture({ id: 'invocation-a', runId: run.id, parentRecordId: 'root', memberOrdinal: '2', sequence: '87' });
        storage.getState().upsertWorkflowRunInvocation({ runId: run.id, invocation, parentRevision: run.revision });
        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="session-b" serverId={home.id} metadata={null}
                message={{ kind: 'user-text', id: 'workflow-message', localId: null, createdAt: 1, text: 'Summarize today',
                    meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: run.id, invocationRecordId: invocation.id, stepOrdinal: '3' } } }}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }}
            />,
        );
        const chip = 'transcript-provenance-attribution:workflow-message';
        expect(screen.findHostByTestId(chip)?.props.accessibilityLabel).toBe('sessionWork.scheduled.provenanceWorkflowStep(source=Daily digest,step=3)');
        const chipProps = screen.findHostByTestId(chip)?.props;
        expect(chipProps?.role ?? chipProps?.accessibilityRole).toBe('link');
        await screen.pressByTestIdAsync(chip);
        expect(attributionBoundaries.push).toHaveBeenCalledWith(createWorkflowInvocationRoute(run.id, invocation.id, home.id));

        attributionBoundaries.transcriptCommits.mockClear();
        await act(async () => {
            storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'other-run' }), { kind: 'available', value: { title: 'Other work' } })]);
            storage.getState().upsertWorkflowRunInvocation({ runId: run.id,
                invocation: createWorkflowInvocationIndexFixture({ id: 'other-step', runId: run.id, memberOrdinal: '8' }), parentRevision: 1 });
        });
        expect(attributionBoundaries.transcriptCommits).toHaveBeenCalledTimes(0);
        await act(async () => storage.getState().upsertWorkflowRuns([
            workflowRunRowFromSummary({ ...run, revision: 2 }, { kind: 'available', value: { title: 'Renamed digest' } }),
        ]));
        expect(storage.getState().workflowRunsById[run.id]?.metadata).toEqual({ kind: 'available', value: { title: 'Renamed digest' } });
        expect(screen.findHostByTestId(chip)?.props.accessibilityLabel).toBe('sessionWork.scheduled.provenanceWorkflowStep(source=Renamed digest,step=3)');
        expect(attributionBoundaries.transcriptCommits).toHaveBeenCalledTimes(1);
        await act(async () => storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary({ ...run, revision: 3 })]));
        expect(screen.findHostByTestId(chip)?.props.accessibilityLabel).toBe('sessionWork.scheduled.provenanceWorkflowStep(source=Renamed digest,step=3)');
    });

    it('hydrates an unstamped step without changing the message and honors a navigation-free transcript', async () => {
        const run = createWorkflowRunSummaryFixture({ id: 'run-a' });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run, { kind: 'available', value: { title: 'Daily digest' } })]);
        const screen = await renderBareScreen(
            <AppSessionTranscriptSourceProvider sessionId="session-b" navigation="none">
                <MessageViewWithSessionCommon
                    sessionId="session-b" metadata={null}
                    message={{ kind: 'user-text', id: 'workflow-without-step', localId: null, createdAt: 1, text: 'Summarize today',
                        meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: run.id, invocationRecordId: 'invocation-a' } } }}
                    forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                    messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                    toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }}
                />
            </AppSessionTranscriptSourceProvider>,
        );
        const attribution = screen.findHostByTestId('transcript-provenance-attribution:workflow-without-step');
        expect(attribution?.props.accessibilityLabel).toBe('message.provenanceFrom(source=Daily digest)');
        expect(attribution?.props.accessibilityRole).toBe('text');
        expect(attribution?.props.onPress).toBeUndefined();
        await act(async () => storage.getState().upsertWorkflowRunInvocation({ runId: run.id,
            invocation: { ...createWorkflowInvocationIndexFixture({ id: 'invocation-a', runId: run.id, memberOrdinal: '8', sequence: '87' }), stepOrdinal: '3' },
            parentRevision: run.revision }));
        expect(screen.findHostByTestId('transcript-provenance-attribution:workflow-without-step')?.props.accessibilityLabel)
            .toBe('sessionWork.scheduled.provenanceWorkflowStep(source=Daily digest,step=3)');
        expect(screen.findHostByTestId('transcript-provenance-attribution:workflow-without-step')?.props.onPress).toBeUndefined();
    });

    it('does not disclose a same-id workflow from another transcript Home', async () => {
        const homeA = await upsertServerProfile({ serverUrl: 'https://workflow-home-a.example.test' });
        const homeB = await upsertServerProfile({ serverUrl: 'https://workflow-home-b.example.test' });
        storage.setState({ profileScope: { serverId: homeA.id, accountId: 'viewer-a' } });
        const run = createWorkflowRunSummaryFixture({ id: 'run-a' });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run, { kind: 'available', value: { title: 'Private other Home title' } })]);
        storage.getState().upsertWorkflowRunInvocation({ runId: run.id,
            invocation: createWorkflowInvocationIndexFixture({ id: 'invocation-a', runId: run.id, memberOrdinal: '2' }), parentRevision: 1 });
        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="session-b" serverId={homeB.id} metadata={null}
                message={{ kind: 'user-text', id: 'workflow-other-home', localId: null, createdAt: 1, text: 'Summarize today',
                    meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: run.id, invocationRecordId: 'invocation-a' } } }}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }}
            />,
        );
        expect(screen.findHostByTestId('transcript-provenance-attribution:workflow-other-home')?.props.accessibilityLabel)
            .toBe('message.provenanceFrom(source=message.provenanceWorkflow)');
        expect(screen.findHostByTestId('transcript-provenance-attribution:workflow-other-home')?.props.accessibilityRole).toBe('text');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Private other Home title');
    });

    it('keeps public transcript provenance independent of private Account run content', async () => {
        const run = createWorkflowRunSummaryFixture({ id: 'run-a' });
        storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(run, { kind: 'available', value: { title: 'Private workflow title' } })]);
        const message: UserTextMessage = { kind: 'user-text', id: 'public-workflow-message', localId: null, createdAt: 1, text: 'Summarize today',
            meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: run.id, invocationRecordId: 'invocation-a' } } };
        const source = createReadOnlySessionTranscriptSource({ sessionId: 'public-session', messages: [message], metadata: null, agentState: null, reducerState: null });
        const screen = await renderBareScreen(
            <SessionTranscriptSourceProvider source={source}>
                <React.Profiler id="public-message-attribution" onRender={attributionBoundaries.transcriptCommits}>
                    <MessageViewWithSessionCommon
                        sessionId="public-session" metadata={null} message={message}
                        forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                        messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                        toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }}
                    />
                </React.Profiler>
            </SessionTranscriptSourceProvider>,
        );
        expect(screen.findHostByTestId('transcript-provenance-attribution:public-workflow-message')?.props.accessibilityLabel)
            .toBe('message.provenanceFrom(source=message.provenanceWorkflow)');
        attributionBoundaries.transcriptCommits.mockClear();
        await act(async () => storage.getState().upsertWorkflowRuns([
            workflowRunRowFromSummary({ ...run, revision: 2 }, { kind: 'available', value: { title: 'Changed private title' } }),
        ]));
        expect(attributionBoundaries.transcriptCommits).toHaveBeenCalledTimes(0);
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('private title');
    });

    it.each([
        [{ v: 1, kind: 'happierSession', sourceSessionId: 'session-source-a', via: 'mcp' }, 'message.provenanceFrom(source=Lead A)'],
        [{ v: 1, kind: 'pluginSession', pluginId: 'acme.preview', contributionLocalId: 'inbound', surface: 'unspecified' }, 'message.pluginAttribution(pluginId=acme.preview)'],
        [{ v: 1, kind: 'automation', automationId: 'automation-a', runId: 'run-a' }, 'message.provenanceFrom(source=message.provenanceAutomation)'],
        [{ v: 2, kind: 'workflow_invocation', runId: 'run-a', invocationRecordId: 'invocation-a' }, 'message.provenanceFrom(source=message.provenanceWorkflow)'],
    ] satisfies [SessionMessageProvenance, string][])('attributes %j to its producer', async (provenance, label) => {
        storage.setState({ sessions: {
            'session-source-a': createSessionFixture({
                id: 'session-source-a', metadata: null, metadataLayoutVersion: 1,
                ownerMetadataView: { ...createSessionFixture().metadata!, name: 'Lead A' },
            }),
        } });
        const message: UserTextMessage = {
            kind: 'user-text', id: 'producer-message', localId: null, createdAt: 1, text: 'Continue the work',
            meta: { happierProvenanceV1: provenance },
        };
        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="session-b" metadata={null} message={message}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }}
            />,
        );
        const testId = provenance.kind === 'pluginSession' ? 'transcript-plugin-attribution:producer-message' : 'transcript-provenance-attribution:producer-message';
        expect(screen.findHostByTestId(testId)?.props.accessibilityLabel).toBe(label);
        expect(screen.findHostByTestId('transcript-account-attribution:producer-message')).toBeNull();
    });

    it.each([
        [{ v: 1, kind: 'happierApp', actor: { kind: 'owner' } }],
        [{ v: 1, kind: 'cli' }],
        [{ v: 1, kind: 'voice' }],
        [{ v: 1, kind: 'host', producer: 'happierApp' }],
    ] satisfies [SessionMessageProvenance][])('labels no origin on a message the person typed (%j)', async (provenance) => {
        const message: UserTextMessage = {
            kind: 'user-text', id: 'typed-message', localId: null, createdAt: 1, text: 'Fix the settings modal',
            meta: { happierProvenanceV1: provenance },
        };
        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="session-b" metadata={null} message={message}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }}
            />,
        );
        expect(screen.findHostByTestId('transcript-provenance-attribution:typed-message')).toBeNull();
    });

    it('names the sending Session only from the transcript Home', async () => {
        const homeA = await upsertServerProfile({ serverUrl: 'https://producer-home-a.example.test' });
        const homeB = await upsertServerProfile({ serverUrl: 'https://producer-home-b.example.test' });
        const sourceSession = (serverId: string, title: string) => createSessionFixture({
            id: 'same-source-id', serverId, metadataLayoutVersion: 1,
            metadata: { ...createSessionFixture().metadata!, name: title },
        });
        storage.setState({
            sessions: { 'same-source-id': sourceSession(homeA.id, 'Other Home title') },
            sessionListRowsByServerId: { [homeB.id]: { 'same-source-id': sourceSession(homeB.id, 'Lead B') } },
            sessionListIndexByServerId: { [homeB.id]: [{ type: 'session', sessionId: 'same-source-id', serverId: homeB.id }] },
        });
        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="target" serverId={homeB.id} metadata={null}
                message={{
                    kind: 'user-text', id: 'home-scoped-producer', localId: null, createdAt: 1, text: 'Continue',
                    meta: { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'same-source-id', via: 'mcp' } },
                }}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }}
            />,
        );
        expect(screen.findHostByTestId('transcript-provenance-attribution:home-scoped-producer')?.props.accessibilityLabel)
            .toBe('message.provenanceFrom(source=Lead B)');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Other Home title');
    });

    describe('a Discussion-delivering Session that this view has not loaded', () => {
        const discussionAddressing = { discussionId: 'discussion-1', messageId: 'discussion-message-1', throughSeq: 1, participantSessionId: 'receiver' };
        const deliveredBy = (id: string, senderId: string): UserTextMessage => ({
            kind: 'user-text', id, localId: null, createdAt: 1, text: 'Continue', meta: {
                happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: senderId, via: 'action' },
                happierInputAuthorityV1: { v: 1, producer: 'sessionAction', permission: { admittedPermissionCeiling: 'default' },
                    replyIntent: { mode: 'return' }, discussionAddressing,
                    sourceSession: { sourceSessionId: senderId, sourceTurnId: 'turn-1', sourceInputId: 'input-1', via: 'action' } },
            },
        });
        const renderDeliveries = async (serverId: string, messages: readonly UserTextMessage[]) => renderScreen(
            <>{messages.map(message => (
                <MessageViewWithSessionCommon key={message.id} sessionId="receiver" serverId={serverId} metadata={null} message={message}
                    forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                    messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                    toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }} />
            ))}</>,
        );

        it('names the sender from one by-id read per distinct sender, shared by every row it delivered', async () => {
            const home = await upsertServerProfile({ serverUrl: 'https://cold-sender-home.example.test' });
            // The by-id owner publishes the not-yet-loaded sender's row; the byline only demands it.
            attributionBoundaries.ensureSession.mockImplementationOnce(async (sessionId, options) => {
                const row = createSessionFixture({ id: sessionId, serverId: home.id, metadataLayoutVersion: 1,
                    metadata: { ...createSessionFixture().metadata!, name: 'Lead A' } });
                storage.setState({
                    sessionListRowsByServerId: { [home.id]: { [sessionId]: row } },
                    sessionListIndexByServerId: { [home.id]: [{ type: 'session', sessionId, serverId: home.id }] },
                });
                return { kind: 'available', sessionId, serverId: options?.serverId };
            });
            const rows = [deliveredBy('cold-1', 'cold-sender'), deliveredBy('cold-2', 'cold-sender'), deliveredBy('cold-3', 'cold-sender')];
            const screen = await renderDeliveries(home.id, rows);
            for (const { id } of rows) {
                expect(screen.findHostByTestId(`transcript-provenance-attribution:${id}`)?.props.accessibilityLabel)
                    .toBe('message.provenanceFrom(source=Lead A) · message.provenanceDiscussion');
            }
            expect(attributionBoundaries.ensureSession).toHaveBeenCalledTimes(1);
            // A re-entered transcript (a layout switch or route re-entry builds a new source) finds the published row held.
            await screen.unmount();
            const reentered = await renderDeliveries(home.id, rows);
            expect(reentered.findHostByTestId('transcript-provenance-attribution:cold-1')?.props.accessibilityLabel)
                .toBe('message.provenanceFrom(source=Lead A) · message.provenanceDiscussion');
            expect(attributionBoundaries.ensureSession).toHaveBeenCalledTimes(1);
            expect(attributionBoundaries.ensureSession).toHaveBeenCalledWith('cold-sender',
                { serverId: home.id, hydrateMessages: false, includeTurnsProjection: false });
        });

        it('keeps the generic sender wording, never an id, when the sender cannot be read', async () => {
            const home = await upsertServerProfile({ serverUrl: 'https://unreadable-sender-home.example.test' });
            const screen = await renderDeliveries(home.id, [deliveredBy('unreadable-1', 'unreadable-sender')]);
            expect(screen.findHostByTestId('transcript-provenance-attribution:unreadable-1')?.props.accessibilityLabel)
                .toBe('message.provenanceFrom(source=message.provenanceSession) · message.provenanceDiscussion');
            expect(screen.getTextContent()).not.toContain('unreadable-sender');
        });

        it('does not read a sender the view already holds', async () => {
            const home = await upsertServerProfile({ serverUrl: 'https://held-sender-home.example.test' });
            const row = createSessionFixture({ id: 'held-sender', serverId: home.id, metadataLayoutVersion: 1,
                metadata: { ...createSessionFixture().metadata!, name: 'Lead B' } });
            storage.setState({ sessionListRowsByServerId: { [home.id]: { 'held-sender': row } },
                sessionListIndexByServerId: { [home.id]: [{ type: 'session', sessionId: 'held-sender', serverId: home.id }] } });
            await renderDeliveries(home.id, [deliveredBy('held-1', 'held-sender')]);
            expect(attributionBoundaries.ensureSession).not.toHaveBeenCalled();
        });
    });

    it.each([
        ['the viewer delivered it', 'host', 'message.provenanceFrom(source=message.provenanceDiscussion)'],
        ['another Session delivered it', 'happierSession',
            'message.provenanceFrom(source=Lead A) · message.provenanceDiscussion'],
    ] as const)('shows a Discussion message as the authored words, never the provider prompt, and names who delivered it when %s', async (_case, origin, byline) => {
        const { normalizeRawMessage } = await import('@happier-dev/session-core/raw');
        const { createReducer, reducer } = await import('@happier-dev/session-core/reducer');
        const { UserMessageBubble } = await import('./UserMessageBubble');
        const { TranscriptEventRow } = await import('./events/TranscriptEventRow');
        const home = await upsertServerProfile({ serverUrl: 'https://discussion-input-home.example.test' });
        // Persisted shape observed live (INT-LIVEFOLLOW round 14, receiver seq2): the provider text keeps the
        // context block and mention ids for the Agent; the sender stored the authored sentence as displayText.
        const prompt = '<happier_input_context v="1">\ndiscussion_id="cmvpj3mb70060mcz4xtt9d6cf"\n'
            + 'discussion_sender_account_id="5e3a0581-6f3d-4e73-bf40-383db0be6c3e"\n</happier_input_context>\n\n'
            + '@session:cmvpirt8g003rmcz4lk9djsnh The wording is ready; @session:cmvpirtak003tmcz4n0f3vg4a has checked it.';
        const sender = createSessionFixture({ id: 'session-source-a', serverId: home.id, metadataLayoutVersion: 1,
            metadata: { ...createSessionFixture().metadata!, name: 'Lead A' } });
        storage.setState({
            sessionListRowsByServerId: { [home.id]: { 'session-source-a': sender } },
            sessionListIndexByServerId: { [home.id]: [{ type: 'session', sessionId: 'session-source-a', serverId: home.id }] },
        });
        const discussionAddressing = { discussionId: 'cmvpj3mb70060mcz4xtt9d6cf', messageId: 'cmvpj3o6r0062mcz4k1rwgcwr',
            throughSeq: 1, participantSessionId: 'cmvpirt8g003rmcz4lk9djsnh' };
        // Stored mentions keep every participant the provider prompt names, the receiver included.
        const mention = (sessionId: string, label: string) => ({ kind: 'happier.session', ref: `session:${sessionId}`, label,
            token: `@Session "${label}"` });
        const meta = {
            displayText: 'The wording is ready; @Session has checked it.',
            happierStructuredInputV1: { v: 1, mentions: [mention('cmvpirt8g003rmcz4lk9djsnh', 'Receiver'), mention('cmvpirtak003tmcz4n0f3vg4a', 'Peer')] },
            ...(origin === 'host' ? {
                happierProvenanceV1: { v: 1, kind: 'host', producer: 'sessionAction' },
                happierInputAuthorityV1: { v: 1, producer: 'sessionAction', caller: { kind: 'host' },
                    permission: { admittedPermissionCeiling: 'default' }, replyIntent: { mode: 'return' }, discussionAddressing },
            } : {
                happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'session-source-a', via: 'action' },
                happierInputAuthorityV1: { v: 1, producer: 'sessionAction', permission: { admittedPermissionCeiling: 'default' },
                    replyIntent: { mode: 'return' }, discussionAddressing,
                    sourceSession: { sourceSessionId: 'session-source-a', sourceTurnId: 'turn-1', sourceInputId: 'input-1', via: 'action' } },
            }),
        };
        const normalized = normalizeRawMessage('discussion-input', 'discussion-follow-v1:local', 1,
            { role: 'user', content: { type: 'text', text: prompt }, meta }, { seq: 2 });
        const messages = reducer(createReducer(), normalized ? [normalized] : []).messages;
        expect(messages).toHaveLength(1);
        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="cmvpirt8g003rmcz4lk9djsnh" serverId={home.id} metadata={null} message={messages[0]!}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }}
            />,
        );
        expect(screen.findAllByType(UserMessageBubble)).toHaveLength(1);
        expect(screen.findAllByType(TranscriptEventRow)).toHaveLength(0);
        const text = screen.getTextContent();
        expect(text).toContain('The wording is ready; @Session has checked it.');
        expect(text).not.toContain('happier_input_context');
        expect(text).not.toContain('@session:');
        expect(text).not.toContain('cmvp');
        expect(screen.findHostByTestId(`transcript-provenance-attribution:${messages[0]!.id}`)?.props.accessibilityLabel)
            .toBe(byline);
        // The receiving Session never references itself in its own transcript; the peer chip stays.
        expect(screen.findHostByTestId('transcript-session-reference:cmvpirtak003tmcz4n0f3vg4a')).not.toBeNull();
        expect(screen.findHostByTestId('transcript-session-reference:cmvpirt8g003rmcz4lk9djsnh')).toBeNull();
    });

    it.each(['host', 'happierSession'] as const)('quotes a %s returned answer as information instead of a host notice or person’s bubble', async (origin) => {
        const { UserMessageBubble } = await import('./UserMessageBubble');
        const { TranscriptEventRow } = await import('./events/TranscriptEventRow');
        const home = await upsertServerProfile({ serverUrl: 'https://returned-answer-home.example.test' });
        const answerer = createSessionFixture({ id: 'answerer', serverId: home.id, metadataLayoutVersion: 1,
            metadata: { ...createSessionFixture().metadata!, name: 'Checkout UI retry states' } });
        storage.setState({
            sessionListRowsByServerId: { [home.id]: { answerer } },
            sessionListIndexByServerId: { [home.id]: [{ type: 'session', sessionId: 'answerer', serverId: home.id }] },
        });
        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="asker" serverId={home.id} metadata={null}
                message={returnedAnswerMessage(home.id, origin, 'No. A replayed charge shows “Payment confirmed”.')}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ reducerState: null }}
            />,
        );
        const quote = screen.findHostByTestId('transcript-returned-answer:returned-answer');
        expect(quote).not.toBeNull();
        expect(screen.findAllByType(UserMessageBubble)).toHaveLength(0);
        expect(screen.findAllByType(TranscriptEventRow)).toHaveLength(0);
        const text = screen.getTextContent();
        expect(text).toContain('Checkout UI retry states');
        expect(text).toContain('session.returnedAnswer.answered');
        expect(text).toContain('session.returnedAnswer.asInformation');
        // The quote's header is the attribution: no second "From …" label above it.
        expect(screen.findHostByTestId('transcript-provenance-attribution:returned-answer')).toBeNull();
        // The exact request read mounts only when the person opens it.
        expect(screen.findHostByTestId('transcript-returned-answer:returned-answer.questionState')).toBeNull();
    });

    it('bounds a long returned answer behind Show more and keeps the whole answer one press away', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://returned-answer-long.example.test' });
        const long = Array.from({ length: 40 }, (_, line) => `Line ${line} of a long answer.`).join('\n\n');
        const common = {
            forkCommon: { ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null },
            messageDisplayCommon: { ...settingsDefaults, workspacePath: null, debugInformationEnabled: false },
            toolChromeCommon: settingsDefaults, toolRouteCommon: { reducerState: null },
        };
        const screen = await renderScreen(
            <MessageViewWithSessionCommon sessionId="asker" serverId={home.id} metadata={null}
                message={returnedAnswerMessage(home.id, 'host', long)} {...common} />,
        );
        const body = screen.findHostByTestId('transcript-returned-answer:returned-answer.body');
        expect(body).not.toBeNull();
        const clip = () => screen.findHostByTestId('transcript-returned-answer:returned-answer.body')!.props.style;
        const measure = (height: number) => act(() => {
            const measured = screen.findHostByTestId('transcript-returned-answer:returned-answer.body')!
                .findAll((node) => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
            measured[0]!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 600, height } } });
        });
        // Before it is measured the answer is already clipped, so it never paints full length first.
        expect(JSON.stringify(clip())).toContain('maxHeight');
        expect(screen.findHostByTestId('transcript-returned-answer:returned-answer.body.fold')).toBeNull();
        // Measured longer than the bound: Show more appears, and pressing it releases the clip.
        measure(4000);
        // The clip ends in the shared edge fade, so it never slices a line of text in half.
        expect(JSON.stringify(clip())).toContain('maskImage');
        expect(screen.getTextContent()).toContain('session.returnedAnswer.showMore');
        await screen.pressByTestIdAsync('transcript-returned-answer:returned-answer.body.fold');
        expect(JSON.stringify(clip())).not.toContain('maxHeight');
        expect(JSON.stringify(clip())).not.toContain('maskImage');
        expect(screen.getTextContent()).toContain('session.returnedAnswer.showLess');
        await screen.pressByTestIdAsync('transcript-returned-answer:returned-answer.body.fold');
        expect(JSON.stringify(clip())).toContain('maxHeight');
        // An answer that fits is drawn whole: no control.
        measure(48);
        expect(screen.findHostByTestId('transcript-returned-answer:returned-answer.body.fold')).toBeNull();
        expect(JSON.stringify(clip())).not.toContain('maskImage');
    });

    it('draws a composer Ask entry as the Ask record row, not as a generic information line', async () => {
        const { normalizeRawMessage } = await import('@happier-dev/session-core/raw');
        const { createReducer, reducer } = await import('@happier-dev/session-core/reducer');
        const { projectSessionMessageInvocationV1 } = await import('@happier-dev/protocol/sessions/messages/sessionMessageInvocationV1');
        const { TranscriptEventRow } = await import('./events/TranscriptEventRow');
        const { publishAppliedActiveServerSnapshot, getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const home = await upsertServerProfile({ serverUrl: 'https://ask-record-wiring.example.test' });
        const previousRuntime = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        try {
            storage.getState().activateProfileScope({ serverId: home.id, accountId: 'alice' });
            publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: 'https://ask-record-wiring.example.test', generation: previousRuntime.generation + 1 });
            const invocation = projectSessionMessageInvocationV1({ serverId: home.id, localId: 'attempt', requestLocalId: 'attempt', target: 'receiver', reply: 'none',
                result: { ok: true, result: { status: 'accepted', localId: 'attempt' } } });
            const raw = normalizeRawMessage('ask-entry', 'attempt', 10, { role: 'agent', content: { type: 'event', id: 'attempt', data: {
                type: 'message', message: 'Is the changelog wording final?', sessionMessageInvocationV1: invocation } } }, { messageRole: 'event', seq: 1 });
            const message = reducer(createReducer(), [raw!]).messages[0]!;
            const screen = await renderScreen(
                <MessageViewWithSessionCommon sessionId="asker" serverId={home.id} metadata={null} message={message}
                    forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                    messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                    toolChromeCommon={{ ...settingsDefaults, serverId: home.id }} toolRouteCommon={{ reducerState: null }} />,
            );
            expect(screen.getTextContent()).toContain('Is the changelog wording final?');
            expect(screen.findAllByType(TranscriptEventRow)).toHaveLength(0);
            expect(screen.findHostByTestId(`session-ask-record:${message.id}`)).not.toBeNull();
        } finally {
            publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable);
        }
    });

    it('presents a recognized agent Ask tool call as its Ask record alone, and keeps the tool row when the result is not a send', async () => {
        const { createToolCallMessageFixture } = await import('@/dev/testkit/fixtures/transcriptFixtures');
        const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
        const { ToolTimelineRow } = await import('@/components/tools/shell/views/ToolTimelineRow');
        const { publishAppliedActiveServerSnapshot, getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const home = await upsertServerProfile({ serverUrl: 'https://ask-record-tool.example.test' });
        const previousRuntime = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const binding = getActionSpec('session.message.send').bindings?.mcpToolName;
        if (!binding) throw new Error('Session message Action requires its catalog binding');
        const base = createToolCallMessageFixture({ id: 'ask-tool', createdAt: 10 });
        const call = (result: unknown) => ({ ...base, tool: { ...base.tool, name: `mcp__happier__${binding}`,
            input: { sessionId: 'receiver', message: 'Is the changelog wording final?', reply: 'wait' }, result, state: 'completed' as const } });
        const answered = { content: [{ type: 'text', text: JSON.stringify({ status: 'replied', localId: 'real-request',
            outcome: { kind: 'answer', text: 'Yes', messageRef: { kind: 'session', session: { serverId: home.id, sessionId: 'receiver' }, messageId: 'real-answer' } } }) }] };
        const common = {
            forkCommon: { ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null },
            messageDisplayCommon: { ...settingsDefaults, workspacePath: null, debugInformationEnabled: false },
            toolChromeCommon: { ...settingsDefaults, serverId: home.id }, toolRouteCommon: { reducerState: null },
        };
        try {
            storage.getState().activateProfileScope({ serverId: home.id, accountId: 'alice' });
            publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: 'https://ask-record-tool.example.test', generation: previousRuntime.generation + 1 });
            const recognized = call(answered);
            const record = await renderScreen(<MessageViewWithSessionCommon sessionId="asker" serverId={home.id} metadata={null} message={recognized} {...common} />);
            expect(record.findHostByTestId(`session-ask-record:${recognized.id}`)).not.toBeNull();
            expect(record.findAllByType(ToolTimelineRow)).toHaveLength(0);
            const other = call({ ok: true, result: { unrelated: true } });
            const plain = await renderScreen(<MessageViewWithSessionCommon sessionId="asker" serverId={home.id} metadata={null} message={other} {...common} />);
            expect(plain.findHostByTestId(`session-ask-record:${other.id}`)).toBeNull();
            expect(plain.findAllByType(ToolTimelineRow)).toHaveLength(1);
        } finally {
            publishAppliedActiveServerSnapshot(previousRuntime, previousAvailable);
        }
    });

    it('renders a single trusted human byline before the bubble while preserving recovered-history status', async () => {
        const message: UserTextMessage = {
            kind: 'user-text', id: 'actor-message', localId: null, createdAt: 1, text: 'Review the migration',
            accountActor: {
                v: 1, serverId: 'home-a', accountId: 'private-account-id',
                profile: { name: 'Alice Chen', firstName: 'Alice', lastName: 'Chen', username: null, avatarUrl: null },
            },
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
            meta: {
                happierProvenanceV1: { v: 1, kind: 'pluginSession', pluginId: 'acme.preview', contributionLocalId: 'inbound', surface: 'unspecified' },
            },
        };
        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="session-a"
                metadata={null}
                message={message}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{
                    ...settingsDefaults, workspacePath: null, debugInformationEnabled: false,
                    accountActorViewerScope: { serverId: 'home-a', accountId: 'viewer' },
                    hasOtherNamedCollaborator: true,
                }}
                toolChromeCommon={settingsDefaults}
                toolRouteCommon={{ reducerState: null }}
            />,
        );
        expect(screen.findHostByTestId('transcript-account-attribution:actor-message')?.props.accessibilityLabel)
            .toBe('message.accountActorSentBy(name=Alice Chen)');
        expect(screen.findHostByTestId('transcript-recovered-history:actor-message')).not.toBeNull();
        // Revision-13 coexistence: the descriptive plugin source line and the
        // authenticated Account byline are independent siblings. Either may be
        // absent, but the presence of one must never suppress the other.
        expect(screen.findHostByTestId('transcript-plugin-attribution:actor-message')?.props.accessibilityLabel)
            .toBe('message.pluginAttribution(pluginId=acme.preview)');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('private-account-id');
    });

    /**
     * Revision-13 last mile: the mounted self byline is the thin presentation
     * projection of the server's one safe audience-existence signal on the
     * Session record. It is evaluated once per Session, never per message, and
     * is independent of live presence. The standalone `MessageView` is mounted
     * so the real session-record -> hook -> attribution chain runs.
     */
    describe('self byline audience signal (session record -> mounted transcript)', () => {
        async function seedSessionWithAudienceSignal(overrides: Partial<Session>) {
            const home = await upsertServerProfile({ serverUrl: 'https://attribution-audience.example.test' });
            storage.setState({
                profileScope: { serverId: home.id, accountId: 'viewer-a' },
                sessions: {
                    transcript: createSessionFixture({ id: 'transcript', serverId: home.id, ...overrides }),
                },
                sessionListRowsByServerId: { [home.id]: {} },
                sessionListIndexByServerId: { [home.id]: [] },
            });
            return home;
        }

        function authoredMessage(homeId: string, messageId: string, actor: { accountId: string; firstName: string }): UserTextMessage {
            return {
                kind: 'user-text', id: messageId, localId: null, createdAt: 1, text: 'Checking the migration path',
                accountActor: {
                    v: 1, serverId: homeId, accountId: actor.accountId,
                    profile: { name: actor.firstName, firstName: actor.firstName, lastName: null, username: null, avatarUrl: null },
                },
            };
        }

        it('announces the mounted self byline when another collaborator is currently authorized', async () => {
            const home = await seedSessionWithAudienceSignal({ hasOtherNamedCollaborator: true });
            const screen = await renderScreen(
                <MessageView
                    sessionId="transcript"
                    metadata={null}
                    message={authoredMessage(home.id, 'self-shared', { accountId: 'viewer-a', firstName: 'Viewer' })}
                />,
            );
            expect(screen.findHostByTestId('transcript-account-attribution:self-shared')?.props.accessibilityLabel)
                .toBe('message.accountActorSentBy(name=message.accountActorYou)');
        });

        it('keeps a solo transcript quiet even when the viewer authored the message', async () => {
            const home = await seedSessionWithAudienceSignal({ hasOtherNamedCollaborator: false });
            const screen = await renderScreen(
                <MessageView
                    sessionId="transcript"
                    metadata={null}
                    message={authoredMessage(home.id, 'self-solo', { accountId: 'viewer-a', firstName: 'Viewer' })}
                />,
            );
            expect(screen.findHostByTestId('transcript-account-attribution:self-solo')).toBeNull();
        });

        it('always names another Account, independent of the audience signal', async () => {
            const home = await seedSessionWithAudienceSignal({ hasOtherNamedCollaborator: false });
            const screen = await renderScreen(
                <MessageView
                    sessionId="transcript"
                    metadata={null}
                    message={authoredMessage(home.id, 'other-solo', { accountId: 'account-alice', firstName: 'Alice' })}
                />,
            );
            expect(screen.findHostByTestId('transcript-account-attribution:other-solo')?.props.accessibilityLabel)
                .toBe('message.accountActorSentBy(name=Alice)');
        });

        it('uses the exact Home audience signal when raw Session ids collide', async () => {
            const homeA = await upsertServerProfile({ serverUrl: 'https://attribution-home-a.example.test' });
            const homeB = await upsertServerProfile({ serverUrl: 'https://attribution-home-b.example.test' });
            storage.setState({
                profileScope: { serverId: homeB.id, accountId: 'viewer-b' },
                sessions: {
                    transcript: createSessionFixture({
                        id: 'transcript',
                        serverId: homeA.id,
                        hasOtherNamedCollaborator: false,
                    }),
                },
                sessionListRowsByServerId: {
                    [homeA.id]: {
                        transcript: createSessionFixture({
                            id: 'transcript',
                            serverId: homeA.id,
                            hasOtherNamedCollaborator: false,
                        }),
                    },
                    [homeB.id]: {
                        transcript: createSessionFixture({
                            id: 'transcript',
                            serverId: homeB.id,
                            hasOtherNamedCollaborator: true,
                        }),
                    },
                },
                sessionListIndexByServerId: {
                    [homeA.id]: [{ type: 'session', sessionId: 'transcript', serverId: homeA.id }],
                    [homeB.id]: [{ type: 'session', sessionId: 'transcript', serverId: homeB.id }],
                },
            });

            const screen = await renderScreen(
                <MessageView
                    sessionId="transcript"
                    serverId={homeB.id}
                    metadata={null}
                    message={authoredMessage(homeB.id, 'self-home-b', { accountId: 'viewer-b', firstName: 'Viewer' })}
                />,
            );

            expect(screen.findHostByTestId('transcript-account-attribution:self-home-b')?.props.accessibilityLabel)
                .toBe('message.accountActorSentBy(name=message.accountActorYou)');
        });
    });
});
