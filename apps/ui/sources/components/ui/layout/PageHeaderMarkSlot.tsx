import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { Icon, type IconName } from '@/components/ui/icons/Icon';

/** The slot's square side: a page header's mark, and a row's. */
export const PAGE_HEADER_MARK_SLOT_SIZE_PX = Object.freeze({ page: HAPPIER_PAGE_METRICS.pageHeaderMarkSlotPx, row: 36 } as const);

/** Bare entity artwork, with stable page/row space and no backing or clipping. */
export function PageHeaderMarkSlot(props: Readonly<{
    children: React.ReactNode;
    testID?: string;
    size?: 'page' | 'row';
}>) {
    return (
        <View testID={props.testID} style={[stylesheet.markSlot, props.size === 'row' ? stylesheet.markSlotRow : null]}>
            {props.children}
        </View>
    );
}

/** A page header's glyph mark: the owner's glyph in the owner's slot, in secondary ink. A page never sizes it. */
export function PageHeaderMarkIcon(props: Readonly<{ name: IconName; color?: string; testID?: string }>) {
    const { theme } = useUnistyles();
    return (
        <PageHeaderMarkSlot testID={props.testID}>
            <Icon name={props.name} size={HAPPIER_PAGE_METRICS.pageHeaderMarkGlyphPx} color={props.color ?? theme.colors.text.secondary} />
        </PageHeaderMarkSlot>
    );
}

const stylesheet = StyleSheet.create({
    markSlot: {
        width: PAGE_HEADER_MARK_SLOT_SIZE_PX.page,
        height: PAGE_HEADER_MARK_SLOT_SIZE_PX.page,
        alignItems: 'center',
        justifyContent: 'center',
    },
    markSlotRow: {
        width: PAGE_HEADER_MARK_SLOT_SIZE_PX.row,
        height: PAGE_HEADER_MARK_SLOT_SIZE_PX.row,
    },
});
