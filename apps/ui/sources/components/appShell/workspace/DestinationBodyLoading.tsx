import * as React from 'react';

import { useLaunchCurtainHold } from '@/boot/launchCurtain';
import { PageLoadingRows } from '@/components/ui/layout/PageLoadingRows';

/**
 * Every lazy destination's Suspense fallback, beside a column too (a blank main area for the seconds a chunk
 * takes reads as broken). It knows nothing about the destination: the page's header room and rows in its column.
 */
export function DestinationBodyLoading() {
    // At launch, the Loading planet stays until the destination has drawn.
    useLaunchCurtainHold(true);
    return <PageLoadingRows testID="workspace-destination-body-loading" header />;
}
