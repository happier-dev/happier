import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
} from '@/dev/testkit/mocks/reanimated';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';

import { VoiceOrb } from './VoiceOrb';
import { resolveVoiceOrbHitRect } from './voiceOrbGeometry';
import { resolvePetCompanionOverlayMetrics } from '@/components/pets/render/petCompanionDisplayMetrics';

const platformState = vi.hoisted(() => ({ os: 'web' }));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => 1 }));

const localSettings = vi.hoisted(() => ({
    voiceOrbEnabled: true,
    voiceOrbExpanded: false,
    petsCompanionSizeScale: 1,
} as Record<string, unknown>));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => localSettings[key],
    useLocalSettingMutable: (key: string) => [localSettings[key], vi.fn()],
    useSetting: () => ({}),
    storage: () => null,
}));

const attemptControl = vi.hoisted(() => ({
    current: {
        availability: 'ready' as 'ready' | 'recoverable' | 'unavailable',
        live: false,
        canStart: true,
        canStop: false,
        canMute: false,
        muted: false,
        capturing: false,
        micStateLabel: 'Microphone inactive',
        captionLabel: 'Microphone inactive',
        primaryAction: 'start' as 'start' | 'end' | 'recover' | null,
        primaryActionLabel: 'Start Voice',
        primaryActionHint: 'Start Voice',
        recoveryAvailable: false,
        recoveryLabel: null as string | null,
        surfaceState: 'idle' as 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error',
        tone: 'neutral' as const,
        stop: 'cool' as const,
        sessionId: null as string | null,
        onToggle: vi.fn(),
        onToggleMute: vi.fn(),
        onRecover: vi.fn(),
        onPrimaryAction: vi.fn(),
        openConversationSessionId: null as string | null,
        onOpenConversation: vi.fn(),
    },
}));

vi.mock('@/components/voice/attempt/useVoiceAttemptControl', () => ({
    useVoiceAttemptControl: () => attemptControl.current,
    // The orb states its idle target explicitly (§2.5); the mount imports the canonical value.
    VOICE_ATTEMPT_IDLE_TARGET_GLOBAL: { kind: 'global' },
}));

/** The settled keyboard height the app shell publishes. `0` unless a test opens the keyboard. */
const keyboard = vi.hoisted(() => ({ height: 0 }));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => keyboard.height,
}));

const selectedPet = vi.hoisted(() => ({ enabled: false, source: null as unknown }));

vi.mock('@/components/pets/source/useSelectedPetPackage', () => ({
    useSelectedPetPackage: () => selectedPet,
}));

const tauri = vi.hoisted(() => ({ desktop: false }));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => tauri.desktop,
}));

/** The two chrome bands the shell publishes, as the live frame measured them. */
const chrome = vi.hoisted(() => ({ bottomChromeHeight: 0, composerChromeHeight: 0 }));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry')>()),
    useSessionCockpitBottomChromeHeight: () => chrome.bottomChromeHeight,
    useSessionCockpitComposerChromeHeight: () => chrome.composerChromeHeight,
}));

/**
 * The energy clock is a real app-level provider (it wraps the shell in `(app)/_layout.tsx`), so the
 * orb renders under a frozen one here rather than a stub — the light material below it stays real.
 */
function withEnergy(node: React.ReactElement): React.ReactElement {
    return (
        <VoiceEnergyProvider
            state={{ luminosity: 0.4, energized: false, direction: 'none' }}
            previewTimeMs={1_100}
        >
            {node}
        </VoiceEnergyProvider>
    );
}

function withLiveEnergy(node: React.ReactElement): React.ReactElement {
    return (
        <VoiceEnergyProvider
            state={{ luminosity: 0.62, energized: true, direction: 'inward' }}
            activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}
        >
            {node}
        </VoiceEnergyProvider>
    );
}

/**
 * The orb is a **presence**, and a presence the user switched off must leave nothing behind.
 *
 * The specific trap this pins: the design-lab orb kept rendering an `accessibilityLiveRegion` when
 * disabled, so a screen reader still announced every Voice state change for a companion that was
 * not on screen. Disabled means nothing at all — the app-shell announcer owns announcements.
 */
