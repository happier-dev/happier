import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { VoiceComposerPlanetMount } from '@/components/voice/composer/VoiceComposerPlanetMount';
import { VoiceTopBarPresence } from '@/components/voice/presence/VoiceTopBarPresence';
import { useVoiceAttemptControl, VOICE_ATTEMPT_IDLE_TARGET_GLOBAL, type VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { getStorage } from '@/sync/domains/state/storage';
import { getVoiceSessionSnapshot, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { VoiceSurfaceView } from '@/components/voice/surface/VoiceSurfaceView';
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
 * do not coalesce. The title presence, Companion section and composer coexist,
 * so presentation-local regions would announce the same transition repeatedly.
 */

vi.mock('@/components/pets/source/useSelectedPetPackage', () => ({
    useSelectedPetPackage: () => ({ enabled: false, source: null }),
}));

function noop(): void {}

function buildSurfaceModel(control: VoiceAttemptControlProjection): VoiceSurfaceViewModel {
    return {
        attemptControl: control,
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
        targetLabel: 'Dashboard auth',
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

function MountedPresentations() {
    const control = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
    return <>
        <VoiceSurfaceView model={buildSurfaceModel(control)} />
        <VoiceTopBarPresence voice={control} />
        <VoiceComposerPlanetMount target={{ kind: 'session', sessionAddress: { serverId: 'server-1', sessionId: 'composer-session-1' } }} />
    </>;
}

const initialStorageState = getStorage().getState();
beforeEach(() => {
    getStorage().setState(initialStorageState, true);
    setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'voice-session-1', status: 'connected', mode: 'listening', canStop: true, micMuted: false });
});
afterEach(() => {
    getStorage().setState(initialStorageState, true);
    setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
});

describe('one Voice announcer for the whole app shell', () => {
    it('publishes exactly one live region with the Voice section, the top-bar presence and the composer all mounted', async () => {
        const screen = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceAnnouncer />
                <MountedPresentations />
            </VoiceEnergyProvider>,
        );

        // All three presentations really are on screen — otherwise "one region"
        // would be trivially true because nothing rendered.
        expect(screen.findByTestId('voice-glance')).toBeTruthy();
        expect(screen.findByTestId('voice-top-bar')).toBeTruthy();
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
                <MountedPresentations />
            </VoiceEnergyProvider>,
        );

        try {
            expect(screen.findByTestId(VOICE_ANNOUNCER_TEST_ID)?.props.children?.props.children).toBe('');
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

    it('projects microphone, mute, and recovery facts into the one app announcer', async () => {
        const screen = await renderScreen(
            <VoiceEnergyProvider
                state={{ luminosity: 0.5, energized: true, direction: 'inward' }}
                previewTimeMs={1_100}
            >
                <VoiceAnnouncer />
            </VoiceEnergyProvider>,
        );

        try {
            await act(async () => { setVoiceSessionSnapshot({ ...getVoiceSessionSnapshot(), micMuted: true }); });
            expect(screen.findByTestId(VOICE_ANNOUNCER_TEST_ID)?.props.children?.props.children)
                .toBe(tLoose('voiceSurface.a11y.microphoneMuted'));

            await act(async () => { setVoiceSessionSnapshot({ ...getVoiceSessionSnapshot(), status: 'error', mode: 'idle', canStop: false, errorRecoveryAction: 'retry', errorPresentation: 'error' }); });
            expect(screen.findByTestId(VOICE_ANNOUNCER_TEST_ID)?.props.children?.props.children)
                .toContain(tLoose('common.retry'));
            expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(1);
        } finally {
            await screen.unmount();
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
            'components/voice/presence/VoiceGlance.tsx',
            'components/voice/presence/VoiceIsland.tsx',
            'components/voice/presence/VoiceTopBarPresence.tsx',
            'components/voice/presence/VoiceOrb.tsx',
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
