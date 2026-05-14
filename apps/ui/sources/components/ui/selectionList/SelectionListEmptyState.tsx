import * as React from 'react';
import { View, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        paddingHorizontal: 24,
        paddingVertical: 36,
        alignItems: 'center',
        justifyContent: 'center',
    },
    label: {
        fontSize: Platform.select({ ios: 14, default: 13 }),
        lineHeight: Platform.select({ ios: 18, default: 17 }),
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
}));

export type SelectionListEmptyStateProps = Readonly<{
    label?: string;
    testID?: string;
}>;

/**
 * Empty state shown when the current step has no visible options (after
 * filtering). Keep it deliberately plain — the surrounding chrome (header,
 * footer) is the structure the user reads first; the empty state is just a
 * confirmation that the search produced nothing.
 *
 * NOTE on copy: callers may pass an already-translated `label`. When omitted
 * we fall back to the canonical `selectionList.emptyMatch` translation so the
 * primitive surface never leaks an English fallback into non-English locales.
 */
export function SelectionListEmptyState(props: SelectionListEmptyStateProps): React.ReactElement {
    const styles = stylesheet;
    return (
        <View testID={props.testID} style={styles.container}>
            <Text style={styles.label}>{props.label ?? t('selectionList.emptyMatch')}</Text>
        </View>
    );
}
