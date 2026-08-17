import * as React from 'react';
import { Platform } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { Bloom } from '@/components/voice/light/VoiceLight';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { renderScreen } from '@/dev/testkit';
import type { VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';
import {
    beginVoiceDiagnosticsRevocationObligation,
    resetVoiceDiagnosticsRuntimeStatusForTests,
} from '@/voice/diagnostics/runtimeStatus';

import { VoiceHorizon } from './VoiceHorizon';

const composerPanel = vi.hoisted(() => ({ availableHeight: undefined as number | undefined }));

vi.mock('@/components/sessions/keyboardAvoidance', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/sessions/keyboardAvoidance')>()),
    useComposerAvailablePanelHeight: () => composerPanel.availableHeight,
}));

function noop(): void {}

function listeningProjection(): VoiceAttemptControlProjection {
    const onToggle = vi.fn();
    return {
        availability: 'ready',
        live: true,
        canStart: false,
        canStop: true,
        canMute: true,
        muted: false,
        capturing: true,
        micStateLabel: 'Microphone active',
        captionLabel: 'Microphone active',
        primaryAction: 'end',
        primaryActionLabel: 'End Voice',
        primaryActionHint: 'Ends Voice',
        recoveryLabel: null,
        recoveryAvailable: false,
        surfaceState: 'listening',
        tone: 'active',
        stop: 'cool',
        sessionId: 'voice-session-1',
        onToggle,
        onToggleMute: vi.fn(),
        onRecover: vi.fn(),
        onPrimaryAction: onToggle,
        openConversationSessionId: null,
        onOpenConversation: vi.fn(),
    };
}

function modelFor(
    attemptControl: VoiceAttemptControlProjection,
    overrides: Partial<VoiceSurfaceViewModel> = {},
): VoiceSurfaceViewModel {
    return {
        attemptControl,
        activityFeedEnabled: false,
        canBargeIn: false,
        canCancelTurn: false,
        canOpenConversation: false,
        canTeleportToSessionRoot: false,
        controlsDisabled: false,
        controlsLoading: false,
        delegatedWork: null,
        expanded: false,
        isMicCaptureActive: true,
        micStateLabel: 'Microphone active',
        mode: 'listening',
        muteLabel: 'Mute microphone',
        providerLabel: null,
        startStopLabel: 'End Voice',
        status: 'connected',
        subtitle: null,
        toggleActivityLabel: 'Toggle voice activity',
        transcriptEntries: [],
        variant: 'sidebar',
        visibleTranscriptEntries: [],
        onBargeIn: noop,
        onCancelTurn: noop,
        onOpenConversation: noop,
        onTeleport: noop,
        onToggleExpanded: noop,
        ...overrides,
    };
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return style && typeof style === 'object' ? { ...style } as Record<string, unknown> : {};
}

/**
 * The three production surfaces are spatially different views of one attempt. Horizon may add
 * placement/layout facts, but it must not translate `listening` into a second colour or a second
 * Start/End target. Orb and composer already receive this projection directly; this is the owner
 * boundary that previously let Horizon diverge from them.
 */
