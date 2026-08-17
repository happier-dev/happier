/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import type { VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';

import { VoiceHorizon } from './VoiceHorizon';

/**
 * What Horizon's status block actually puts in the browser.
 *
 * Both guarantees here are **DOM** guarantees, and they are asserted against the *real*
 * `react-native-web` prop mapping rather than a hand-written approximation of it. That is the
 * whole point of the file: the disclosure state shipped broken while a prop-level assertion on
 * `expanded` passed, because react-native-web 0.21 has no `accessibilityState` handling at all
 * (`react-native-web/dist/modules/forwardedProps/index.js` forwards `aria-expanded` and the
 * deprecated `accessibilityExpanded`, and nothing else reaches `aria-expanded`). A mock that
 * invents that mapping tests the mock.
 *
 *  1. **§2.1 — with a feed, the status block IS the disclosure control** and carries no chevron,
 *     so open vs closed is available to assistive tech only as button state. Without a feed, the
 *     same status stays accessible but must expose no dead button or disclosure state.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The real web renderer. `react-native` is what the component imports; on web Expo aliases it to
// `react-native-web`, so this is the mapping the browser performs, not a description of it.
vi.mock('react-native', async () => await vi.importActual('react-native-web'));

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock() as Record<string, unknown>;
    // Reanimated cannot run its UI-thread renderer here, but its animated host must still be a
    // real react-native-web View so everything below it keeps the production prop mapping.
    const { View } = await vi.importActual<{ View: React.ComponentType<Record<string, unknown>> }>(
        'react-native-web',
    );
    return { ...mock, default: { ...(mock.default as object), View }, View };
});

// The sky inside the vessel is decorative and carries no state alone; rendering nothing keeps the
// gradient stub out of the DOM tree these assertions read.
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));

vi.mock('react-native-svg', () => {
    const passthrough = (name: string) => (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('div', { 'data-svg': name }, props.children as React.ReactNode);
    return {
        Svg: passthrough('svg'),
        Circle: passthrough('circle'),
        Defs: passthrough('defs'),
        RadialGradient: passthrough('radialGradient'),
        Stop: passthrough('stop'),
        Rect: passthrough('rect'),
        LinearGradient: passthrough('linearGradient'),
        Path: passthrough('path'),
        G: passthrough('g'),
    };
});

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: () => React.createElement('div', { 'data-icon': true }),
}));

function noop(): void {}

function buildAttemptControl(): VoiceSurfaceViewModel['attemptControl'] {
    return {
        availability: 'ready', live: true, canStart: false, canStop: true, canMute: true,
        muted: false, capturing: true, micStateLabel: 'Microphone active',
        captionLabel: 'Microphone active', primaryAction: 'end', primaryActionLabel: 'End Voice',
        primaryActionHint: 'End Voice', recoveryAvailable: false, recoveryLabel: null,
        surfaceState: 'listening', tone: 'active', stop: 'cool', sessionId: 'session-1',
        onToggle: noop, onToggleMute: noop, onRecover: noop, onPrimaryAction: noop,
        openConversationSessionId: null, onOpenConversation: noop,
    };
}

function buildModel(overrides: Partial<VoiceSurfaceViewModel> = {}): VoiceSurfaceViewModel {
    return {
        attemptControl: buildAttemptControl(),
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(model: VoiceSurfaceViewModel): Promise<HTMLElement> {
    if (!container) {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    }
    const activeRoot = root;
    if (!activeRoot) throw new Error('root was not created');

    act(() => {
        activeRoot.render(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceHorizon model={model} />
            </VoiceEnergyProvider>,
        );
    });
    return container;
}

describe('VoiceHorizon web DOM contract', () => {
    afterEach(async () => {
        const activeRoot = root;
        if (activeRoot) {
            act(() => {
                activeRoot.unmount();
            });
        }
        container?.remove();
        container = null;
        root = null;
    });

    it('keeps decorative layers out of the pointer path without deprecated RNW props', async () => {
        const onToggleExpanded = vi.fn();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            const host = await render(buildModel({
                activityFeedEnabled: true,
                onToggleExpanded,
            }));
            const toggle = host.querySelector<HTMLElement>('[data-testid="voice-surface-activity-toggle:sidebar"]');
            expect(toggle).not.toBeNull();

            act(() => {
                toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
            expect(onToggleExpanded).toHaveBeenCalledTimes(1);

            const deprecatedPointerEventsWarnings = warning.mock.calls.filter(([message]) => (
                String(message).includes('props.pointerEvents is deprecated. Use style.pointerEvents')
            ));
            expect(deprecatedPointerEventsWarnings).toEqual([]);
        } finally {
            warning.mockRestore();
        }
    });

    it('reports the disclosure state of its status block to the browser', async () => {
        const host = await render(buildModel({ activityFeedEnabled: true, expanded: false }));

        const toggle = host.querySelector('[data-testid="voice-surface-activity-toggle:sidebar"]');
        expect(toggle).toBeInstanceOf(HTMLElement);
        // The status block is the only signal of open vs closed (§2.1): no chevron, no second
        // control. A button with no `aria-expanded` reads identically before and after it acts.
        expect((toggle as HTMLElement).getAttribute('aria-expanded')).toBe('false');

        await render(buildModel({ activityFeedEnabled: true, expanded: true }));

        const expandedToggle = host.querySelector('[data-testid="voice-surface-activity-toggle:sidebar"]');
        expect((expandedToggle as HTMLElement).getAttribute('aria-expanded')).toBe('true');
    });

    it('keeps status accessible but removes disclosure semantics when the feed is disabled', async () => {
        const host = await render(buildModel({ activityFeedEnabled: false, expanded: true }));

        expect(host.querySelector('[data-testid="voice-surface-activity-toggle:sidebar"]')).toBeNull();
        const statusBlock = host.querySelector('[data-testid="voice-surface-status-block:sidebar"]');
        expect(statusBlock).toBeInstanceOf(HTMLElement);
        expect((statusBlock as HTMLElement).getAttribute('aria-label')).toContain('voiceAssistant.listening');
        expect((statusBlock as HTMLElement).hasAttribute('aria-expanded')).toBe(false);
        expect((statusBlock as HTMLElement).getAttribute('role')).not.toBe('button');
    });

});
