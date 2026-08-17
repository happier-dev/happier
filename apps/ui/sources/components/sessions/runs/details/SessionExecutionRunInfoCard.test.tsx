import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionExecutionRunDetailsCommonModuleMocks } from './sessionExecutionRunDetailsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionExecutionRunDetailsCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => ({
                    settings: {
                        acpCatalogSettingsV1: { v: 2, backends: [] },
                    },
                }),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, values) => {
                if (key === 'session.subagents.intent.review') return 'Review';
                if (key === 'executionRuns.details.labels.backend' && values?.value) return `Backend: ${String(values.value)}`;
                if (key === 'executionRuns.details.labels.permissions' && values?.value) {
                    return `Permissions: ${String(values.value)}`;
                }
                if (key === 'executionRuns.details.labels.mode' && values?.value) return `Mode: ${String(values.value)}`;
                if (key === 'executionRuns.details.labels.runId' && values?.value) return `Run ID: ${String(values.value)}`;
                if (key === 'executionRuns.details.labels.statusValue' && values?.value) return `Status: ${String(values.value)}`;
                if (key === 'executionRuns.details.titles.executionRunWithIntent' && values?.intent) {
                    return `${String(values.intent)} Subagent`;
                }
                return key;
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#111',
                    surfaceHigh: '#222',
                    divider: '#333',
                    text: '#eee',
                    textSecondary: '#aaa',
                    accent: {
                        blue: '#06f',
                        green: '#0a0',
                        orange: '#f80',
                        red: '#f33',
                    },
                },
            },
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

describe('SessionExecutionRunInfoCard', () => {
    it('renders a user-facing title and labeled facts instead of a raw run-id header', async () => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');
        const tree = (await renderScreen(
            <SessionExecutionRunInfoCard
                run={{
                    runId: 'run_1',
                    callId: 'toolu_1',
                    sidechainId: 'toolu_1',
                    intent: 'review',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    permissionMode: 'safe_yolo',
                    runClass: 'bounded',
                    ioMode: 'streaming',
                    status: 'running',
                    startedAtMs: 1,
                } as any}
                daemonProcessLine="pid 123"
            />,
        )).tree;

        const text = JSON.stringify(tree!.toJSON());
        expect(text).toContain('Review Subagent');
        expect(text).toContain('Run ID: run_1');
        expect(text).toContain('Backend: agentInput.agent.codex');
        expect(text).toContain('Permissions: safe_yolo');
        expect(text).toContain('Mode: bounded · streaming');
        expect(text).toContain('Status: running');
    });

    it('labels canonical V2 backend targets in the same user-facing way', async () => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');
        const tree = (await renderScreen(
            <SessionExecutionRunInfoCard
                run={{
                    runId: 'run_2',
                    callId: 'toolu_2',
                    sidechainId: 'toolu_2',
                    intent: 'review',
                    backendTarget: {
                        kind: 'backend',
                        backendId: 'review-bot',
                        configuredBackendId: 'review-bot',
                        sourceKind: 'configured',
                    } as any,
                    permissionMode: 'safe_yolo',
                    runClass: 'bounded',
                    ioMode: 'streaming',
                    status: 'running',
                    startedAtMs: 1,
                } as any}
                daemonProcessLine="pid 123"
            />,
        )).tree;

        const text = JSON.stringify(tree!.toJSON());
        expect(text).toContain('Review Subagent');
        expect(text).toContain('Backend: review-bot');
    });

    it('shows no finish time for a run whose finish was never recorded, instead of 1 January 1970', async () => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');
        const render = async (finishedAtMs: number) => JSON.stringify((await renderScreen(
            <SessionExecutionRunInfoCard
                run={{
                    runId: 'run_4',
                    callId: 'toolu_4',
                    sidechainId: 'toolu_4',
                    intent: 'review',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    permissionMode: 'safe_yolo',
                    runClass: 'bounded',
                    ioMode: 'streaming',
                    status: 'succeeded',
                    startedAtMs: 1_700_000_000_000,
                    finishedAtMs,
                } as any}
            />,
        )).tree!.toJSON());

        // The derivations fall back to a history row's creation instant, which is itself 0 when the
        // row carries none — so a 0 finish reaches this card the same way a 0 start does.
        expect(await render(0)).not.toContain('executionRuns.details.timestamps.finished');
        expect(await render(1_700_000_016_000)).toContain('executionRuns.details.timestamps.finished');
    });

    it('shows no start time for a run whose start was never recorded, instead of 1 January 1970', async () => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');
        const render = async (startedAtMs: number) => JSON.stringify((await renderScreen(
            <SessionExecutionRunInfoCard
                run={{
                    runId: 'run_3',
                    callId: 'toolu_3',
                    sidechainId: 'toolu_3',
                    intent: 'review',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    permissionMode: 'safe_yolo',
                    runClass: 'bounded',
                    ioMode: 'streaming',
                    status: 'succeeded',
                    startedAtMs,
                } as any}
            />,
        )).tree!.toJSON());

        // `startedAtMs` is required on the wire, so an unrecorded start arrives as the 0 sentinel —
        // and `new Date(0)` prints an epoch date as though it were an observed fact.
        expect(await render(0)).not.toContain('executionRuns.details.timestamps.started');
        // A genuinely recorded start is still shown.
        expect(await render(1_700_000_000_000)).toContain('executionRuns.details.timestamps.started');
    });
});
