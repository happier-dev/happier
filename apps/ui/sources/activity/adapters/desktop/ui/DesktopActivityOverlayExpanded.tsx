import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { DesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import { Text } from '@/components/ui/text/Text';
import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { t } from '@/text';

import { DesktopActivityOverlaySessionRow } from './DesktopActivityOverlaySessionRow';

export function DesktopActivityOverlayExpanded(props: Readonly<{
    model: DesktopActivityOverlayModel;
    onCollapse: () => void;
    onOpenSession: (sessionId: string) => void;
    onOpenInbox: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <View
            testID="desktop-activity-overlay-expanded"
            style={[
                styles.container,
                {
                    borderColor: theme.colors.divider,
                    backgroundColor: theme.colors.overlay.scrim,
                    ...(createBackdropWebStyle({
                        backgroundColor: theme.colors.overlay.scrim,
                        blurPx: 18,
                    }) as object),
                },
            ]}
        >
            <View style={styles.headerRow}>
                <Text style={[styles.headerTitle, { color: theme.colors.overlay.text }]}>
                    {props.model.expanded.title}
                </Text>
                <Pressable onPress={props.onCollapse} style={styles.headerAction}>
                    <Text style={[styles.headerActionLabel, { color: theme.colors.button.primary.tint }]}>
                        {t('common.close')}
                    </Text>
                </Pressable>
            </View>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                {props.model.expanded.rows.map((row) => (
                    <DesktopActivityOverlaySessionRow
                        key={row.sessionId}
                        title={row.title}
                        subtitle={row.subtitle}
                        statusText={row.statusText}
                        onPress={() => props.onOpenSession(row.sessionId)}
                    />
                ))}
                {props.model.expanded.rows.length === 0 ? (
                    <Text style={[styles.emptyText, { color: theme.colors.overlay.textSecondary }]}>
                        {props.model.collapsed.title}
                    </Text>
                ) : null}
            </ScrollView>
            <Pressable onPress={props.onOpenInbox} style={styles.footerAction}>
                <Text style={[styles.footerLabel, { color: theme.colors.button.primary.tint }]}>
                    {`${t('common.open')} ${t('tabs.inbox')}`}
                </Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 18,
        padding: 12,
        gap: 10,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    headerTitle: {
        fontSize: 14,
        fontWeight: '700',
    },
    headerAction: {
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 8,
    },
    headerActionLabel: {
        fontSize: 12,
        fontWeight: '600',
    },
    scroll: {
        maxHeight: 340,
    },
    scrollContent: {
        gap: 8,
    },
    emptyText: {
        fontSize: 12,
        textAlign: 'center',
        paddingVertical: 14,
    },
    footerAction: {
        alignSelf: 'flex-start',
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 8,
    },
    footerLabel: {
        fontSize: 12,
        fontWeight: '700',
    },
});
