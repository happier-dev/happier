import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerUpdateV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    createSessionFixture, createSessionMessagesFixture, createTestSessionTranscriptSource,
    renderWithSessionTranscriptSource, type RenderScreenResult,
} from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { t } from '@/text';

import { WorkerUpdateCard } from './WorkerUpdateCard';

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
afterEach(async () => {
    await screen?.unmount();
    screen = null;
    act(() => storage.setState(initialState));
    sessionRpcTransport.mockClear();
});

async function renderCard(update: WorkerUpdateV1, serverId: string, navigate: (href: string) => void = () => {}) {
    const source = createTestSessionTranscriptSource({ sessionId: 'lead', serverId, navigate });
    screen = await renderWithSessionTranscriptSource(<WorkerUpdateCard update={update} serverId={serverId} at={Date.now() - 3 * 60_000} />, source);
    return screen;
}

describe('WorkerUpdateCard states (lab cards-T1/T2)', () => {
    it('answers a waiting worker on its needs-you card, through that worker session\'s own approval custody', async () => {
        await loadSyncSingletonForTests();
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

        expect(card.findHostByTestId('worker-update-state')?.props.children).toBe(t('sessionWork.workerUpdate.state.needsYou'));
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
        await loadSyncSingletonForTests();
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
