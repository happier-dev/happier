import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';

import { selectionListTestId } from './_shared';
import type { SelectionListPagination } from './_types';

const styles = StyleSheet.create((theme) => ({
    status: {
        minHeight: 52,
        paddingHorizontal: 16,
        paddingVertical: 12,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8,
    },
    statusText: {
        color: theme.colors.text.secondary,
    },
    error: {
        paddingTop: 8,
    },
    errorText: {
        color: theme.colors.text.secondary,
        paddingHorizontal: 16,
        paddingBottom: 4,
    },
}));

export function SelectionListPaginationFooter(props: Readonly<{
    pagination: SelectionListPagination;
    rootTestID?: string;
    measureMode?: boolean;
    onRetry: () => void;
}>): React.ReactElement | null {
    const measureMode = props.measureMode === true;
    const identityProps = measureMode
        ? {
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
            pointerEvents: 'none' as const,
            'aria-hidden': true,
        }
        : null;

    if (props.pagination.loadingMore) {
        return (
            <View
                testID={measureMode ? undefined : selectionListTestId(props.rootTestID, 'pagination', 'loading')}
                style={styles.status}
                accessibilityRole={measureMode ? undefined : 'text'}
                accessibilityLabel={measureMode ? undefined : props.pagination.loadingLabel}
                accessibilityLiveRegion={measureMode ? undefined : 'polite'}
                {...(measureMode ? {} : ({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>))}
                {...(identityProps ?? {})}
            >
                <ActivitySpinner size="small" />
                <Text style={styles.statusText}>{props.pagination.loadingLabel}</Text>
            </View>
        );
    }

    if (props.pagination.error) {
        return (
            <View
                testID={measureMode ? undefined : selectionListTestId(props.rootTestID, 'pagination', 'error')}
                style={styles.error}
                accessibilityRole={measureMode ? undefined : 'alert'}
                accessibilityLiveRegion={measureMode ? undefined : 'polite'}
                {...(measureMode ? {} : ({ role: 'alert', 'aria-live': 'polite' } as Record<string, unknown>))}
                {...(identityProps ?? {})}
            >
                <Text style={styles.errorText}>{props.pagination.error}</Text>
                {props.pagination.onRetry ? (
                    <Item
                        testID={measureMode ? undefined : selectionListTestId(props.rootTestID, 'pagination', 'retry')}
                        title={props.pagination.retryLabel}
                        onPress={props.onRetry}
                        accessibilityLabel={props.pagination.retryLabel}
                    />
                ) : null}
            </View>
        );
    }

    if (props.pagination.hasMore) return null;

    return (
        <View
            testID={measureMode ? undefined : selectionListTestId(props.rootTestID, 'pagination', 'end')}
            style={styles.status}
            accessibilityRole={measureMode ? undefined : 'text'}
            accessibilityLiveRegion={measureMode ? undefined : 'polite'}
            {...(measureMode ? {} : ({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>))}
            {...(identityProps ?? {})}
        >
            <Text style={styles.statusText}>{props.pagination.endReachedLabel}</Text>
        </View>
    );
}
