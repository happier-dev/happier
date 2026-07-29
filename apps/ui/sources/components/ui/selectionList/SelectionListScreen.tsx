import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

import { SelectionList } from './SelectionList';
import type { SelectionListProps } from './_types';

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
}));

export function resolveSelectionListScreenHeight(input: Readonly<{
    viewportHeight: number;
    topInset: number;
    bottomInset: number;
}>): number {
    return Math.max(0, input.viewportHeight - input.topInset - input.bottomInset);
}

export type SelectionListScreenProps = Omit<SelectionListProps,
    'maxHeight' | 'heightBehavior' | 'showsVerticalScrollIndicator'> & Readonly<{
    /** Test-only deterministic viewport override; production uses the live window. */
    viewportHeight?: number;
}>;

/**
 * Full-route host for SelectionList. SelectionList remains the sole scroll,
 * filtering, focus, and virtualization owner; this wrapper only supplies a
 * safe-area-aware viewport and route-close callback.
 */
export function SelectionListScreen(props: SelectionListScreenProps): React.ReactElement {
    const window = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const { viewportHeight, testID = 'selection-list-screen', ...listProps } = props;
    const maxHeight = resolveSelectionListScreenHeight({
        viewportHeight: viewportHeight ?? window.height,
        topInset: insets.top,
        bottomInset: insets.bottom,
    });

    return (
        <View testID={testID} style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
            <SelectionList
                {...listProps}
                testID={`${testID}.list`}
                maxHeight={maxHeight}
                heightBehavior="fixedToMaxHeight"
                showsVerticalScrollIndicator
            />
        </View>
    );
}
