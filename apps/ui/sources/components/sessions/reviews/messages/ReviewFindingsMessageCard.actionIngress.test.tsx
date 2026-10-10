import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewFindingsV2 } from '@happier-dev/protocol';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { changeTextTestInstance, createRootLayoutFeaturesResponse, createSessionFixture, flushHookEffects,
    renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import type { Message } from '@happier-dev/session-core/messages';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { resetReviewRunCommentsForTests } from '@/sync/domains/reviews/comments/reviewRunComments';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('expo-image', () => ({ Image: (props: Record<string, unknown>) => React.createElement('Image', props) }));
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());

// Socket.IO is the genuine network boundary. The card, Action executor, Account capture,
// run operations, scoped RPC adapter, reviewer merge and composer remain real.
const boundary = vi.hoisted(() => ({
    requests: [] as Array<Readonly<{ serverUrl: string; targetId: string; method: string; payload: unknown }>>,
    reply: vi.fn<(method: string, payload: unknown) => Promise<unknown>>(),
}));
vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: (serverUrl: string) => {
        const { socket } = createSocketIoBoundaryStub();
        socket.emitWithAck.mockImplementation(async (event, raw) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: ['review-session'] };
            if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) {
                throw new Error('Malformed Socket RPC request');
            }
            const separator = raw.method.indexOf(':');
            const method = raw.method.slice(separator + 1);
            boundary.requests.push({ serverUrl, targetId: raw.method.slice(0, separator), method, payload: raw.params });
            return { ok: true, result: await boundary.reply(method, raw.params) };
        });
        return socket;
    } };
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;
let ReviewFindingsMessageCard!: typeof import('./ReviewFindingsMessageCard').ReviewFindingsMessageCard;
let homes: Awaited<ReturnType<typeof serveActionHomes>>;
const initialState = storage.getState();
const payload: ReviewFindingsV2 = {
    runRef: { runId: 'review-run', callId: 'review-call', backendId: 'claude', retentionPolicy: 'resumable' },
    summary: 'A finding', overviewMarkdown: 'A finding', generatedAtMs: 1,
    findings: [{ id: 'finding-1', title: 'A defect', severity: 'high', category: 'correctness', summary: 'Preserve scope', filePath: 'src.ts', startLine: 1 }],
    questions: [], assumptions: [],
};
const siblingPayload: ReviewFindingsV2 = { ...payload,
    runRef: { ...payload.runRef, runId: 'review-sibling', callId: 'sibling-call', backendId: 'codex' },
    findings: [],
};
const siblingRun = ExecutionRunPublicStateSchema.parse({
    runId: 'review-sibling', callId: 'sibling-call', sidechainId: 'sibling-side', intent: 'review',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, display: { groupId: 'review-group' },
    permissionMode: 'default', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'streaming', status: 'succeeded', startedAtMs: 2,
});

beforeAll(async () => {
    await loadSyncSingletonForTests();
    ({ ReviewFindingsMessageCard } = await import('./ReviewFindingsMessageCard'));
}, 600_000);
beforeEach(async () => {
    storage.setState(initialState, true);
    resetSessionDraftRepositoryForTests();
    await prepareSessionDraftPersistenceStorage();
    boundary.requests.length = 0;
    boundary.reply.mockReset();
    boundary.reply.mockImplementation(async (method) => {
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [siblingRun] };
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return { run: siblingRun, structuredMeta: { kind: 'review_findings.v2', payload: siblingPayload } };
        return { ok: true };
    });
});
afterEach(async () => {
    standardCleanup();
    await disconnectActiveServerConnection();
    homes?.dispose();
    resetReviewRunCommentsForTests();
    resetSessionDraftRepositoryForTests();
    invalidateAccountEncryptionModeCache();
});

async function mount(options: Readonly<{ disabled?: boolean; payload?: ReviewFindingsV2; groupId?: string }> = {}) {
    homes = await serveActionHomes({
        homes: [
            { key: 'review', serverUrl: 'https://follow-up-review.test', accountId: 'review-account', settings: {
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'execution.run.action': ['ui'] },
                    actions: { 'execution.run.action': { disabledSurfaces: options.disabled ? ['ui'] : [] } } },
            } },
            { key: 'focused', serverUrl: 'https://follow-up-focused.test', accountId: 'focused-account' },
        ],
        route: (request) => {
            if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (request.path === '/v1/reviews/comments') return Response.json({ items: [], cursor: null });
            if (request.path === '/v2/sessions/review-session') return Response.json({ session: {
                id: 'review-session', encryptionMode: 'plain', metadata: JSON.stringify({ path: '/repo', host: 'test' }),
                metadataVersion: 1, agentState: null, agentStateVersion: 1, dataEncryptionKey: null,
                active: true, activeAt: 1, createdAt: 1, updatedAt: 1, seq: 1,
            } });
            if (request.path === '/v1/artifacts') return Response.json([]);
            if (request.path.includes('/messages')) return Response.json({ messages: [], hasMore: false, nextCursor: null });
            if (request.path.includes('/pending')) return Response.json({ pending: [], discarded: [], pendingVersion: 1, pendingCount: 0 });
            return undefined;
        },
    });
    await restoreConnectionToActiveServer((await TokenStorage.getCredentialsForServerUrl(homes.homes.focused!.serverUrl))!);
    storage.getState().applySessions([createSessionFixture({ id: 'review-session', serverId: homes.homes.review!.id, active: true })]);
    const screen = await renderScreen(<ReviewFindingsMessageCard serverId={homes.homes.review!.id}
        sessionId="review-session" payload={options.payload ?? payload} canSendMessages presentation="page" groupId={options.groupId} />);
    await vi.waitFor(async () => {
        await flushHookEffects();
        expect(screen.findByTestId('review-findings-follow-up')).not.toBeNull();
        if (options.groupId) expect(screen.findByTestId('review-reviewer:review-sibling')).not.toBeNull();
    });
    return screen;
}

