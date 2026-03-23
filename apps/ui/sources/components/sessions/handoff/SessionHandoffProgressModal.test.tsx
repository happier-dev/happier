import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('SessionHandoffProgressModal', () => {
    it('shows a spinner while the modal is waiting for the first status update', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal onClose={() => {}} />,
        );

        expect(screen.getTextContent()).toContain('sessionHandoff.progress.title');
        expect(screen.getTextContent()).toContain('sessionHandoff.progress.message');
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(1);
    });

    it('renders workspace preflight summary and progress details from handoff status', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_1',
                    status: 'pending',
                    phase: 'staging_target',
                    workspacePreflightSummary: {
                        addedPathsCount: 3,
                        changedPathsCount: 2,
                        removedPathsCount: 1,
                        totalBytes: 2048,
                    },
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'transfer_blobs',
                        planned: {
                            totalFiles: 6,
                            totalBytes: 2048,
                        },
                        transferred: {
                            files: 3,
                            bytes: 1024,
                            blobs: 2,
                        },
                        current: {
                            relativePath: 'README.md',
                        },
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        expect(screen.findByTestId('session-handoff-progress-modal')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-summary')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-bar')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-percent')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-path')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-timeline')).toBeTruthy();

        const currentCheckpointRow = screen.findByTestId('session-handoff-progress-checkpoint-transfer_blobs');
        expect(currentCheckpointRow?.props.accessibilityState?.selected).toBe(true);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('+3');
        expect(textContent).toContain('~2');
        expect(textContent).toContain('-1');
        expect(textContent).toContain('2.0 KB');
        expect(textContent).toContain('50%');
        expect(textContent).toContain('README.md');
    });

    it('shows a failure presentation without a spinner when the handoff status is failed', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_failed_1',
                    status: 'failed',
                    phase: 'transferring',
                    recoveryActions: [],
                }}
            />,
        );

        expect(screen.getTextContent()).toContain('sessionHandoff.failure.title');
        expect(screen.getTextContent()).toContain('sessionHandoff.failure.message');
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
    });

    it('surfaces the phase detail when the handoff is awaiting recovery', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_recovery_1',
                    status: 'awaiting_recovery',
                    phase: 'resuming',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'stage_target',
                        planned: {},
                        transferred: {},
                        current: {
                            phaseDetail: 'daemon_restart_detected',
                        },
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        expect(screen.getTextContent()).toContain('daemon_restart_detected');
        expect(screen.findAllByType('ActivityIndicator')).toHaveLength(0);
    });

    it('renders the current checkpoint label when no current path and no progress fraction are available', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_3',
                    status: 'pending',
                    phase: 'staging_target',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'stage_target',
                        planned: {},
                        transferred: {},
                        current: {
                            phaseDetail: 'preparing_target',
                        },
                        resumable: false,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        expect(screen.findByTestId('session-handoff-progress-timeline')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-path')).toBeTruthy();
        expect(screen.getTextContent()).toContain('sessionHandoff.progress.timeline.stageTarget');
    });

    it('renders a minimal checkpoint timeline when workspace transfer is not in play', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_minimal_1',
                    status: 'pending',
                    phase: 'staging_target',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'stage_target',
                        planned: {},
                        transferred: {},
                        resumable: false,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        expect(screen.findByTestId('session-handoff-progress-checkpoint-stage_target')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-import_session')).toBeTruthy();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-finalize')).toBeTruthy();

        expect(screen.findByTestId('session-handoff-progress-checkpoint-scan_source')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-plan')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-transfer_blobs')).toBeNull();
        expect(screen.findByTestId('session-handoff-progress-checkpoint-apply')).toBeNull();
    });

    it('highlights finalize as the current checkpoint when the handoff status is completed', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_4',
                    status: 'completed',
                    phase: 'finalizing',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'import_session',
                        planned: {},
                        transferred: {},
                        resumable: false,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        const currentCheckpointRow = screen.findByTestId('session-handoff-progress-checkpoint-finalize');
        expect(currentCheckpointRow?.props.accessibilityState?.selected).toBe(true);
    });

    it('does not render summary chips when workspace preflight summary is missing', async () => {
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');

        const screen = await renderScreen(
            <SessionHandoffProgressModal
                onClose={() => {}}
                status={{
                    handoffId: 'handoff_2',
                    status: 'in_progress',
                    phase: 'transferring',
                    progress: {
                        updatedAtMs: 123,
                        checkpoint: 'transfer_blobs',
                        planned: {
                            added: 2,
                            changed: 1,
                            removed: 3,
                            totalBytes: 2048,
                        },
                        transferred: {
                            bytes: 0,
                        },
                        resumable: true,
                    },
                    recoveryActions: [],
                }}
            />,
        );

        expect(screen.findByTestId('session-handoff-progress-summary')).toBeNull();
        const textContent = screen.getTextContent();
        expect(textContent).not.toContain('+2');
        expect(textContent).not.toContain('~1');
        expect(textContent).not.toContain('-3');
        expect(textContent).not.toContain('2.0 KB');
    });
});
