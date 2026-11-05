import { act } from 'react';

import { findFirstHostNodeByTestId } from './popoverHarness';

type LayoutTree = Parameters<typeof findFirstHostNodeByTestId>[0];

/**
 * Report the layout event Test Renderer cannot produce: a Collection grid draws no card until its stage is measured,
 * because its columns follow the measured width. A missing stage throws, so a test cannot pass over absent cards.
 */
export async function reportCollectionLayout(tree: LayoutTree, collectionTestID: string,
    size: Readonly<{ width: number; height: number }> = { width: 900, height: 800 }): Promise<void> {
    const stage = findFirstHostNodeByTestId(tree, `${collectionTestID}:stage`);
    if (stage === null) throw new Error(`No measured stage for Collection "${collectionTestID}"`);
    await act(async () => { stage.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...size } } }); });
}
