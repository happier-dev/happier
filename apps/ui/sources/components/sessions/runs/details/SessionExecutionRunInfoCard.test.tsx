import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionExecutionRunDetailsCommonModuleMocks } from './sessionExecutionRunDetailsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const navigateToSessionMock = vi.hoisted(() => vi.fn());

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
                // The card names the backend the way the rest of the app does, so the catalog
                // display name is what reaches the Backend fact — never the raw `codex` id.
                if (key === 'agentInput.agent.codex') return 'Codex';
                if (key === 'executionRuns.details.labels.backend' && values?.value) return `Backend: ${String(values.value)}`;
                if (key === 'executionRuns.details.labels.permissions' && values?.value) {
                    return `Permissions: ${String(values.value)}`;
                }
                if (key === 'executionRuns.details.labels.mode' && values?.value) return `Mode: ${String(values.value)}`;
                if (key === 'visibleAgents.visibility.session') return 'Visible session';
                if (key === 'visibleAgents.role' && values?.value) return `Role: ${String(values.value)}`;
                if (key === 'visibleAgents.model' && values?.value) return `Model: ${String(values.value)}`;
                if (key === 'executionRuns.details.labels.runId' && values?.value) return `Run ID: ${String(values.value)}`;
                if (key === 'executionRuns.details.labels.statusValue' && values?.value) return `Status: ${String(values.value)}`;
                if (key === 'executionRuns.details.launchOrigin.crossSession' && values?.sessionId) {
                    return `Started from session ${String(values.sessionId)}`;
                }
                if (key === 'executionRuns.details.launchOrigin.externalUnknown') return 'Started externally (origin unknown)';
                if (key === 'executionRuns.details.launchOrigin.legacyUnknown') return 'Launch origin unknown';
                if (key === 'executionRuns.details.titles.executionRunWithIntent' && values?.intent) {
                    return `${String(values.intent)} Subagent`;
                }
                const deliveryLabels: Record<string, string> = {
                    'executionRunDelivery.sent': 'Sent to Lead',
                    'executionRunDelivery.queued': 'Queued for Lead, delivery pending',
                    'executionRunDelivery.reported': 'Reported to Lead, relay pending',
                    'executionRunDelivery.reportPending': 'Report to Lead pending',
                    'executionRunDelivery.reportFailed': 'Report to Lead failed',
                    'executionRunDelivery.relayFailed': 'Relay to Lead failed',
                    'executionRunDelivery.notSent': 'Not sent to Lead',
                };
                if (deliveryLabels[key]) return deliveryLabels[key];
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
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => navigateToSessionMock }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-a',
}));

