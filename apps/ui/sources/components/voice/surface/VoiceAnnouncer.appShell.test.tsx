import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { VoiceComposerPlanetMount } from '@/components/voice/composer/VoiceComposerPlanetMount';
import { VoiceOrbAppShellMount } from '@/components/voice/orb/VoiceOrbAppShellMount';
import { VoiceHorizon } from '@/components/voice/surface/presentations/VoiceHorizon';
import type { VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';
import { tLoose } from '@/text';
import {
    beginVoiceDiagnosticsRevocationObligation,
    resetVoiceDiagnosticsRuntimeStatusForTests,
} from '@/voice/diagnostics/runtimeStatus';

import { VoiceAnnouncer, VOICE_ANNOUNCER_TEST_ID } from './VoiceAnnouncer';

/**
 * §5.4a / §10.4a case 3 — **exactly one** Voice live region, app-wide.
 *
 * Two `aria-live` nodes are two queues and two Android views are two events; they
 * do not coalesce. M4 says at least two `VoiceSurface` instances are mounted at
 * once on desktop, and the orb and the composer planet are mounted on top of
 * that, so "every presentation owns its own region" announces each transition
 * three or four times with duplicated muted and recovery text.
 */

const voiceSetting = vi.hoisted(() => ({
    current: { ui: { activityFeedEnabled: false } } as Record<string, unknown>,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    return {
        ...actual,
        useSetting: (key: string) => (
            key === 'voice' ? voiceSetting.current : (actual.useSetting as (k: string) => unknown)(key)
        ),
    };
});

const attemptControl = vi.hoisted(() => ({
    current: {
        availability: 'ready' as 'ready' | 'recoverable' | 'unavailable',
        live: true,
        canStart: false,
        canStop: true,
        canMute: true,
        muted: false,
        capturing: true,
        micStateLabel: 'Microphone active',
        captionLabel: 'Microphone active',
        primaryAction: 'end' as const,
        primaryActionLabel: 'End Voice',
        primaryActionHint: 'End Voice',
        recoveryAvailable: false,
        recoveryLabel: null,
        surfaceState: 'listening' as const,
        tone: 'active' as const,
        stop: 'violet' as const,
        sessionId: 'voice-session-1' as string | null,
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
    // The announcer and the orb both state their idle target explicitly (§2.5).
    VOICE_ATTEMPT_IDLE_TARGET_GLOBAL: { kind: 'global' },
}));

vi.mock('@/components/pets/source/useSelectedPetPackage', () => ({
    useSelectedPetPackage: () => ({ enabled: false, source: null }),
}));

function noop(): void {}

function buildHorizonModel(): VoiceSurfaceViewModel {
    return {
        attemptControl: attemptControl.current,
        activityFeedEnabled: true,
        canBargeIn: false,
        canCancelTurn: false,
        canOpenConversation: false,
        canTeleportToSessionRoot: false,
        controlsDisabled: false,
        controlsLoading: false,
        delegatedWork: null,
        expanded: true,
        isMicCaptureActive: true,
        micStateLabel: 'Microphone active',
        mode: 'listening',
        muteLabel: 'Mute microphone',
        providerLabel: null,
        startStopLabel: 'End Voice',
        status: 'connected',
        subtitle: 'Target session: Dashboard auth',
        toggleActivityLabel: 'Toggle voice activity',
        transcriptEntries: [],
        variant: 'sidebar',
        visibleTranscriptEntries: [],
        onBargeIn: noop,
        onCancelTurn: noop,
        onOpenConversation: noop,
        onTeleport: noop,
        onToggleExpanded: noop,
    };
}

describe('one Voice announcer for the whole app shell', () => {
    it('publishes exactly one live region with Horizon, the orb and the composer all mounted', async () => {
        const screen = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceAnnouncer />
                <VoiceHorizon model={buildHorizonModel()} />
                <VoiceOrbAppShellMount />
                <VoiceComposerPlanetMount sessionId="composer-session-1" />
            </VoiceEnergyProvider>,
        );

        // All three presentations really are on screen — otherwise "one region"
        // would be trivially true because nothing rendered.
        expect(screen.findByTestId('voice-surface:sidebar')).toBeTruthy();
        expect(screen.findByTestId('voice-orb-app-shell-root')).toBeTruthy();
        expect(screen.findByTestId('session-composer-voice')).toBeTruthy();

        const liveRegions = screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'polite' });
        expect(liveRegions).toHaveLength(1);
        expect(screen.findByTestId(VOICE_ANNOUNCER_TEST_ID)).toBeTruthy();

        await screen.unmount();
    });

    it('hands the claim owner a scope built from the account and the live attempt', async () => {
        /*
         * The scoped claim is only worth anything if the app actually supplies a
         * scope: a `VoiceAnnouncerSurface` left with a constant key is the same
         * module-global dedupe that swallowed the second account's announcements.
         * `useActiveServerAccountScope` is null in this harness (no signed-in
         * profile), so the account half falls back to `unscoped` while the attempt
         * half must still carry the mocked session.
         */
        const screen = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceAnnouncer />
            </VoiceEnergyProvider>,
        );

        const scopes = new Set(
            screen.tree.root
                .findAll((node) => typeof node.props?.announcementScopeKey === 'string')
                .map((node) => String(node.props.announcementScopeKey)),
        );
        expect([...scopes]).toEqual(['unscoped|voice-session-1']);

        await screen.unmount();
    });

    it('keeps a failed diagnostics shutdown out of every front Voice surface and the app announcer', async () => {
        resetVoiceDiagnosticsRuntimeStatusForTests();
        beginVoiceDiagnosticsRevocationObligation(
            { kind: 'machine_policy', machineId: 'voice-announcer-diagnostics' },
            'failed',
        );
        const screen = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceAnnouncer />
                <VoiceHorizon model={buildHorizonModel()} />
                <VoiceOrbAppShellMount />
                <VoiceComposerPlanetMount sessionId="composer-session-1" />
            </VoiceEnergyProvider>,
        );

        try {
            expect(screen.findByTestId(VOICE_ANNOUNCER_TEST_ID)?.props.accessibilityLabel).toBe('');
            expect(screen.root.findAllByProps({
                accessibilityLabel: tLoose('settingsVoice.diagnostics.retryShutdown'),
            })).toHaveLength(0);
            expect(screen.getTextContent()).not.toContain(
                tLoose('settingsVoice.diagnostics.shutdownFailedIndicator'),
            );
        } finally {
            await screen.unmount();
            resetVoiceDiagnosticsRuntimeStatusForTests();
        }
    });
});

