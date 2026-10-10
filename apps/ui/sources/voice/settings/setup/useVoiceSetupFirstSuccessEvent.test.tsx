import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, type RenderHookResult } from '@/dev/testkit/hooks/renderHook';
import type { VoiceMarkEvent } from '@/components/voice/presence/resolveVoiceMarkPose';

import { useVoiceSetupFirstSuccessEvent } from './useVoiceSetupFirstSuccessEvent';

type Props = Readonly<{ complete: boolean; live: boolean }>;
let hook: RenderHookResult<VoiceMarkEvent | null, Props> | null = null;
afterEach(async () => {
    await hook?.unmount();
    hook = null;
});

const mount = async (initialProps: Props) => {
    hook = await renderHook((props: Props) => useVoiceSetupFirstSuccessEvent(props.complete, props.live), { initialProps });
    return hook;
};

describe('useVoiceSetupFirstSuccessEvent', () => {
    it('is the first success only when it completes here, after the person tried', async () => {
        const h = await mount({ complete: false, live: false });
        expect(h.getCurrent()).toBeNull();
        await h.rerender({ complete: false, live: true });
        expect(h.getCurrent()).toBeNull();
        // The reply may land just after the person ends the try.
        await h.rerender({ complete: true, live: false });
        const event = h.getCurrent();
        expect(event).toEqual({ kind: 'gather', id: 'voice-setup:first-success' });
        await h.rerender({ complete: true, live: true });
        expect(h.getCurrent()).toBe(event);
    });

    it('never gathers for history: already complete, or completed by hydration without a try', async () => {
        const done = await mount({ complete: true, live: false });
        await done.rerender({ complete: true, live: true });
        expect(done.getCurrent()).toBeNull();
        await done.unmount();
        const hydrated = await mount({ complete: false, live: false });
        await hydrated.rerender({ complete: true, live: false });
        expect(hydrated.getCurrent()).toBeNull();
    });
});