describe('SessionExecutionRunInfoCard', () => {
    const run = {
        runId: 'run_1',
        callId: 'toolu_1',
        sidechainId: 'toolu_1',
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'safe_yolo',
        visibility: 'session',
        role: { id: 'reviewer', name: 'Reviewer', assignmentId: 'assignment-1' },
        modelId: 'gpt-test',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'streaming',
        status: 'running',
        startedAtMs: 1,
    } as const;

    beforeEach(() => {
        navigateToSessionMock.mockReset();
    });

    it('renders a user-facing title and labeled facts instead of a raw run-id header', async () => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');
        const tree = (await renderScreen(
            <SessionExecutionRunInfoCard
                run={run as any}
                hostSessionId="session_host"
                daemonProcessLine="pid 123"
            />,
        )).tree;

        const text = JSON.stringify(tree!.toJSON());
        expect(text).toContain('Review Subagent');
        expect(text).toContain('Run ID: run_1');
        expect(text).toContain('Backend: Codex');
        expect(text).toContain('Visible session');
        expect(text).toContain('Role: Reviewer');
        expect(text).toContain('Model: gpt-test');
        expect(text).toContain('Permissions: safe_yolo');
        expect(text).toContain('Mode: bounded · streaming');
        expect(text).toContain('Status: running');
    });

    it('keeps same-session agent launches quiet', async () => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');
        const tree = (await renderScreen(
            <SessionExecutionRunInfoCard
                run={{ ...run, launchOrigin: { kind: 'session', sessionId: 'session_host' } } as any}
                hostSessionId="session_host"
            />,
        )).tree;

        const text = JSON.stringify(tree!.toJSON());
        expect(text).not.toContain('Started from session');
        expect(text).not.toContain('Launch origin unknown');
    });

    it('identifies a known cross-session launch', async () => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');
        const tree = (await renderScreen(
            <SessionExecutionRunInfoCard
                run={{ ...run, launchOrigin: { kind: 'session', sessionId: 'session_initiator' } } as any}
                hostSessionId="session_host"
            />,
        )).tree;

        expect(JSON.stringify(tree!.toJSON())).toContain('Started from session session_initiator');
    });

    it('labels unknown external and legacy-absent origins without attributing them to the host agent', async () => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');
        const external = (await renderScreen(
            <SessionExecutionRunInfoCard
                run={{ ...run, launchOrigin: { kind: 'external' } } as any}
                hostSessionId="session_host"
            />,
        )).tree;
        const legacy = (await renderScreen(
            <SessionExecutionRunInfoCard run={run as any} hostSessionId="session_host" />,
        )).tree;

        expect(JSON.stringify(external!.toJSON())).toContain('Started externally (origin unknown)');
        expect(JSON.stringify(legacy!.toJSON())).toContain('Launch origin unknown');
    });

    it.each([
        ['Sent to Lead', {
            delivery: { turnEpoch: 3, status: 'verified', localId: 'completion-1', transcriptSeq: 12, verifiedAt: 120 },
        }],
        ['Queued for Lead, delivery pending', {
            relay: { turnEpoch: 3, status: 'queued', localId: 'completion-1', at: 110 },
        }],
        ['Reported to Lead, relay pending', {
            report: { turnEpoch: 3, ack: 'accepted', reportedAt: 100, attempts: 1 },
        }],
        ['Report to Lead pending', {
            report: { turnEpoch: 3, ack: 'pending', reportedAt: 100, attempts: 1 },
        }],
        ['Report to Lead failed', {
            report: { turnEpoch: 3, ack: 'failed', reportedAt: 100, attempts: 1 },
        }],
        ['Relay to Lead failed', {
            relay: { turnEpoch: 3, status: 'failed', localId: 'completion-1', at: 110 },
        }],
        ['Not sent to Lead', {}],
    ] as const)('renders %s from the parent run link state', async (expected, receipts) => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');
        const tree = (await renderScreen(
            <SessionExecutionRunInfoCard
                run={{ ...run, linkedSessionId: 'linked-child', linkState: receipts } as any}
                hostSessionId="session_host"
            />,
        )).tree;

        expect(JSON.stringify(tree!.toJSON())).toContain(expected);
    });

    it('does not label an accepted report or queued relay as sent', async () => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');
        const tree = (await renderScreen(
            <SessionExecutionRunInfoCard run={{
                ...run,
                linkedSessionId: 'linked-child',
                linkState: {
                    report: { turnEpoch: 3, ack: 'accepted', reportedAt: 100, attempts: 1 },
                    relay: { turnEpoch: 3, status: 'queued', localId: 'completion-1', at: 110 },
                },
            } as any} />,
        )).tree;
        const text = JSON.stringify(tree!.toJSON());
        expect(text).toContain('Queued for Lead, delivery pending');
        expect(text).not.toContain('Sent to Lead');
    });

    it('opens the linked child through the child session server scope', async () => {
        const { SessionExecutionRunInfoCard } = await import('./SessionExecutionRunInfoCard');
        const screen = await renderScreen(
            <SessionExecutionRunInfoCard run={{ ...run, linkedSessionId: 'linked-child' } as any} />,
        );

        await screen.pressByTestIdAsync('execution-run-details-linked-session-run_1');

        expect(navigateToSessionMock).toHaveBeenCalledWith('linked-child', { serverId: 'server-a' });
    });
});
