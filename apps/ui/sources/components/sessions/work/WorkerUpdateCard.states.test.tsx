import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerUpdateV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { renderScreen, type RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { t } from '@/text';

import { WorkerUpdateCard } from './WorkerUpdateCard';
import type { Message } from '@happier-dev/session-core/messages';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { TranscriptEventRow } from '@/components/sessions/transcript/events/TranscriptEventRow';

// External enriched-markdown animation SDK: these cards use plain, still text.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (input: { text: string; startOffset: number }) => [{ ...input, animated: false }],
}));
const sessionRpcTransport = vi.hoisted(() => vi.fn(async (
    _params: Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc')['sessionRpcWithServerScope']>[0],
) => undefined));
// Permission custody stays real; only the server socket transport is replaced.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async (importOriginal) => {
    const { installServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return installServerScopedSessionRpcModuleMock({
        sessionRpcWithServerScope: async <R,>(params: Parameters<typeof sessionRpcTransport>[0]): Promise<R> => {
            if (params.method !== RPC_METHODS.SESSION_PERMISSION_RESPOND) throw new Error('Unexpected request in worker card fixture');
            await sessionRpcTransport(params);
            // This external RPC's acknowledgement has no payload; R is chosen by its caller.
            return undefined as R;
        },
    })(importOriginal);
});

const initialState = storage.getState();
let screen: RenderScreenResult | null = null;
let home: Awaited<ReturnType<typeof serveSessionActionHome>>;
beforeEach(async () => { home = await serveSessionActionHome(); });
afterEach(async () => {
    await screen?.unmount();
    screen = null;
    await home.dispose();
    act(() => storage.setState(initialState));
    sessionRpcTransport.mockClear();
});

async function renderCard(update: WorkerUpdateV1, serverId: string, navigate: (href: string) => void = () => {}) {
    const source = createTestSessionTranscriptSource({ sessionId: 'lead', serverId, navigate, messages: [workerMessage('update', update)] });
    screen = await renderWithSessionTranscriptSource(<WorkerUpdateCard update={update} messageId="update" serverId={serverId} at={Date.now() - 3 * 60_000} />, source);
    return screen;
}

type WorkerMessage = Extract<Message, { kind: 'agent-event' }>;
function workerMessage(id: string, update: WorkerUpdateV1): WorkerMessage {
    return { kind: 'agent-event', id, localId: id, createdAt: 1, event: { type: 'worker-update', update } };
}

