import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

import { useVoiceLevelSourceActivity } from './useVoiceLevelSourceActive';

describe('useVoiceLevelSourceActivity', () => {
    it('tracks source ownership without rendering for continuous amplitude samples', async () => {
        const reset = voiceRuntimeLevelStore.open({
            channel: 'input',
            sourceId: 'mic-indicator-test-reset',
        });
        reset.close();

        let renderCount = 0;
        const hook = await renderHook(() => {
            renderCount += 1;
            return useVoiceLevelSourceActivity();
        });
        expect(hook.getCurrent()).toEqual({ inputSourceActive: false, outputSourceActive: false });

        let writer!: ReturnType<typeof voiceRuntimeLevelStore.open>;
        await act(async () => {
            writer = voiceRuntimeLevelStore.open({
                channel: 'input',
                sourceId: 'mic-indicator-test',
            });
        });
        try {
            expect(hook.getCurrent()).toEqual({ inputSourceActive: true, outputSourceActive: false });
            const renderCountAfterOpen = renderCount;

            await act(async () => {
                writer.write(0.75);
            });
            expect(hook.getCurrent()).toEqual({ inputSourceActive: true, outputSourceActive: false });
            expect(renderCount).toBe(renderCountAfterOpen);
        } finally {
            await act(async () => {
                writer.close();
            });
            await hook.unmount();
        }
        expect(voiceRuntimeLevelStore.getSnapshot().inputSourceActive).toBe(false);
    });
});
