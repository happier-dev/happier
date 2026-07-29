import * as React from 'react';
import { Platform } from 'react-native';

import { FlatListBackend } from './backends/flatListBackend';
import { LegendListBackend } from './backends/legendListBackend';
import { resolveVirtualizedListBackend } from './resolveVirtualizedListBackend';
import type {
    VirtualizedListProps,
    VirtualizedListRef,
} from './virtualizedListTypes';

/**
 * Canonical Happier virtualized list. Product surfaces import this and express
 * a {@link VirtualizedListProps.backendPreference}; the abstraction owns which
 * list runtime (Legend or an explicit FlatList escape hatch) satisfies it, so call sites never
 * branch on `Platform.OS` or a specific library. The imperative handle is the
 * stable {@link VirtualizedListRef} regardless of the resolved backend.
 */
function VirtualizedListInner<T>(
    props: VirtualizedListProps<T>,
    ref: React.ForwardedRef<VirtualizedListRef>,
): React.ReactElement {
    const backend = resolveVirtualizedListBackend({
        preference: props.backendPreference,
        platformOS: Platform.OS,
    });

    if (backend === 'legend') {
        return <LegendListBackend {...props} ref={ref} />;
    }
    return <FlatListBackend {...props} ref={ref} />;
}

export const VirtualizedList = React.forwardRef(VirtualizedListInner) as <T>(
    props: VirtualizedListProps<T> & { ref?: React.Ref<VirtualizedListRef> },
) => React.ReactElement;
