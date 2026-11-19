import { describe, expect, it, vi } from 'vitest';

const getPowerState = vi.hoisted(() => vi.fn());
vi.mock('react-native-device-info', () => ({ getPowerState }));

describe('native glyph power policy', () => {
    it('uses the same native power read for simultaneous glyph surfaces', async () => {
        getPowerState.mockResolvedValue({ lowPowerMode: true });
        const { readGlyphLowPower } = await import('./readGlyphLowPower.native');
        await expect(Promise.all([readGlyphLowPower(), readGlyphLowPower()])).resolves.toEqual([true, true]);
        expect(getPowerState).toHaveBeenCalledTimes(1);
    });
});