describe('VoiceOrbAppShellMount', () => {
    it('renders nothing at all when the device preference is off — including no live region', async () => {
        localSettings.voiceOrbEnabled = false;
        const { VoiceOrbAppShellMount } = await import('./VoiceOrbAppShellMount');

        const screen = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));

        expect(screen.tree.toJSON()).toBeNull();
        expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(0);
        expect(screen.tree.root.findAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
    });

    it('renders nothing when the attempt is terminally unavailable', async () => {
        localSettings.voiceOrbEnabled = true;
        attemptControl.current = {
            ...attemptControl.current,
            availability: 'unavailable',
            canStart: false,
        };
        const { VoiceOrbAppShellMount } = await import('./VoiceOrbAppShellMount');

        const screen = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));

        expect(screen.tree.toJSON()).toBeNull();
    });

    it('mounts the orb when the preference is on and a transport is usable', async () => {
        localSettings.voiceOrbEnabled = true;
        attemptControl.current = {
            ...attemptControl.current,
            availability: 'ready',
            canStart: true,
        };
        const { VoiceOrbAppShellMount } = await import('./VoiceOrbAppShellMount');

        const screen = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));

        expect(screen.findByTestId('voice-orb-app-shell-root')).toBeTruthy();
        expect(screen.findByTestId('voice.orb.body')).toBeTruthy();
    });

    it('passes the placement-neutral ready, connecting, and recovery captions into the sheet', async () => {
        localSettings.voiceOrbEnabled = true;
        const originalControl = attemptControl.current;
        const { VoiceOrbAppShellMount } = await import('./VoiceOrbAppShellMount');

        attemptControl.current = {
            ...attemptControl.current,
            availability: 'ready',
            surfaceState: 'idle',
            captionLabel: 'Microphone inactive',
        };
        const ready = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));
        expect(ready.tree.root.findByType(VoiceOrb).props.labels.caption).toBe('Microphone inactive');

        attemptControl.current = {
            ...attemptControl.current,
            surfaceState: 'connecting',
            captionLabel: 'Microphone inactive',
        };
        const connecting = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));
        expect(connecting.tree.root.findByType(VoiceOrb).props.labels.caption).toBe('Microphone inactive');

        attemptControl.current = {
            ...attemptControl.current,
            availability: 'recoverable',
            primaryAction: 'recover',
            recoveryAvailable: true,
            recoveryLabel: 'Open Voice settings',
            captionLabel: 'Open Voice settings',
        };
        const recovery = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));
        expect(recovery.tree.root.findByType(VoiceOrb).props.labels.caption).toBe('Open Voice settings');
        attemptControl.current = originalControl;
    });

    it('keeps the app energy clock alive when the Orb is the only visible Voice surface', async () => {
        resetReanimatedFrameCallbacks();
        localSettings.voiceOrbEnabled = true;
        attemptControl.current = {
            ...attemptControl.current,
            availability: 'ready',
            live: true,
            canStart: false,
            canStop: true,
        };
        const { VoiceOrbAppShellMount } = await import('./VoiceOrbAppShellMount');

        const screen = await renderScreen(withLiveEnergy(React.createElement(VoiceOrbAppShellMount)));
        const callbacks = readReanimatedFrameCallbacks();

        expect(callbacks).toHaveLength(1);
        expect(callbacks[0]!.setActiveCalls).toEqual([false, true]);
        // The app-level energy provider outlives the Orb. Remove only the
        // consumer so the retained clock can prove its 1→0 release transition.
        await screen.update(withLiveEnergy(<></>));
        expect(callbacks[0]!.setActiveCalls).toEqual([false, true, false]);
    });

    /**
     * The composer band only reaches the orb if the mount actually consumes it. Without this the
     * clearance lives in a resolver nothing calls with a real height, and the orb keeps landing on
     * Send exactly as it did live.
     */
    it('lifts the orb clear of the composer band the shell publishes', async () => {
        localSettings.voiceOrbEnabled = true;
        attemptControl.current = { ...attemptControl.current, availability: 'ready', canStart: true };
        // Measured live at 440×950: bottom chrome 62pt, composer controls from y=790 upward.
        chrome.bottomChromeHeight = 62;
        chrome.composerChromeHeight = 98;
        keyboard.height = 0;
        const { VoiceOrbAppShellMount } = await import('./VoiceOrbAppShellMount');

        const screen = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));

        const orb = screen.tree.root.findByType(VoiceOrb);
        const hitRect = resolveVoiceOrbHitRect({
            hostWidth: 440,
            hostHeight: 950,
            restingBottomInset: orb.props.restingBottomInset as number,
        });
        // `session-composer-send` measured 32×32 at (374, 838).
        expect(hitRect.y + hitRect.height).toBeLessThanOrEqual(838);
        expect(orb.props.restingBottomInset).toBe(62 + 98 + 12);
    });

    /**
     * The unfixed half of P1.3: the shell hides the mobile bottom chrome while the keyboard is up,
     * so the published band collapses to `0` at exactly the moment the biggest obstacle appears.
     * A mount that only consumes the chrome parks the orb on the keyboard — over the composer, and
     * over the End Voice the expanded sheet puts down there.
     */
    it('clears the keyboard once the shell drops the bottom chrome for it', async () => {
        localSettings.voiceOrbEnabled = true;
        attemptControl.current = { ...attemptControl.current, availability: 'ready', canStart: true };
        chrome.bottomChromeHeight = 0;
        chrome.composerChromeHeight = 98;
        keyboard.height = 291;
        const { VoiceOrbAppShellMount } = await import('./VoiceOrbAppShellMount');

        const screen = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));

        const orb = screen.tree.root.findByType(VoiceOrb);
        expect(orb.props.restingBottomInset).toBe(291 + 98 + 12);
        keyboard.height = 0;
    });

    it('keeps the pet collision offset for the in-webview Orb under Tauri', async () => {
        localSettings.voiceOrbEnabled = true;
        attemptControl.current = { ...attemptControl.current, availability: 'ready', canStart: true };
        chrome.bottomChromeHeight = 0;
        chrome.composerChromeHeight = 0;
        keyboard.height = 0;
        const { VoiceOrbAppShellMount } = await import('./VoiceOrbAppShellMount');

        const withoutPet = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));
        const baselineInset = withoutPet.tree.root.findByType(VoiceOrb).props.restingBottomInset as number;

        tauri.desktop = true;
        selectedPet.enabled = true;
        selectedPet.source = { kind: 'test-pet' };
        const withPet = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));
        const petInset = withPet.tree.root.findByType(VoiceOrb).props.restingBottomInset as number;

        expect(platformState.os).toBe('web');
        expect(petInset - baselineInset).toBe(
            resolvePetCompanionOverlayMetrics(1).spriteHeight + 12,
        );

        selectedPet.enabled = false;
        selectedPet.source = null;
        tauri.desktop = false;
    });

    it('takes the keyboard out of the space the sheet may claim', async () => {
        localSettings.voiceOrbEnabled = true;
        attemptControl.current = { ...attemptControl.current, availability: 'ready', canStart: true };
        chrome.bottomChromeHeight = 0;
        chrome.composerChromeHeight = 0;
        const { VoiceOrbAppShellMount } = await import('./VoiceOrbAppShellMount');

        keyboard.height = 0;
        const closed = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));
        const closedHeight = closed.tree.root.findByType(VoiceOrb).props.availableSheetHeight as number;

        keyboard.height = 291;
        const open = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));
        const openHeight = open.tree.root.findByType(VoiceOrb).props.availableSheetHeight as number;

        expect(openHeight).toBe(closedHeight - 291);
        keyboard.height = 0;
    });

    /**
     * §2.5 — a session-bound attempt is the one case where the orb owes the user a way back to the
     * exact conversation it is running in. The action comes from the projection's canonical binding;
     * the mount only names and dispatches it.
     */
    it('offers the exact conversation of a session-bound attempt, and nothing for a global one', async () => {
        localSettings.voiceOrbEnabled = true;
        chrome.bottomChromeHeight = 0;
        chrome.composerChromeHeight = 0;
        const { VoiceOrbAppShellMount } = await import('./VoiceOrbAppShellMount');

        attemptControl.current = {
            ...attemptControl.current,
            availability: 'ready',
            live: true,
            canStart: false,
            canStop: true,
            sessionId: 'control-1',
            openConversationSessionId: null,
            onOpenConversation: vi.fn(),
        };
        const global = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));
        expect(global.tree.root.findByType(VoiceOrb).props.extraControls).toHaveLength(0);

        const onOpenConversation = vi.fn();
        attemptControl.current = {
            ...attemptControl.current,
            openConversationSessionId: 'conversation-7',
            onOpenConversation,
        };
        const bound = await renderScreen(withEnergy(React.createElement(VoiceOrbAppShellMount)));
        const orb = bound.tree.root.findByType(VoiceOrb);
        const controls = orb.props.extraControls as ReadonlyArray<{ id: string; label: string }>;

        expect(controls.map((control) => control.id)).toEqual(['openConversation']);
        expect(controls[0]!.label.length).toBeGreaterThan(0);

        (orb.props.onAction as (id: string) => void)('openConversation');
        expect(onOpenConversation).toHaveBeenCalledTimes(1);
    });
});