function composerPart(screen: Screen, container: string, part: string, handler: 'onPress' | 'onChangeText') {
    const found = screen.findByTestId(container)?.findAll(node => node.props.testID === part && typeof node.props[handler] === 'function')[0];
    expect(found).toBeDefined();
    return found!;
}
async function send(screen: Screen, container: string, text: string) {
    await act(async () => changeTextTestInstance(composerPart(screen, container, 'new-session-composer-input', 'onChangeText'), text));
    await act(async () => { await composerPart(screen, container, 'new-session-composer-send', 'onPress').props.onPress(); });
    await flushHookEffects();
}
function actionRequests() { return boundary.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION); }
function composerText(screen: Screen, container = 'review-findings-follow-up') {
    return composerPart(screen, container, 'new-session-composer-input', 'onChangeText').props.value;
}

describe('review follow-up Action ingress', () => {
    it('refuses disabled Action policy before Socket RPC and retains the unsent question', async () => {
        const screen = await mount({ disabled: true });
        await send(screen, 'review-findings-follow-up', 'Explain the scope');
        expect(actionRequests()).toEqual([]);
        expect(composerText(screen)).toBe('Explain the scope');
        expect(screen.getTextContent()).toContain('runPage.review.followUpUnavailable.failed');
    });

    it('asks a finding on the captured nonfocused Home with its existing thread', async () => {
        const screen = await mount();
        const message: Message = { id: 'follow-up', kind: 'agent-text', localId: null, createdAt: 2, text: '', meta: { happier: {
            kind: 'review_follow_up.v1', payload: { parentRunRef: payload.runRef, threadId: 'finding-thread', findingIds: ['finding-1'],
                requestMarkdown: 'Earlier question', answerMarkdown: 'Earlier answer', generatedAtMs: 2 },
        } } };
        await act(async () => storage.setState({ sessionMessages: { 'review-session': createSessionMessagesFixture({
            isLoaded: true, messageIdsOldestFirst: [message.id], messagesById: { [message.id]: message },
        }) } }));
        await flushHookEffects();
        await screen.pressByTestIdAsync('review-finding-replies:finding-1');
        await send(screen, 'review-finding-ask-field:finding-1', 'Explain this finding');
        expect(actionRequests()).toEqual([{ serverUrl: homes.homes.review!.serverUrl, targetId: 'review-session',
            method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, payload: { runId: 'review-run', actionId: 'review.follow_up',
                input: { findingIds: ['finding-1'], threadId: 'finding-thread', messageMarkdown: 'Explain this finding' } } }]);
        expect(composerText(screen, 'review-finding-ask-field:finding-1')).toBe('');
    });

    it('replies to the selected reviewer question without changing its finding ids', async () => {
        const screen = await mount({ payload: { ...payload, questions: [{ id: 'question-1', text: 'Which scope?', findingIds: ['finding-1'], status: 'open' }] } });
        await screen.pressByTestIdAsync('review-question-answer:question-1');
        await send(screen, 'review-findings-follow-up', 'The review Account');
        expect(actionRequests().map(request => request.payload)).toEqual([{ runId: 'review-run', actionId: 'review.follow_up',
            input: { findingIds: ['finding-1'], replyToQuestionId: 'question-1', messageMarkdown: 'The review Account' } }]);
        expect(composerText(screen)).toBe('');
    });

    it.each([false, true])('keeps typed group failures visible and clears the question only after a success (all failed: %s)', async (allFailed) => {
        const screen = await mount({ groupId: 'review-group' });
        boundary.reply.mockImplementation(async (method, input) => {
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION && typeof input === 'object' && input && 'runId' in input && (allFailed || input.runId === 'review-sibling')) {
                return { ok: false, errorCode: 'review_follow_up_ended', error: 'Ended review' };
            }
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [siblingRun] };
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return { run: siblingRun, structuredMeta: { kind: 'review_findings.v2', payload: siblingPayload } };
            return { ok: true };
        });
        await send(screen, 'review-findings-follow-up', 'Explain both reviews');
        expect(actionRequests().map(request => request.payload)).toEqual(expect.arrayContaining([
            { runId: 'review-run', actionId: 'review.follow_up', input: { findingIds: [], messageMarkdown: 'Explain both reviews' } },
            { runId: 'review-sibling', actionId: 'review.follow_up', input: { findingIds: [], messageMarkdown: 'Explain both reviews' } },
        ]));
        expect(composerText(screen)).toBe(allFailed ? 'Explain both reviews' : '');
        expect(screen.getTextContent()).toContain('runPage.review.followUpUnavailable.ended');
    });
});
