import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
    EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
    ExternalSessionOperationProgressV1Schema,
    type ExternalSessionOperationProgressV1,
} from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
const checklistMock = vi.hoisted(() => vi.fn((props: Record<string, unknown>) => React.createElement('ProgressChecklist', props)));
const shimmerMock = vi.hoisted(() => vi.fn((props: Record<string, unknown> & { children?: React.ReactNode }) => (
    React.createElement('ShimmerView', props, props.children)
)));
const accessibilityPlatform = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' | 'android' }));
const announceForAccessibilityMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock({
        View: 'View',
    });
    return {
        ...base,
        AccessibilityInfo: {
            ...base.AccessibilityInfo,
            announceForAccessibility: announceForAccessibilityMock,
        },
        Platform: {
            ...base.Platform,
            get OS() {
                return accessibilityPlatform.os;
            },
        },
        Animated: {
            ...base.Animated,
            View: 'AnimatedView',
            Value: class {
                value: number;
                constructor(value: number) {
                    this.value = value;
                }
                setValue(value: number) {
                    this.value = value;
                }
                interpolate() {
                    return `${this.value * 100}%`;
                }
            },
            timing: (value: { setValue: (next: number) => void }, config: { toValue: number }) => ({
                start: () => value.setValue(config.toValue),
                stop: vi.fn(),
            }),
        },
    };
});

const itemFocusNodes = vi.hoisted(() => new Map<string, { focus: ReturnType<typeof vi.fn> }>());

vi.mock('@/components/ui/lists/Item', () => ({
    // Test boundary: the real Item forwards `pressableRef` to its Pressable host.
    // Dropping it here would make every focus-restoration assertion unfalsifiable.
    Item: ({ pressableRef, ...props }: Record<string, unknown> & {
        children?: React.ReactNode;
        pressableRef?: unknown;
        testID?: string;
    }) => {
        const testID = props.testID ?? '';
        const node = itemFocusNodes.get(testID) ?? { focus: vi.fn() };
        itemFocusNodes.set(testID, node);
        React.useEffect(() => {
            if (typeof pressableRef === 'function') {
                (pressableRef as (value: unknown) => void)(node);
                return () => (pressableRef as (value: unknown) => void)(null);
            }
            return undefined;
        });
        return React.createElement('Item', props, props.children);
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/systemTasks/ProgressChecklist', () => ({
    ProgressChecklist: checklistMock,
}));

vi.mock('@/components/ui/feedback/ShimmerView', () => ({
    ShimmerView: shimmerMock,
}));

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => true,
}));

vi.mock('@/modal', () => ({
    Modal: {
        confirm: confirmMock,
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Readonly<Record<string, unknown>>) => (
            params ? `${key}:${JSON.stringify(params)}` : key
        ),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                accent: { blue: '#00f' },
                surface: { inset: '#ddd' },
            },
        },
    });
});

function createProgress(overrides: Readonly<{
    operationId?: string;
    revision?: number;
    request?: ExternalSessionOperationProgressV1['request'];
    status?: ExternalSessionOperationProgressV1['status'];
    phase?: ExternalSessionOperationProgressV1['phase'];
    currentStorageState?: ExternalSessionOperationProgressV1['currentStorageState'];
    checkpoint?: ExternalSessionOperationProgressV1['checkpoint'];
    fence?: ExternalSessionOperationProgressV1['fence'];
    publication?: ExternalSessionOperationProgressV1['publication'];
    retryTargetPhase?: ExternalSessionOperationProgressV1['retryTargetPhase'];
    error?: ExternalSessionOperationProgressV1['error'];
}> = {}): ExternalSessionOperationProgressV1 {
    const request = overrides.request ?? {
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
    };
    const timeline = request.plan === 'materialize'
        ? EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize
        : request.targetStorageMode === 'persisted'
            ? EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_persisted
            : EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_external_linked;

    return ExternalSessionOperationProgressV1Schema.parse({
        v: 1,
        operationId: overrides.operationId ?? 'operation-1',
        revision: overrides.revision ?? 9,
        request,
        status: overrides.status ?? 'running',
        phase: overrides.phase ?? (request.plan === 'materialize' ? 'importing' : timeline[0]),
        timeline,
        updatedAtMs: 1_700_000_000_000,
        priorStableStorage: { state: 'machine_only' },
        currentStorageState: overrides.currentStorageState ?? 'machine_only',
        checkpoint: overrides.checkpoint ?? {
            sourcePagesRead: 1,
            stagedItemCount: 8,
            importedItemCount: 5,
            requiredItemFailures: {
                total: 0,
                record: 0,
                media: 0,
                conversion: 0,
                diagnosticsTruncated: false,
            },
        },
        fence: overrides.fence ?? { kind: 'none' },
        ...(overrides.publication ? { publication: overrides.publication } : {}),
        ...(overrides.retryTargetPhase ? { retryTargetPhase: overrides.retryTargetPhase } : {}),
        ...(overrides.error ? { error: overrides.error } : {}),
    });
}

