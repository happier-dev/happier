import type { FlashListPropsCompat } from './FlashListCompat';

/**
 * Translates the shared virtualization surface onto Legend List.
 *
 * Legend accepts every prop this compat surface exposes — `data`, `renderItem`, `keyExtractor`,
 * `extraData`, `getItemType`, `estimatedItemSize`, `drawDistance`, `onStartReached`, `onLoad`,
 * `maintainVisibleContentPosition`, and the whole ScrollView surface it inherits — so this is a
 * pass-through rather than a translation layer. Only four props need handling:
 *
 * - `overrideItemLayout`, `initialScrollIndexParams` and `happierPauseOffsetCorrection` drive
 *   FlashList's own layout pipeline and have no Legend counterpart. Forwarding them would put
 *   unknown props on a ScrollView.
 * - `overrideProps` is the web escape hatch for DOM handlers; it must be spread, because forwarded
 *   by name the handlers would never attach.
 *
 * `recycleItems` is pinned on: FlashList always recycles, Legend can be told not to, and its
 * default is not this seam's to inherit — cell lifecycle is exactly what the migration must hold
 * steady.
 */
export function toLegendListProps<T>(props: FlashListPropsCompat<T>): Record<string, unknown> {
    const {
        overrideItemLayout: _overrideItemLayout,
        initialScrollIndexParams: _initialScrollIndexParams,
        happierPauseOffsetCorrection: _happierPauseOffsetCorrection,
        overrideProps,
        ...forwarded
    } = props;

    return {
        recycleItems: true,
        ...forwarded,
        ...(overrideProps ?? {}),
    };
}