const SOURCES_ROOT = join(process.cwd(), 'sources');

function readSource(relativePath: string): string {
    return readFileSync(join(SOURCES_ROOT, relativePath), 'utf8');
}

/**
 * The announcer is only the app's announcer if the app mounts it, and *where* it
 * mounts is the whole decision: `AuthenticatedAppRuntimeMountsGate` returns null
 * while the onboarding journey is active (`app/(app)/_layout.tsx:61-67`) while
 * `JourneyVoiceStageSurface.tsx` still renders a Voice surface. Mounting inside
 * the gate makes onboarding silent on every platform, and no runtime assertion in
 * this package can see that, so the mount site is pinned as source structure —
 * the way `voiceEnergyAppMount.test.ts` pins the energy provider.
 */
describe('Voice announcer app mount', () => {
    it('mounts once in the app layout', () => {
        const layout = readSource('app/(app)/_layout.tsx');
        expect(layout).toContain('VoiceAnnouncer');
        expect(layout.match(/<VoiceAnnouncer\s*\/>/g)).toHaveLength(1);
    });

    it('mounts outside the runtime gate that onboarding switches off', () => {
        const runtimeMounts = readSource('components/appShell/runtime/AuthenticatedAppRuntimeMounts.tsx');
        expect(runtimeMounts).not.toContain('VoiceAnnouncer');
    });

    it('leaves no second announcer inside a presentation', () => {
        for (const presentation of [
            'components/voice/surface/presentations/VoiceHorizon.tsx',
            'components/voice/orb/VoiceOrb.tsx',
            'components/voice/composer/VoiceComposerPlanet.tsx',
        ]) {
            expect(readSource(presentation)).not.toContain('accessibilityLiveRegion');
        }
    });

    it('marks every seeded onboarding transcript row non-announcing', () => {
        const fixture = readSource(
            'components/onboarding/tour/stage/surfaces/JourneyVoiceStageSurface.tsx',
        );
        expect(fixture.match(/announce:\s*false/g)).toHaveLength(3);
        expect(fixture).not.toMatch(/announce:\s*true/);
    });
});
