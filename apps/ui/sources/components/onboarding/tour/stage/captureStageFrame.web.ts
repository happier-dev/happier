import type { View } from 'react-native';
import viewShotWeb from 'react-native-view-shot/src/RNViewShot.web';

import type { StageFrozenCapture } from './stageFrozenCapture';
import { decodeStageFrameImage } from './prepareStageFrameImage.web';

export type { StageFrozenCapture } from './stageFrozenCapture';

async function waitForStageFrameReady(node: HTMLElement): Promise<void> {
    const images = Array.from(node.querySelectorAll<HTMLImageElement>('img'));
    await Promise.all(images.map(async (image) => {
        if (image.complete && image.naturalWidth > 0) return;
        await image.decode();
    }));
    await document.fonts?.ready;
    await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
}

export async function captureStageFrame(node: View | null, testID: string): Promise<StageFrozenCapture> {
    const webNode = (node as unknown as HTMLElement | null)
        ?? document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
    if (!webNode) throw new Error('Stage freeze web capture source is unavailable.');
    await waitForStageFrameReady(webNode);
    const uri = await viewShotWeb.captureRef(webNode, {
        format: 'png',
        quality: 1,
        result: 'data-uri',
    });
    await decodeStageFrameImage(uri);
    return { kind: 'image', uri };
}

export function releaseStageFrame(_capture: StageFrozenCapture): void {
    // Web data URIs are reclaimed when the owning React state/ref is dropped.
}
