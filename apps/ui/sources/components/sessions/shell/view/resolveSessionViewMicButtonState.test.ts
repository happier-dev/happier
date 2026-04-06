import { describe, expect, it, vi } from 'vitest';

import { resolveSessionViewMicButtonState } from './resolveSessionViewMicButtonState';

describe('resolveSessionViewMicButtonState', () => {
    it('returns a shared inactive empty state when the mic is disconnected and off', () => {
        const first = resolveSessionViewMicButtonState({
            voiceProviderId: 'off',
            voiceStatus: 'disconnected',
            onMicPress: undefined,
        });
        const second = resolveSessionViewMicButtonState({
            voiceProviderId: 'off',
            voiceStatus: 'disconnected',
            onMicPress: undefined,
        });

        expect(first).toBe(second);
        expect(first.isMicActive).toBe(false);
        expect(first.onMicPress).toBeUndefined();
    });

    it('keeps the same state object while updating the latest mic press handler', () => {
        const firstHandler = vi.fn();
        const secondHandler = vi.fn();

        const first = resolveSessionViewMicButtonState({
            voiceProviderId: 'openai',
            voiceStatus: 'connected',
            onMicPress: firstHandler,
        });
        const second = resolveSessionViewMicButtonState({
            voiceProviderId: 'openai',
            voiceStatus: 'connected',
            onMicPress: secondHandler,
        });

        expect(first).toBe(second);
        expect(second.onMicPress).toBe(secondHandler);
        second.onMicPress?.();
        expect(secondHandler).toHaveBeenCalledTimes(1);
        expect(firstHandler).not.toHaveBeenCalled();
        expect(second.isMicActive).toBe(true);
    });
});