describe('VoiceHorizon canonical attempt projection', () => {
    it('keeps a failed diagnostics shutdown out of the sidebar Horizon', async () => {
        resetVoiceDiagnosticsRuntimeStatusForTests();
        beginVoiceDiagnosticsRevocationObligation(
            { kind: 'machine_policy', machineId: 'machine-diagnostics' },
            'failed',
        );
        const screen = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceHorizon model={modelFor(listeningProjection())} />
            </VoiceEnergyProvider>,
        );

        try {
            // The status remains actionable in Voice Settings. Horizon does
            // not consume diagnostics obligations or duplicate their retry.
            expect(screen.root.findAll((node) => (
                node.props?.accessibilityLabel === 'settingsVoice.diagnostics.retryShutdown'
            ))).toHaveLength(0);
        } finally {
            resetVoiceDiagnosticsRuntimeStatusForTests();
            await screen.unmount();
        }
    });

    it('uses the canonical listening light stop and End command without a Horizon override', async () => {
        const attemptControl = listeningProjection();
        const screen = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceHorizon model={modelFor(attemptControl)} />
            </VoiceEnergyProvider>,
        );

        // react-test-renderer exposes the inner function for memoized components.
        const bloomType = (Bloom as unknown as Readonly<{ type: unknown }>).type;
        const blooms = screen.root.findAll((node) => node.type === bloomType);
        expect(blooms.length).toBeGreaterThan(0);
        expect(blooms.every((node) => node.props.stop === attemptControl.stop)).toBe(true);

        const statusBlock = screen.findByTestId('voice-surface-status-block:sidebar');
        const statusStyle = Array.isArray(statusBlock?.props.style)
            ? Object.assign({}, ...statusBlock.props.style)
            : statusBlock?.props.style;
        expect(statusStyle?.minHeight).toBeGreaterThanOrEqual(44);
        expect(screen.findByTestId('voice-surface-activity-toggle:sidebar')).toBeNull();

        const endControls = screen.root.findAll((node) => (
            typeof node.type === 'string'
            && node.props?.accessibilityLabel === 'End Voice'
            && typeof node.props?.onPress === 'function'
        ));
        expect(endControls).toHaveLength(1);
        endControls[0]!.props.onPress();
        expect(attemptControl.onToggle).toHaveBeenCalledTimes(1);

        await screen.unmount();
    });

    it('gives recovery a real platform-size target in both dimensions', async () => {
        const attemptControl: VoiceAttemptControlProjection = {
            ...listeningProjection(),
            availability: 'recoverable',
            live: false,
            canStop: false,
            canMute: false,
            capturing: false,
            primaryAction: 'recover',
            primaryActionLabel: 'Retry Voice',
            primaryActionHint: 'Retry Voice',
            recoveryLabel: 'Retry Voice',
            recoveryAvailable: true,
            surfaceState: 'error',
            tone: 'error',
        };
        const screen = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: false, direction: 'none' }}
                previewTimeMs={1_100}
            >
                <VoiceHorizon model={modelFor(attemptControl)} />
            </VoiceEnergyProvider>,
        );

        try {
            const recovery = screen.findByTestId('voice-surface-recovery:sidebar');
            expect(recovery).not.toBeNull();
            const rawStyle = recovery?.props.style;
            const style = typeof rawStyle === 'function'
                ? rawStyle({ pressed: false })
                : rawStyle;
            const targetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
            expect(flattenStyle(style)).toMatchObject({
                minWidth: targetSize,
                minHeight: targetSize,
            });
        } finally {
            await screen.unmount();
        }
    });

    it('clamps only Session Horizon to the composer scaffold available height', async () => {
        composerPanel.availableHeight = 156;
        const attemptControl = listeningProjection();
        const session = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceHorizon model={modelFor(attemptControl, {
                    activityFeedEnabled: true,
                    expanded: true,
                    variant: 'session',
                })} />
            </VoiceEnergyProvider>,
        );

        expect(flattenStyle(session.findByTestId('voice-surface-vessel:session')?.props.style).height)
            .toBe(156);

        const sidebar = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceHorizon model={modelFor(attemptControl, {
                    activityFeedEnabled: true,
                    expanded: true,
                    variant: 'sidebar',
                })} />
            </VoiceEnergyProvider>,
        );

        expect(flattenStyle(sidebar.findByTestId('voice-surface-vessel:sidebar')?.props.style).height)
            .toBe(286);

        composerPanel.availableHeight = undefined;
        await session.unmount();
        await sidebar.unmount();
    });

    it('formats transcript times with the active locale hour cycle', async () => {
        const nativeDateTimeFormat = Intl.DateTimeFormat;
        const locale = 'en-US-u-hc-h12';
        const createdAt = new Date(2026, 0, 1, 13, 5).getTime();
        const options = { hour: '2-digit', minute: '2-digit' } as const;
        const expected = new nativeDateTimeFormat(locale, options).format(createdAt);
        const constructorSpy = vi
            .spyOn(Intl, 'DateTimeFormat')
            .mockImplementation(((locales, formatterOptions) => (
                new nativeDateTimeFormat(locales ?? locale, formatterOptions)
            )) as typeof Intl.DateTimeFormat);

        const attemptControl = listeningProjection();
        const screen = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceHorizon model={modelFor(attemptControl, {
                    activityFeedEnabled: true,
                    expanded: true,
                    visibleTranscriptEntries: [{
                        id: 'spoken-1',
                        kind: 'assistant',
                        text: 'Localized timestamp',
                        createdAt,
                        interrupted: false,
                        transcriptState: 'final',
                        announce: false,
                        announcementId: 'spoken-1:1',
                    }],
                })} />
            </VoiceEnergyProvider>,
        );

        try {
            expect(expected).not.toBe('13:05');
            expect(screen.root.findAll((node) => node.props?.children === expected).length)
                .toBeGreaterThan(0);
            expect(screen.root.findAll((node) => node.props?.children === '13:05')).toHaveLength(0);
        } finally {
            constructorSpy.mockRestore();
            await screen.unmount();
        }
    });
});
