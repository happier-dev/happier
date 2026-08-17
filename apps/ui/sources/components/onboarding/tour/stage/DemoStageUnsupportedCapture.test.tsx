import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import type { StageFrame } from './stageFrames';

// The platform seam reports that this platform cannot rasterize a subtree — the
// real state of web, where html2canvas is the only option and it clones the whole
// document into an iframe it only detaches after a successful render. The stage
// must then perform NO captures at all, rather than firing them every beat and
// relying on the rejection being swallowed by the catch.
const captureSeam = vi.hoisted(() => ({
    captureStageFrame: vi.fn(async () => {
        throw new Error('Stage frame capture is not supported on web; the stage renders its live layer.');
    }),
    releaseStageFrame: vi.fn(),
}));

vi.mock('./captureStageFrame', () => ({
    captureStageFrame: captureSeam.captureStageFrame,
    releaseStageFrame: captureSeam.releaseStageFrame,
    stageFrameCaptureSupported: false,
}));

const { DemoStage } = await import('./DemoStage');

const demoFrames = [
    { id: 'sessions-list.hero', surface: 'sessions-list', device: 'desktop', zoom: 1, dim: 0 },
    { id: 'session-view.hero', surface: 'session-view', device: 'desktop', zoom: 1, dim: 0 },
] as const satisfies readonly StageFrame[];

describe('DemoStage where the capture seam is unsupported', () => {
    afterEach(() => {
        captureSeam.captureStageFrame.mockClear();
        standardCleanup();
    });

    it('never attempts a capture when the stage mounts', async () => {
        renderScreen(
            <DemoStage
                frames={demoFrames}
                activeFrameId="sessions-list.hero"
                reducedMotion={false}
            />,
            { flushOptions: { cycles: 0 } },
        );
        await act(async () => { await Promise.resolve(); });
        expect(captureSeam.captureStageFrame).not.toHaveBeenCalled();
    });

});
