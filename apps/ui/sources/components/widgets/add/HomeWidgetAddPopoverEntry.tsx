import * as React from 'react';

import { retryableLazy } from '@/components/ui/performance/retryableLazy';

import type { HomeWidgetAddPopover } from './HomeWidgetAddPopover';

const LazyHomeWidgetAddPopover = retryableLazy(async () => ({
    default: (await import('./HomeWidgetAddPopover')).HomeWidgetAddPopover,
}));

export function HomeWidgetAddPopoverEntry(props: Omit<React.ComponentProps<typeof HomeWidgetAddPopover>, 'open'>) {
    return (
        <React.Suspense fallback={null}>
            <LazyHomeWidgetAddPopover {...props} open />
        </React.Suspense>
    );
}
