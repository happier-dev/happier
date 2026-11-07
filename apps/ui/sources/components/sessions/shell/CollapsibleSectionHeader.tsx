import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Eyebrow } from '@/components/ui/text/Eyebrow';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { isSessionListPrimaryHeaderKind } from './sessionListPrimaryHeader';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    headerSection: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 14,
    },
    headerText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    groupHeaderSection: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 10,
        paddingBottom: 5,
    },
    groupHeaderTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    headerRow: {
        minHeight: 28,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
        gap: 8,
    },
    headerLabelRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        minWidth: 0,
        flexShrink: 1,
    },
    headerChevron: {
        marginLeft: 6,
        width: 14,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
    webHoverHiddenChevron: {
        opacity: 0,
    },
    webHoverVisibleChevron: {
        opacity: 1,
    },
}));

export const CollapsibleSectionHeader = React.memo(function CollapsibleSectionHeader(props: Readonly<{
    title: string;
    headerKind?: Extract<SessionListViewItem, { type: 'header' }>['headerKind'];
    collapsed: boolean;
    onPress: () => void;
    headerTestId: string;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    const [isHovered, setIsHovered] = React.useState(false);
    const headerChevronColor = theme.colors.text.secondary;
    const isPrimaryHeader = isSessionListPrimaryHeaderKind(props.headerKind);
    const showChevron = !isWeb || props.collapsed || isHovered;
    return (
        <Pressable
            style={isPrimaryHeader ? styles.headerSection : styles.groupHeaderSection}
            onPress={props.onPress}
            testID={props.headerTestId}
            onHoverIn={isWeb ? () => setIsHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsHovered(false) : undefined}
        >
            <View style={styles.headerRow}>
                <View style={styles.headerLabelRow}>
                    <Eyebrow style={isPrimaryHeader ? styles.headerText : styles.groupHeaderTitle}>{props.title}</Eyebrow>
                    <View
                        style={[
                            styles.headerChevron,
                            isWeb && !showChevron ? styles.webHoverHiddenChevron : styles.webHoverVisibleChevron,
                        ]}
                    >
                        <Icon
                            name={props.collapsed ? 'caret-right' : 'caret-down'}
                            size={14}
                            color={headerChevronColor}
                        />
                    </View>
                </View>
            </View>
        </Pressable>
    );
});
