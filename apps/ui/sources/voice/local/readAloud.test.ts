import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';

// Boundary: the device speech engine. Everything above it (speakAssistantText, provider routing,
// the shared playback controller) is real.
type SpeakOptions = { onDone?: () => void; onStopped?: () => void; onError?: (error: unknown) => void };
const expoSpeech = vi.hoisted(() => ({
    speak: vi.fn<(text: string, options: SpeakOptions) => void>(),
    stop: vi.fn(),
}));
vi.mock('expo-speech', () => expoSpeech);

import { localVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

import { speakAssistantText } from '@/voice/output/speakAssistantText';
import { storage } from '@/sync/domains/state/storageStore';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

import { toggleReadAloud } from './readAloud';
import { getReadAloudActiveKey, useIsReadingAloud } from './readAloudState';

const settings = {
    experiments: true,
    featureToggles: { voice: true },
    voice: voiceSettingsParse({
        providerId: 'local_conversation',
        adapters: { local_conversation: { tts: { provider: 'device' } } },
    }),
};

/** Utterances the device engine is currently "playing"; finishing one mirrors a real onDone. */
let utterances: SpeakOptions[] = [];
const initialStorageState = storage.getState();

describe('toggleReadAloud', () => {
    beforeEach(async () => {
        storage.setState({ settings: { ...initialStorageState.settings, ...settings } });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(createRootLayoutFeaturesResponse({ features: { voice: { enabled: true } } }))));
        await getServerFeaturesSnapshot({ force: true });
        utterances = [];
        expoSpeech.speak.mockReset();
        expoSpeech.speak.mockImplementation((_text, options) => { utterances.push(options); });
        // A real engine reports the stop asynchronously; tests decide when via `utterances`.
        expoSpeech.stop.mockReset();
    });

    afterEach(() => {
        storage.setState(initialStorageState, true);
        utterances.forEach(utterance => utterance.onStopped?.());
        vi.unstubAllGlobals();
    });

    it('does not start speech when the canonical feature is disabled', async () => {
        await toggleReadAloud({ key: 'm1', text: 'hello', settings: { ...settings, featureToggles: { voice: false } } });
        expect(expoSpeech.speak).not.toHaveBeenCalled();
        expect(getReadAloudActiveKey()).toBeNull();
    });

    it('stops when the server revokes voice without a mounted transcript button', async () => {
        const reading = toggleReadAloud({ key: 'm1', text: 'hello', settings });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(createRootLayoutFeaturesResponse({ features: { voice: { enabled: false } } }))));
        await getServerFeaturesSnapshot({ force: true });
        expect(expoSpeech.stop).toHaveBeenCalledTimes(1);
        expect(getReadAloudActiveKey()).toBeNull();
        utterances[0].onStopped?.();
        await reading;
    });

    it('speaks the cleaned-up message and is active only while it plays', async () => {
        const pending = toggleReadAloud({ key: 'm1', text: 'Hello **world**', settings });
        expect(getReadAloudActiveKey()).toBe('m1');
        expect(expoSpeech.speak).toHaveBeenCalledWith('Hello world', expect.any(Object));

        utterances[0].onDone?.();
        await expect(pending).resolves.toBe(true);
        expect(getReadAloudActiveKey()).toBeNull();
    });

    it('stops playback when the playing message is pressed again', async () => {
        const first = toggleReadAloud({ key: 'm1', text: 'hello', settings });
        await toggleReadAloud({ key: 'm1', text: 'hello', settings });

        expect(expoSpeech.stop).toHaveBeenCalledTimes(1);
        expect(getReadAloudActiveKey()).toBeNull();
        utterances[0].onStopped?.();
        await first;
    });

    it('keeps Stop available when a message is restarted before its stopped run has finished', async () => {
        const first = toggleReadAloud({ key: 'm1', text: 'hello', settings });
        await toggleReadAloud({ key: 'm1', text: 'hello', settings }); // stop
        const restarted = toggleReadAloud({ key: 'm1', text: 'hello', settings });
        expect(getReadAloudActiveKey()).toBe('m1');

        utterances[0].onStopped?.(); // the first run finishes late
        await first;
        expect(getReadAloudActiveKey()).toBe('m1');

        utterances[1].onDone?.();
        await restarted;
        expect(getReadAloudActiveKey()).toBeNull();
    });

    it('switches to another message and stops the first', async () => {
        const first = toggleReadAloud({ key: 'm1', text: 'one', settings });
        const second = toggleReadAloud({ key: 'm2', text: 'two', settings });
        expect(expoSpeech.stop).toHaveBeenCalledTimes(1);
        expect(getReadAloudActiveKey()).toBe('m2');

        utterances[0].onStopped?.();
        await first;
        expect(getReadAloudActiveKey()).toBe('m2');
        utterances[1].onDone?.();
        await second;
    });

    it('stops a live voice reply that is already playing', async () => {
        const liveVoiceStopper = vi.fn();
        localVoicePlaybackController.registerStopper(liveVoiceStopper);

        const pending = toggleReadAloud({ key: 'm1', text: 'hello', settings });
        expect(liveVoiceStopper).toHaveBeenCalledTimes(1);

        utterances[0].onDone?.();
        await pending;
    });

    it('is interrupted by the live voice controller, as a barge-in would', async () => {
        const pending = toggleReadAloud({ key: 'm1', text: 'hello', settings });
        localVoicePlaybackController.interrupt();
        expect(expoSpeech.stop).toHaveBeenCalledTimes(1);
        expect(getReadAloudActiveKey()).toBeNull();

        utterances[0].onStopped?.();
        await pending;
        expect(getReadAloudActiveKey()).toBeNull();
    });

    it('resolves false and clears the active message when the voice provider fails', async () => {
        expoSpeech.speak.mockImplementationOnce(() => { throw new Error('no voice'); });
        await expect(toggleReadAloud({ key: 'm1', text: 'hello', settings })).resolves.toBe(false);
        expect(getReadAloudActiveKey()).toBeNull();
    });

    it('only rerenders the message that starts or stops playing', async () => {
        let otherRenders = 0;
        const own = await renderHook(() => useIsReadingAloud('m1'));
        await renderHook(() => { otherRenders += 1; return useIsReadingAloud('m2'); });
        const rendersBefore = otherRenders;

        let pending!: Promise<boolean>;
        await act(async () => { pending = toggleReadAloud({ key: 'm1', text: 'hello', settings }); });
        expect(own.getCurrent()).toBe(true);
        await act(async () => { utterances[0].onDone?.(); await pending; });
        expect(own.getCurrent()).toBe(false);
        expect(otherRenders).toBe(rendersBefore);
    });

    it('is taken over by a live voice reply, which stops it before speaking', async () => {
        const reading = toggleReadAloud({ key: 'm1', text: 'hello', settings });
        const live = speakAssistantText({
            text: 'reply',
            settings,
            networkTimeoutMs: 1000,
            registerPlaybackStopper: localVoicePlaybackController.registerStopper,
            onSpeaking: () => {},
        });
        expect(expoSpeech.stop).toHaveBeenCalledTimes(1);
        expect(getReadAloudActiveKey()).toBeNull();

        utterances[0].onStopped?.();
        await reading;
        utterances[1].onDone?.();
        await live;
    });

    it('does not invalidate the playback epoch a live turn captured when it takes over', async () => {
        const reading = toggleReadAloud({ key: 'm1', text: 'hello', settings });
        const liveTurnEpoch = localVoicePlaybackController.captureEpoch();

        const live = speakAssistantText({
            text: 'first chunk',
            settings,
            networkTimeoutMs: 1000,
            registerPlaybackStopper: localVoicePlaybackController.registerStopper,
            onSpeaking: () => {},
        });
        expect(localVoicePlaybackController.isEpochCurrent(liveTurnEpoch)).toBe(true);

        utterances[0].onStopped?.();
        await reading;
        utterances[1].onDone?.();
        await live;
    });

    it('leaves a live voice reply alone when nothing is being read aloud', async () => {
        const liveStopper = vi.fn();
        localVoicePlaybackController.registerStopper(liveStopper);
        const live = speakAssistantText({
            text: 'reply',
            settings,
            networkTimeoutMs: 1000,
            registerPlaybackStopper: localVoicePlaybackController.registerStopper,
            onSpeaking: () => {},
        });
        expect(liveStopper).not.toHaveBeenCalled();
        expect(expoSpeech.stop).not.toHaveBeenCalled();
        utterances[0].onDone?.();
        await live;
    });

    describe('long messages', () => {
        // Three ~120-character sentences: more than one default chunk, so synthesis must be split.
        const sentences = ['A', 'B', 'C'].map(letter => `${letter.repeat(5)} ${'word '.repeat(22)}ends here.`);
        const longText = sentences.join(' ');

        it('speaks one sentence-sized piece at a time so the first sound is not delayed by the whole message', async () => {
            const pending = toggleReadAloud({ key: 'm1', text: longText, settings });
            expect(expoSpeech.speak).toHaveBeenCalledTimes(1);
            expect(expoSpeech.speak.mock.calls[0][0]).toBe(sentences[0]);

            await act(async () => { utterances[0].onDone?.(); });
            expect(expoSpeech.speak.mock.calls.map(call => call[0])).toEqual(sentences.slice(0, 2));
            await act(async () => { utterances[1].onDone?.(); });
            await act(async () => { utterances[2].onDone?.(); });

            await expect(pending).resolves.toBe(true);
            expect(expoSpeech.speak.mock.calls.map(call => call[0])).toEqual(sentences);
            expect(getReadAloudActiveKey()).toBeNull();
        });

        it('does not speak the remaining pieces once the message is stopped', async () => {
            const pending = toggleReadAloud({ key: 'm1', text: longText, settings });
            await toggleReadAloud({ key: 'm1', text: longText, settings }); // press again: stop
            await act(async () => { utterances[0].onStopped?.(); });

            await expect(pending).resolves.toBe(true);
            expect(expoSpeech.speak).toHaveBeenCalledTimes(1);
            expect(getReadAloudActiveKey()).toBeNull();
        });

        it('keeps context across pieces: a long bare URL is dropped whole and a mid-line minus sign survives', async () => {
            const url = `https://example.com/${'a'.repeat(400)}`;
            const pending = toggleReadAloud({ key: 'm1', text: `Open ${url} now. The result: Here is the answer. - 5 is negative.`, settings });
            for (let i = 0; i < 4 && utterances[i]; i += 1) await act(async () => { utterances[i].onDone?.(); });
            await expect(pending).resolves.toBe(true);

            const spoken = expoSpeech.speak.mock.calls.map(call => call[0]);
            expect(spoken.join(' ')).not.toContain('aaaa');
            expect(spoken).toContain('- 5 is negative.');
        });

        it('reports a provider failure part-way through and skips the rest', async () => {
            const pending = toggleReadAloud({ key: 'm1', text: longText, settings });
            expoSpeech.speak.mockImplementationOnce(() => { throw new Error('no voice'); });
            await act(async () => { utterances[0].onDone?.(); });

            await expect(pending).resolves.toBe(false);
            expect(expoSpeech.speak).toHaveBeenCalledTimes(2);
        });
    });
});
