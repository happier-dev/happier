import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { PET_ANIMATION_ROWS_V1 } from '@happier-dev/protocol/pets/constants';
import { PET_IDLE_DURATION_MULTIPLIER } from '@/components/pets/animation/petAnimationPlaybackConfig';
import { usePetAnimatedFrame } from './usePetAnimatedFrame';
import { PetSprite } from './PetSprite';

afterEach(() => { standardCleanup(); vi.useRealTimers(); });

it.each([1, 10, 50])('measures frame renders for %i mounted sprites over an idle loop', async count => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let renders = 0;
    function Sprite() {
        renders += 1;
        const frame = usePetAnimatedFrame({ state: 'idle', reducedMotion: false });
        return <PetSprite frame={frame} />;
    }
    const screen = await renderScreen(<>{Array.from({ length: count }, (_, index) => <Sprite key={index} />)}</>);
    const atMount = renders;
    const idle = PET_ANIMATION_ROWS_V1.find(row => row.state === 'idle');
    if (!idle) throw new Error('Missing idle animation');
    const durationMs = idle.durationsMs.reduce((sum, duration) => sum + duration, 0) * PET_IDLE_DURATION_MULTIPLIER;
    for (let elapsed = 0; elapsed < durationMs; elapsed += 10) {
        await act(async () => { vi.advanceTimersByTime(Math.min(10, durationMs - elapsed)); });
    }
    console.info('PET-LOGIC-AUDIT animation', { count, durationMs, renders: renders - atMount,
        rendersPerSecond: (renders - atMount) * 1000 / durationMs });
    expect(renders - atMount).toBe(count * idle.frames);
    await screen.unmount();
});
