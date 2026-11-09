import * as React from 'react';

import { StoreDiscoverView } from '@/components/store/discover/StoreDiscoverPages';
import { buildDemoStoreCuration } from '@/demoMode/world/store';

const SUGGESTIONS = [] as const;

/** The production Discover page; only its catalog read is supplied by the demo world. */
export function StoreStageSurface(): React.ReactElement {
    const curation = React.useMemo(buildDemoStoreCuration, []);
    return <StoreDiscoverView curation={curation} suggestions={SUGGESTIONS} />;
}
