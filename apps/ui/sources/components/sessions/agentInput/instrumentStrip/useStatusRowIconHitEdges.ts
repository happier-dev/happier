import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

/**
 * The status row's quiet icons (a new session's Look, Start another and close, the keyboard's accessory): the
 * row sits just above the card, so their hit areas split the row's one gap (`trailingActions`) sideways and never
 * reach down into the card's own controls.
 */
export function useStatusRowIconHitEdges() {
    const { theme } = useUnistyles();
    const half = theme.space.s10 / 2;
    return React.useMemo(() => ({ leading: half, trailing: half, bottom: 0 }), [half]);
}
