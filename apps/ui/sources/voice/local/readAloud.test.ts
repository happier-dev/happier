import { beforeEach, describe, expect, it, vi } from 'vitest';

const speak = vi.hoisted(() => vi.fn());
vi.mock('@/voice/output/speakAssistantText', () => ({ speakAssistantText: speak }));

import { getReadAloudActiveKey, toggleReadAloud } from './readAloud';

const settings = { voice: { providerId: 'local_conversation', adapters: { local_conversation: { networkTimeoutMs: 5000 } } } } as any;

/** A speak call that stays "playing" until the test finishes it or its registered stopper runs. */
function holdSpeech() {
    let finish!: (ok: boolean) => void;
    speak.mockImplementationOnce(async (params: any) => {
        const done = new Promise<boolean>((resolve) => { finish = resolve; });
        const unregister = params.registerPlaybackStopper(() => finish(true));
        try { return await done; } finally { unregister(); }
    });
    return () => finish(true);
}

describe('toggleReadAloud', () => {
    beforeEach(() => { speak.mockReset(); });

    it('speaks the text through the canonical speaker and marks the message active while it plays', async () => {
        const finish = holdSpeech();
        const pending = toggleReadAloud({ key: 'm1', text: 'hello', settings });
        expect(getReadAloudActiveKey()).toBe('m1');
        expect(speak).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello', settings, networkTimeoutMs: 5000 }));
        finish();
        await expect(pending).resolves.toBe(true);
        expect(getReadAloudActiveKey()).toBeNull();
    });

    it('stops playback when the active message is pressed again', async () => {
        holdSpeech();
        const pending = toggleReadAloud({ key: 'm1', text: 'hello', settings });
        await toggleReadAloud({ key: 'm1', text: 'hello', settings });
        await pending;
        expect(speak).toHaveBeenCalledTimes(1);
        expect(getReadAloudActiveKey()).toBeNull();
    });

    it('switches to another message, stopping the first', async () => {
        holdSpeech();
        const first = toggleReadAloud({ key: 'm1', text: 'one', settings });
        const finishSecond = holdSpeech();
        const second = toggleReadAloud({ key: 'm2', text: 'two', settings });
        await first;
        expect(getReadAloudActiveKey()).toBe('m2');
        finishSecond();
        await second;
        expect(getReadAloudActiveKey()).toBeNull();
    });

    it('reports a provider failure and clears the active message', async () => {
        speak.mockResolvedValueOnce(false);
        await expect(toggleReadAloud({ key: 'm1', text: 'hello', settings })).resolves.toBe(false);
        expect(getReadAloudActiveKey()).toBeNull();
    });
});
