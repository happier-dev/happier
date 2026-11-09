import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { readReanimatedFrameCallbacks, resetReanimatedFrameCallbacks } from '@/dev/testkit/mocks/reanimated';
import { VoiceEnergyProvider } from '@/components/voice/light/useVoiceEnergy';
import { getStorage } from '@/sync/domains/state/storage';
import { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import { VoiceComposerPlanet } from './VoiceComposerPlanet';
import { VoiceComposerPlanetMount } from './VoiceComposerPlanetMount';

const initialStorageState = getStorage().getState();
const target = { kind: 'session', sessionAddress: { serverId: 'server-1', sessionId: 'session-1' } } as const;
let composerCommits = 0;

function scene(isPresented: boolean) {
    return <VoiceEnergyProvider state={{ luminosity: 0.62, energized: true, direction: 'inward' }}
        activation={{ providerReady: true, attemptActive: true, micCaptureActive: true }}>
        <React.Profiler id="retained-composer" onRender={() => { composerCommits += 1; }}>
            <VoiceComposerPlanetMount target={target} isPresented={isPresented} />
        </React.Profiler>
    </VoiceEnergyProvider>;
}

describe('VoiceComposerPlanetMount retained presentation', () => {
    beforeEach(() => {
        getStorage().setState(initialStorageState, true);
        resetVoiceSessionStoreForTests();
        resetReanimatedFrameCallbacks();
        composerCommits = 0;
        setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'session-1',
            status: 'connected', mode: 'listening', canStop: true, micMuted: false });
    });
    afterEach(() => {
        standardCleanup();
        getStorage().setState(initialStorageState, true);
        resetVoiceSessionStoreForTests();
    });

    it('keeps tap available without offering a Hold gesture for an unsupported conversation', async () => {
        getStorage().setState(state => ({ localSettings: { ...state.localSettings, voiceHoldToTalkEnabled: true } }));
        const screen = await renderScreen(scene(true));
        try {
            const planet = screen.findByType(VoiceComposerPlanet);
            expect(planet.props.beginHoldToTalk).toBeUndefined();
            expect(planet.props.onPress).toBeTypeOf('function');
            expect(screen.findByTestId('session-composer-voice-gesture')).toBeNull();
        } finally { await screen.unmount(); }
    });

    it('releases real energy demand while hidden and restores the current attempt when presented', async () => {
        const writer = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: 'retained-composer-test' });
        const screen = await renderScreen(scene(true));
        try {
            act(() => { writer.write(1); });
            const frames = readReanimatedFrameCallbacks();
            expect(frames).toHaveLength(1);
            const frame = frames[0]!;
            expect(frame.handle.isActive).toBe(true);
            expect(screen.findByType(VoiceComposerPlanet).props.muted).toBe(false);

            await screen.update(scene(false));
            expect(screen.findByTestId('session-composer-voice')).toBeNull();
            expect(frame.handle.isActive).toBe(false);
            const commitsAfterHide = composerCommits;
            await act(async () => {
                setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'session-1',
                    status: 'connected', mode: 'listening', canStop: true, micMuted: true });
            });
            expect(screen.findByTestId('session-composer-voice')).toBeNull();
            expect(frame.handle.isActive).toBe(false);
            expect(composerCommits).toBe(commitsAfterHide);

            await screen.update(scene(true));
            expect(screen.findByTestId('session-composer-voice')).not.toBeNull();
            expect(screen.findByType(VoiceComposerPlanet).props.muted).toBe(true);
            expect(frame.handle.isActive).toBe(true);
        } finally {
            await screen.unmount();
            writer.close();
        }
    });
});
