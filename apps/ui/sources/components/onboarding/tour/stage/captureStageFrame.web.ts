import type { View } from 'react-native';

import type { StageFrozenCapture } from './stageFrozenCapture';

export type { StageFrozenCapture } from './stageFrozenCapture';

/**
 * The web platform has no cheap primitive for rasterizing a DOM subtree.
 *
 * The only one available here was `react-native-view-shot`'s web shim, which is
 * `html2canvas(node, {})`. That is the wrong tool for a freeze frame:
 *
 * - it clones the ENTIRE `<html>`, not the node it is given
 *   (`html2canvas.js:5213`), into a full-viewport iframe that is appended to
 *   `document.body` BEFORE any await (`createIFrameContainer`);
 * - it then awaits an interval poll on the clone's `readyState`, plus
 *   `fonts.ready`, plus `imagesReady` — and `DocumentCloner.destroy` is only
 *   reachable after a successful render, with no `try/finally`. A clone that
 *   never settles therefore leaves a complete copy of the document attached to
 *   the page permanently, along with an uncleared 50ms interval;
 * - it rasterizes at `devicePixelRatio`, so the cost quadruples on a 2x display.
 *
 * Measured on the onboarding journey stage, the clone started and never
 * completed: `toDataURL` was never reached across three beats, no capture ever
 * succeeded, and the leaked `iframe.html2canvas-container` stayed attached. The
 * stranded promise also meant the caller's `finally` never ran, so the capture
 * seam wedged permanently after the first stage beat.
 *
 * Freezing is unnecessary on web regardless: the stage camera animates a CSS
 * transform on a promoted layer, which the compositor handles without repainting
 * the subtree. `useStageWebCamera` already treats `freezeDuringMotion: false` as
 * a supported mode and keeps the live layer visible throughout.
 *
 * Native keeps its capture: `captureStageFrame.ts` uses the platform's real
 * snapshot API, which is a genuine system boundary and cheap.
 */
export const stageFrameCaptureSupported = false;

export async function captureStageFrame(_node: View | null, _testID: string): Promise<StageFrozenCapture> {
    throw new Error('Stage frame capture is not supported on web; the stage renders its live layer.');
}

export function releaseStageFrame(_capture: StageFrozenCapture): void {
    // Nothing is captured on web, so there is nothing to reclaim.
}