const { ExternalImportProgressCard } = await import('./ExternalImportProgressCard');

describe('ExternalImportProgressCard', () => {
    it('exposes one polite atomic web status region for semantic operation progress', async () => {
        accessibilityPlatform.os = 'web';
        announceForAccessibilityMock.mockClear();

        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            progress: createProgress(),
            observationContext: 'live',
            originAvailability: 'online',
            onDismiss: vi.fn(),
            onCancel: vi.fn(),
        }));

        const status = screen.findByTestId('external-session-operation-a11y-status');
        expect(status?.props).toMatchObject({
            accessibilityLiveRegion: 'polite',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': true,
        });
        expect(status?.props.accessibilityLabel).toBeUndefined();
        expect(status?.props.children.props.children).toContain(
            'externalSessions.operationPhaseImporting',
        );
        expect(announceForAccessibilityMock).not.toHaveBeenCalled();
    });

    it('announces iOS semantic transitions without repeating count and revision ticks', async () => {
        accessibilityPlatform.os = 'ios';
        announceForAccessibilityMock.mockClear();
        const commonProps = {
            observationContext: 'live' as const,
            originAvailability: 'online' as const,
            onDismiss: vi.fn(),
            onResume: vi.fn(),
            onCancel: vi.fn(),
        };
        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            ...commonProps,
            progress: createProgress(),
        }));

        expect(screen.findByTestId('external-session-operation-a11y-status')).toBeNull();
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            expect.stringContaining('externalSessions.operationPhaseImporting'),
        );

        await screen.update(React.createElement(ExternalImportProgressCard, {
            ...commonProps,
            progress: createProgress({
                revision: 10,
                checkpoint: {
                    sourcePagesRead: 2,
                    stagedItemCount: 9,
                    importedItemCount: 6,
                    requiredItemFailures: {
                        total: 0,
                        record: 0,
                        media: 0,
                        conversion: 0,
                        diagnosticsTruncated: false,
                    },
                },
            }),
        }));
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);

        await screen.update(React.createElement(ExternalImportProgressCard, {
            ...commonProps,
            progress: createProgress({
                revision: 11,
                status: 'awaiting_user_resume',
                retryTargetPhase: 'importing',
            }),
        }));
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(2);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            expect.stringContaining('externalSessions.operationStatusNeedsResume'),
        );

        await screen.update(React.createElement(ExternalImportProgressCard, {
            ...commonProps,
            progress: createProgress({
                revision: 12,
                phase: 'publishing',
            }),
        }));
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(3);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            expect.stringContaining('externalSessions.operationPhasePublishing'),
        );

        await screen.update(React.createElement(ExternalImportProgressCard, {
            ...commonProps,
            progress: createProgress({
                revision: 13,
                status: 'completed',
                phase: 'publishing',
                currentStorageState: 'snapshot_complete',
                checkpoint: {
                    sourcePagesRead: 2,
                    stagedItemCount: 8,
                    importedItemCount: 8,
                    acceptedThroughServerSeq: 8,
                    requiredItemFailures: {
                        total: 0,
                        record: 0,
                        media: 0,
                        conversion: 0,
                        diagnosticsTruncated: false,
                    },
                },
                publication: {
                    materializationPublicationId: 'publication-1',
                    publishedThroughServerSeq: 8,
                    materializedThroughSourceAt: 1_700_000_000_000,
                },
            }),
        }));
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(4);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            expect.stringContaining('externalSessions.operationStatusCompleted'),
        );
    });

    it('uses the Android polite live region without an imperative duplicate', async () => {
        accessibilityPlatform.os = 'android';
        announceForAccessibilityMock.mockClear();

        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            progress: createProgress(),
            observationContext: 'live',
            originAvailability: 'online',
            onDismiss: vi.fn(),
            onCancel: vi.fn(),
        }));

        expect(screen.findByTestId('external-session-operation-a11y-status')?.props.accessibilityLiveRegion)
            .toBe('polite');
        expect(announceForAccessibilityMock).not.toHaveBeenCalled();
    });

    it('announces an iOS semantic summary change when availability changes without another state transition', async () => {
        accessibilityPlatform.os = 'ios';
        announceForAccessibilityMock.mockClear();
        const progress = createProgress({
            status: 'failed',
            retryTargetPhase: 'importing',
            error: {
                code: 'historical_import_failed',
                retryable: false,
                occurredAtMs: 1_700_000_000_000,
            },
        });
        const commonProps = {
            progress,
            observationContext: 'live' as const,
            onDismiss: vi.fn(),
        };
        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            ...commonProps,
            originAvailability: 'online',
        }));

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            expect.stringContaining('externalSessions.operationStatusFailed'),
        );

        await screen.update(React.createElement(ExternalImportProgressCard, {
            ...commonProps,
            originAvailability: 'offline',
        }));

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(2);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            expect.stringContaining('externalSessions.operationStatusOriginOffline'),
        );
    });

    it('reuses the shared checklist and emits Resume only from durable awaiting progress', async () => {
        checklistMock.mockClear();
        const onResume = vi.fn();
        const onCancel = vi.fn();

        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            progress: createProgress({
                status: 'awaiting_user_resume',
                retryTargetPhase: 'importing',
            }),
            observationContext: 'hydrated',
            originAvailability: 'online',
            onDismiss: vi.fn(),
            onResume,
            onCancel,
        }));

        expect(checklistMock).toHaveBeenCalledOnce();
        expect(checklistMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            testIDPrefix: 'external-session-operation-step',
        }));
        expect(onResume).not.toHaveBeenCalled();
        expect(onCancel).not.toHaveBeenCalled();

        const resume = screen.findByTestId('external-session-operation-action-resume');
        expect(resume?.props.accessibilityRole).toBe('button');
        expect(resume?.props.accessibilityLabel).toBe('externalSessions.operationActionResume');

        await screen.pressByTestIdAsync('external-session-operation-action-resume');
        expect(onResume).toHaveBeenCalledWith({
            operationId: 'operation-1',
            revision: 9,
        });
    });

    it('keeps offline recovery actions visible but disabled when no owner handler is available', async () => {
        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            progress: createProgress({
                status: 'awaiting_user_resume',
                retryTargetPhase: 'importing',
            }),
            observationContext: 'hydrated',
            originAvailability: 'offline',
            onDismiss: vi.fn(),
        }));

        const resume = screen.findByTestId('external-session-operation-action-resume');
        expect(resume?.props).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: 'externalSessions.operationActionResume',
            disabled: true,
        });
        expect(resume?.props.onPress).toBeUndefined();

        const cancel = screen.findByTestId('external-session-operation-action-cancel');
        expect(cancel?.props).toMatchObject({
            accessibilityRole: 'button',
            accessibilityLabel: 'externalSessions.operationActionCancel',
            disabled: true,
        });
        expect(cancel?.props.onPress).toBeUndefined();
    });

    it('requires destructive confirmation before emitting the whole-session discard intent', async () => {
        confirmMock.mockReset();
        confirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const onDiscard = vi.fn();
        const progress = createProgress({
            status: 'awaiting_user_resume',
            retryTargetPhase: 'importing',
            currentStorageState: 'server_partial',
            checkpoint: {
                sourcePagesRead: 2,
                stagedItemCount: 12,
                importedItemCount: 8,
                requiredItemFailures: {
                    total: 0,
                    record: 0,
                    media: 0,
                    conversion: 0,
                    diagnosticsTruncated: false,
                },
                acceptedThroughServerSeq: 8,
            },
            fence: {
                kind: 'initial_server_partial',
                acceptedThroughServerSeq: 8,
            },
        });

        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            progress,
            observationContext: 'live',
            originAvailability: 'online',
            onDismiss: vi.fn(),
            onDiscard,
        }));

        await screen.pressByTestIdAsync('external-session-operation-action-discard');
        expect(onDiscard).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('external-session-operation-action-discard');
        expect(confirmMock).toHaveBeenCalledWith(
            'externalSessions.operationDiscardConfirmTitle',
            'externalSessions.operationDiscardConfirmBody',
            expect.objectContaining({ destructive: true }),
        );
        expect(onDiscard).toHaveBeenCalledWith({
            operationId: 'operation-1',
            revision: 9,
        });
    });

    it('emits materialize validating Retry through the Retry handler rather than Resume', async () => {
        const onResume = vi.fn();
        const onRetry = vi.fn();
        const progress = createProgress({
            status: 'awaiting_user_resume',
            phase: 'validating',
            retryTargetPhase: 'validating',
        });

        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            progress,
            observationContext: 'live',
            originAvailability: 'online',
            onDismiss: vi.fn(),
            onResume,
            onRetry,
        }));

        await screen.pressByTestIdAsync('external-session-operation-action-retry');
        expect(onRetry).toHaveBeenCalledWith({
            operationId: 'operation-1',
            revision: 9,
        });
        expect(onResume).not.toHaveBeenCalled();
    });

    it('emits persisted takeover Retry start with the exact durable operation revision', async () => {
        const onRetry = vi.fn();
        const progress = createProgress({
            request: {
                plan: 'takeover',
                targetStorageMode: 'persisted',
                targetRuntimeMode: 'terminal',
            },
            status: 'failed',
            phase: 'spawning',
            currentStorageState: 'hosted',
            retryTargetPhase: 'spawning',
            error: {
                code: 'spawn_failed',
                retryable: true,
                occurredAtMs: 1_700_000_000_000,
            },
        });

        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            progress,
            observationContext: 'hydrated',
            originAvailability: 'online',
            onDismiss: vi.fn(),
            onRetry,
        }));

        await screen.pressByTestIdAsync('external-session-operation-action-retry_start');
        expect(onRetry).toHaveBeenCalledWith({
            operationId: 'operation-1',
            revision: 9,
        });
    });

    it('fences same-tick action presses and exposes a busy disabled action group', async () => {
        let resolveResume!: () => void;
        const onResume = vi.fn(() => new Promise<void>((resolve) => {
            resolveResume = resolve;
        }));
        const onCancel = vi.fn();

        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            progress: createProgress({
                status: 'awaiting_user_resume',
                retryTargetPhase: 'importing',
            }),
            observationContext: 'hydrated',
            originAvailability: 'online',
            onDismiss: vi.fn(),
            onResume,
            onCancel,
        }));
        const resume = screen.findByTestId('external-session-operation-action-resume');

        await act(async () => {
            void resume?.props.onPress();
            void resume?.props.onPress();
            await Promise.resolve();
        });

        expect(onResume).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('external-session-operation-progress-card')?.props.accessibilityState)
            .toEqual({ busy: true });
        expect(screen.findByTestId('external-session-operation-action-resume')?.props.loading).toBe(true);
        expect(screen.findByTestId('external-session-operation-action-cancel')?.props.disabled).toBe(true);

        await act(async () => {
            resolveResume();
            await Promise.resolve();
        });

        expect(screen.findByTestId('external-session-operation-progress-card')?.props.accessibilityState)
            .toEqual({ busy: false });
    });

    it('returns focus to a remaining action when the invoked one is replaced', async () => {
        itemFocusNodes.clear();
        const onResume = vi.fn(async () => undefined);
        const onCancel = vi.fn(async () => undefined);
        const props = {
            observationContext: 'hydrated' as const,
            originAvailability: 'online' as const,
            onDismiss: vi.fn(),
            onResume,
            onCancel,
        };
        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            ...props,
            progress: createProgress({
                status: 'awaiting_user_resume',
                retryTargetPhase: 'importing',
            }),
        }));
        expect(screen.findByTestId('external-session-operation-action-resume')).not.toBeNull();
        expect(screen.findByTestId('external-session-operation-action-cancel')).not.toBeNull();

        await screen.pressByTestIdAsync('external-session-operation-action-resume');
        expect(onResume).toHaveBeenCalledTimes(1);

        await screen.update(React.createElement(ExternalImportProgressCard, {
            ...props,
            progress: createProgress({
                revision: 10,
                status: 'running',
                phase: 'importing',
            }),
        }));

        expect(screen.findByTestId('external-session-operation-action-resume')).toBeNull();
        const cancelNode = itemFocusNodes.get('external-session-operation-action-cancel');
        const resumeNode = itemFocusNodes.get('external-session-operation-action-resume');
        expect(cancelNode?.focus).toHaveBeenCalledTimes(1);
        expect(resumeNode?.focus).not.toHaveBeenCalled();
    });

    it('leaves focus alone when the invoked action survives its own result', async () => {
        itemFocusNodes.clear();
        const onRetry = vi.fn(async () => undefined);
        const props = {
            observationContext: 'live' as const,
            originAvailability: 'online' as const,
            onDismiss: vi.fn(),
            onResume: vi.fn(async () => undefined),
            onRetry,
            onCancel: vi.fn(async () => undefined),
        };
        const failedProgress = () => createProgress({
            status: 'awaiting_user_resume',
            phase: 'validating',
            retryTargetPhase: 'validating',
        });
        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            ...props,
            progress: failedProgress(),
        }));
        expect(screen.findByTestId('external-session-operation-action-retry')).not.toBeNull();

        await screen.pressByTestIdAsync('external-session-operation-action-retry');
        expect(onRetry).toHaveBeenCalledTimes(1);

        // The retry did not change the operation, so the control the reader
        // activated is still under them and must keep focus.
        await screen.update(React.createElement(ExternalImportProgressCard, {
            ...props,
            progress: failedProgress(),
        }));

        expect(screen.findByTestId('external-session-operation-action-retry')).not.toBeNull();
        for (const node of itemFocusNodes.values()) expect(node.focus).not.toHaveBeenCalled();
    });

    it('delegates terminal dismissal with the exact revision without owning its lifetime', async () => {
        const onDismiss = vi.fn();
        const screen = await renderScreen(React.createElement(ExternalImportProgressCard, {
            progress: createProgress({
                status: 'cancelled',
                phase: 'importing',
            }),
            observationContext: 'hydrated',
            originAvailability: 'offline',
            onDismiss,
        }));

        expect(screen.findByTestId('external-session-operation-action-dismiss')).not.toBeNull();
        await screen.pressByTestIdAsync('external-session-operation-action-dismiss');
        expect(onDismiss).toHaveBeenCalledWith({
            operationId: 'operation-1',
            revision: 9,
        });
        expect(screen.findByTestId('external-session-operation-progress-card')).not.toBeNull();
    });

    it('renders indeterminate import progress without motion when reduced motion is enabled', async () => {
        shimmerMock.mockClear();
        const { ExternalSessionImportProgressBar } = await import('./ExternalSessionImportProgressBar');

        const screen = await renderScreen(React.createElement(ExternalSessionImportProgressBar, {
            importedItemCount: 5,
            totalItemEstimate: null,
            ratio: null,
            accessibilityLabel: 'Import progress',
        }));

        expect(screen.findByTestId('external-session-operation-progress-indeterminate')).not.toBeNull();
        expect(shimmerMock).toHaveBeenCalledWith(
            expect.objectContaining({ animationEnabled: false }),
            undefined,
        );
    });
});
