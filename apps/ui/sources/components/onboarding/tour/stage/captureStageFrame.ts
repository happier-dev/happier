import type { View } from 'react-native';
import { captureRef, releaseCapture } from 'react-native-view-shot';

import type { StageFrozenCapture } from './stageFrozenCapture';

export type { StageFrozenCapture } from './stageFrozenCapture';

export async function captureStageFrame(node: View | null, _testID: string): Promise<StageFrozenCapture> {
    if (!node) throw new Error('Stage freeze native capture source is unavailable.');
    const uri = await captureRef(node, {
        format: 'png',
        quality: 1,
        result: 'tmpfile',
    });
    return { kind: 'image', uri };
}

export function releaseStageFrame(capture: StageFrozenCapture): void {
    if (capture.kind === 'image') releaseCapture(capture.uri);
}
