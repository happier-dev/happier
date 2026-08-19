import * as React from 'react';
import { LegendList, type LegendListRef } from '@legendapp/list/react-native';

import type { FlashListPropsCompat, FlashListRef } from './FlashListCompat';
import type { FlashListCompatComponent } from './resolveFlashListRuntime';
import { toLegendListProps } from './toLegendListProps';

/**
 * Legend List behind the shared virtualization surface.
 *
 * Exists so a list can change engine without its call site changing: `SessionsList` and friends keep
 * importing one component and passing one prop shape. The transcript already runs on Legend through
 * its own renderer; this is the same engine reached through the compat seam rather than a second
 * integration of it.
 *
 * The ref is narrowed to the compat contract rather than re-exported: callers of this seam use
 * `scrollToOffset` and `scrollToIndex`, and handing them Legend's full ref would couple them to the
 * engine this seam exists to hide.
 */
export const LegendListCompat = React.forwardRef(function LegendListCompatInner<T>(
    props: FlashListPropsCompat<T>,
    ref: React.ForwardedRef<FlashListRef<T>>,
) {
    const legendRef = React.useRef<LegendListRef | null>(null);

    React.useImperativeHandle(ref, () => ({
        scrollToIndex: (params) => legendRef.current?.scrollToIndex(params),
        scrollToOffset: (params) => legendRef.current?.scrollToOffset(params),
    }), []);

    // The engine is reached through an untyped alias on purpose: the compat surface is the contract
    // callers are checked against, and re-deriving Legend's own prop generics here would leak the
    // engine's types back into every call site this seam exists to keep engine-agnostic.
    const LegendListEngine = LegendList as unknown as React.ComponentType<Record<string, unknown>>;

    return <LegendListEngine ref={legendRef as never} {...toLegendListProps(props)} />;
}) as unknown as FlashListCompatComponent;