describe('WorkerUpdateCard states (lab cards-T1/T2)', () => {
    it.each([1_800_000_000_000, null])('shows the carried failure and only a provider-reported reset (%s)', async resetAtMs => {
        const update: WorkerUpdateV1 = { v: 1, workerKind: 'execution_run', workerId: 'failed-child', ownerState: 'failed',
            wake: 'needs_you', headline: 'Background run failed', canInspect: true,
            runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
                occurredAt: 1000, sanitizedPreview: 'Account quota exhausted', usageLimit: { v: 1, resetAtMs,
                    retryAfterMs: null, quotaScope: 'provider', recoverability: 'wait' } } };
        const card = await renderCard(update, getActiveServerSnapshot().serverId);
        expect(card.getTextContent()).toContain('Account quota exhausted');
        expect(card.getTextContent()).toContain(t('sessionWork.workerUpdate.state.failed'));
        expect(card.findAllHostsByTestId('worker-update-reset')).toHaveLength(resetAtMs === null ? 0 : 1);
        if (resetAtMs !== null) expect(card.getTextContent()).toContain(new Date(resetAtMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
    });
    it('says a raw schema failure once, as one line, with the raw text behind Details', async () => {
        const raw = '[\n  {\n    "code": "unrecognized_keys",\n    "keys": ["diagnostics"],\n    "message": "Unrecognized key: \\"diagnostics\\""\n  }\n]';
        const update: WorkerUpdateV1 = { v: 1, workerKind: 'execution_run', workerId: 'schema-failed', ownerState: 'failed',
            wake: 'needs_you', headline: 'Background run failed', canInspect: false,
            result: `Native Agent session turn failed: ${raw}`,
            runtimeIssueV1: { v: 1, scope: 'primary_session', status: 'failed', code: 'agent_session_error', source: 'agent_session_error',
                occurredAt: 1000, sanitizedPreview: raw } };
        const card = await renderCard(update, getActiveServerSnapshot().serverId);
        // One concise line; the schema JSON is not in the card until the person opens Details.
        expect(card.getTextContent()).toContain('Native Agent session turn failed');
        expect(card.getTextContent()).not.toContain('unrecognized_keys');
        expect(card.findAllHostsByTestId('worker-update-result')).toHaveLength(0);
        await card.pressByTestIdAsync('worker-update-details-toggle');
        expect(card.getTextContent().split('unrecognized_keys').length - 1).toBe(1);
    });
    it('keeps historical results while only the latest update for each worker answers its current request', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const lead = createSessionFixture({ id: 'lead', serverId, active: true });
        let worker = createSessionFixture({ id: 'worker', serverId, active: true,
            metadata: { path: '/project', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1', flavor: 'claude' },
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: Date.now(),
            agentState: { requests: { first: { tool: 'Bash', arguments: { command: 'first command' }, createdAt: 1 } } },
        });
        const other = createSessionFixture({ id: 'other', serverId, active: true,
            metadata: { path: '/project', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1', flavor: 'claude' },
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: Date.now(),
            agentState: { requests: { other: { tool: 'Bash', arguments: { command: 'other worker command' }, createdAt: 1 } } },
        });
        const update = (result: string, workerId = worker.id): WorkerUpdateV1 => ({
            v: 1, workerKind: 'session', workerId, ownerState: 'needs_input', wake: 'needs_you',
            headline: 'Worker question', result, canInspect: true, transcriptPointer: { kind: 'session', sessionId: workerId },
        });
        const first = workerMessage('first-update', update('First result'));
        const second = workerMessage('second-update', update('Later result'));
        const otherMessage = workerMessage('other-update', update('Other result', other.id));
        const publish = (messages: readonly WorkerMessage[]) => act(() => {
            storage.getState().applySessions([lead, worker, other]);
            storage.setState({ sessionMessages: { ...storage.getState().sessionMessages,
                [lead.id]: createSessionMessagesFixture({ isLoaded: true, messageIdsOldestFirst: messages.map(message => message.id),
                    messagesById: Object.fromEntries(messages.map(message => [message.id, message])), messagesVersion: messages.length }),
                [worker.id]: createSessionMessagesFixture({ isLoaded: true }),
                [other.id]: createSessionMessagesFixture({ isLoaded: true }),
            } });
        });
        const rows = (messages: readonly WorkerMessage[]) => <AppSessionTranscriptSourceProvider sessionId={lead.id} serverId={serverId}>
            {messages.map(message => <TranscriptEventRow key={message.id} messageId={message.id} event={message.event} sessionId={lead.id}
                serverId={serverId} localId={message.localId} createdAt={message.createdAt} />)}
        </AppSessionTranscriptSourceProvider>;
        publish([first]);
        screen = await renderScreen(rows([first]));
        expect(screen.findByTestId('worker-update-answers'), screen.getTextContent()).not.toBeNull();
        expect(screen.findByTestId('permission-footer.allow'), screen.getTextContent()).not.toBeNull();
        await screen.pressByTestIdAsync('permission-footer.allow');
        await vi.waitFor(() => expect(sessionRpcTransport).toHaveBeenLastCalledWith(expect.objectContaining({
            sessionId: worker.id, method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
            payload: { id: 'first', approved: true },
        })));
        worker = { ...worker, agentStateVersion: worker.agentStateVersion + 1, pendingPermissionRequestCount: 0,
            agentState: { requests: {} } };
        publish([first]);
        expect(screen.findByTestId('worker-update-answers')).toBeNull();
        worker = { ...worker, agentStateVersion: worker.agentStateVersion + 1, pendingPermissionRequestCount: 1,
            agentState: { requests: { second: { tool: 'Bash', arguments: { command: 'different command' }, createdAt: 2 } } } };
        publish([first, second, otherMessage]);
        await screen.update(rows([first, second, otherMessage]));
        const cards = screen.findAll(node => node.type === WorkerUpdateCard);
        expect(cards).toHaveLength(3);
        const answersIn = (card: typeof cards[number]) => card.findAll(node => node.props.testID === 'worker-update-answers' && typeof node.type === 'string');
        expect(answersIn(cards[0])).toHaveLength(0);
        expect(answersIn(cards[1])).toHaveLength(1);
        expect(answersIn(cards[2])).toHaveLength(1);
        // A request the worker has moved past is told in the past tense, not as a live ask.
        const stateWord = (card: typeof cards[number]) => card.findAll(node => node.props.testID === 'worker-update-state' && typeof node.type === 'string')[0]?.props.children;
        expect(stateWord(cards[0])).toBe(`${t('sessionWork.workerUpdate.state.neededYou')} · Worker question`);
        expect(stateWord(cards[1])).toBe(`${t('sessionWork.workerUpdate.state.needsYou')} · Worker question`);
        expect(stateWord(cards[2])).toBe(`${t('sessionWork.workerUpdate.state.needsYou')} · Worker question`);
        expect(screen.getTextContent()).toContain('First result');
        expect(screen.getTextContent()).toContain('Later result');
        expect(screen.getTextContent()).toContain('different command');
    });

    it('does not borrow current answer eligibility from another Home or a historical window with newer rows missing', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const worker = createSessionFixture({ id: 'worker-window', serverId, active: true,
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: Date.now(),
            agentState: { requests: { current: { tool: 'Bash', arguments: { command: 'current command' }, createdAt: 1 } } },
        });
        storage.getState().applySessions([worker]);
        const update: WorkerUpdateV1 = { v: 1, workerKind: 'session', workerId: worker.id,
            ownerState: 'needs_input', wake: 'needs_you', headline: 'Historical question', result: 'Retained result', canInspect: true };
        for (const source of [
            createTestSessionTranscriptSource({ sessionId: 'lead', serverId: 'another-home', messages: [workerMessage('old', update)] }),
            createTestSessionTranscriptSource({ sessionId: 'lead', serverId, messages: [workerMessage('old', update)],
                history: { useState: () => ({ isLoaded: true, hasOlder: true, isLoadingOlder: false, hasNewer: true }) } }),
        ]) {
            screen = await renderWithSessionTranscriptSource(<WorkerUpdateCard update={update} messageId="old" serverId={serverId} />, source);
            expect(screen.findByTestId('worker-update-answers')).toBeNull();
            expect(screen.getTextContent()).toContain('Retained result');
            await screen.unmount();
            screen = null;
        }
    });

    it('answers a waiting worker on its needs-you card, through that worker session\'s own approval custody', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const worker = createSessionFixture({
            id: 'worker-needs-you', serverId, active: true,
            metadata: { path: '/project', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine-1', flavor: 'claude' },
            pendingPermissionRequestCount: 1, pendingRequestObservedAt: 1,
            agentState: { requests: { 'worker-request': { tool: 'Bash', arguments: { command: 'pnpm test:e2e' }, createdAt: 1 } } },
        });
        storage.getState().applySessions([worker]);
        storage.setState({ sessionMessages: { ...storage.getState().sessionMessages, [worker.id]: createSessionMessagesFixture({ isLoaded: true }) } });

        const card = await renderCard({
            v: 1, workerKind: 'session', workerId: worker.id, ownerState: 'needs_input', wake: 'needs_you',
            headline: 'Checkout UI retry states', canInspect: true, transcriptPointer: { kind: 'session', sessionId: worker.id },
        }, serverId);

        expect(card.findHostByTestId('worker-update-state')?.props.children).toBe(`${t('sessionWork.workerUpdate.state.needsYou')} · Checkout UI retry states`);
        expect(card.findByTestId('worker-update-answers')).not.toBeNull();
        // No pane host around this card: Peek is not offered where it could not open.
        expect(card.findByTestId('worker-update-peek')).toBeNull();
        expect(card.getTextContent()).toContain('pnpm test:e2e');
        await card.pressByTestIdAsync('permission-footer.allow');
        await vi.waitFor(() => expect(sessionRpcTransport).toHaveBeenLastCalledWith(expect.objectContaining({
            sessionId: worker.id, method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
            payload: { id: 'worker-request', approved: true },
        })));
    });

    it('shows no answer controls on a healthy card or once nothing is waiting, and keeps one quiet way in', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const worker = createSessionFixture({ id: 'worker-settled', serverId, active: true, agentState: { requests: {} } });
        storage.getState().applySessions([worker]);

        const card = await renderCard({
            v: 1, workerKind: 'session', workerId: worker.id, ownerState: 'settled', wake: 'finished',
            headline: 'Support runbook', result: 'Runbook drafted.', canInspect: true,
            transcriptPointer: { kind: 'session', sessionId: worker.id },
        }, serverId);

        expect(card.findByTestId('worker-update-answers')).toBeNull();
        expect(card.findByTestId('permission-prompt-card')).toBeNull();
        expect(card.findAllHostsByTestId('worker-update-inspect')).toHaveLength(1);
        expect(card.findAllHostsByTestId('worker-update-action:review')).toHaveLength(0);
    });

    it('uses the shared translated outcome without repeating the worker title and keeps a custom summary', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const worker = createSessionFixture({ id: 'worker-headline', serverId,
            metadata: { name: 'Review the rollback plan', path: '/project', host: 'qa' } });
        storage.getState().applySessions([worker]);
        const update: WorkerUpdateV1 = { v: 1, workerKind: 'session', workerId: worker.id,
            ownerState: 'settled', wake: 'finished', headline: 'Review the rollback plan · settled', canInspect: false };
        const card = await renderCard(update, serverId);
        expect(card.findHostByTestId('worker-update-state')?.props.children).toBe(t('sessionWork.workerUpdate.state.settled'));
        await card.update(<WorkerUpdateCard update={{ ...update, headline: '2 findings' }} serverId={serverId} />);
        expect(card.findHostByTestId('worker-update-state')?.props.children).toBe(`${t('sessionWork.workerUpdate.state.settled')} · 2 findings`);
    });

    it('gives a workflow run that needs you one primary Review, to the exact step in its Home', async () => {
        const navigate = vi.fn();
        const card = await renderCard({
            v: 1, workerKind: 'workflow_run', workerId: 'run_release', ownerState: 'running', wake: 'needs_you',
            headline: 'Prepare the 0.3 release', result: 'Write changelog is waiting for your review.', canInspect: true,
            transcriptPointer: { kind: 'workflow_run', runId: 'run_release', invocationRecordId: 'inv_changelog' },
        }, 'home-a', navigate);

        expect(card.findAllHostsByTestId('worker-update-inspect')).toHaveLength(0);
        await card.pressByTestIdAsync('worker-update-action:review');
        expect(navigate).toHaveBeenCalledWith('/workflows/runs/run_release?invocationId=inv_changelog&serverId=home-a');
    });

    it('states a workflow run\'s step progress as a footer fact when this device knows the run in its Home', async () => {
        act(() => {
            storage.setState({ profileScope: { serverId: 'home-a', accountId: 'account-a' } });
            storage.getState().upsertWorkflowRuns([workflowRunRowFromSummary(
                createWorkflowRunSummaryFixture({ id: 'run_review', state: 'succeeded', stepProgress: { completed: 12, total: 12 } }),
                { kind: 'available', value: { title: 'Review each changed file' } },
            )]);
        });
        const update: WorkerUpdateV1 = {
            v: 1, workerKind: 'workflow_run', workerId: 'run_review', ownerState: 'succeeded', wake: 'finished',
            headline: 'Review each changed file', result: '12 files reviewed.', canInspect: true,
            transcriptPointer: { kind: 'workflow_run', runId: 'run_review' },
        };
        const card = await renderCard(update, 'home-a');
        expect(card.findHostByTestId('worker-update-fact:progress')?.props.children)
            .toBe(t('workflows.list.stepsProgress', { completed: 12, total: 12 }));
        await card.unmount();

        // The same opaque run id on another Home is a different run: no fact is borrowed from it.
        const elsewhere = await renderCard(update, 'home-b');
        expect(elsewhere.findAllHostsByTestId('worker-update-fact:progress')).toHaveLength(0);
    });

    it('rings a failed run and keeps its way in quiet, with no primary', async () => {
        const navigate = vi.fn();
        const card = await renderCard({
            v: 1, workerKind: 'execution_run', workerId: 'run_scout', ownerState: 'failed', wake: 'finished',
            headline: 'Scout · flaky webkit tests', result: 'build-vps went offline 4 minutes in.', canInspect: true,
            transcriptPointer: { kind: 'execution_run', sessionId: 'lead', runId: 'run_scout' },
        }, 'home-a', navigate);

        expect(card.findHostByTestId('worker-update-state')?.props.children).toBe(t('sessionWork.workerUpdate.state.failed'));
        expect(card.findAllHostsByTestId('worker-update-action:review')).toHaveLength(0);
        await card.pressByTestIdAsync('worker-update-inspect');
        expect(navigate).toHaveBeenCalledTimes(1);
    });
});
