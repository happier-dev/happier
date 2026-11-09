import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';

import {
    describeSessionTerminalStatus,
    type SessionTerminalDescriptor,
    type SessionTerminalTabDescriptor,
} from '../presentation/describeSessionTerminal';
import { renderSessionTerminalMark, SESSION_TERMINAL_STATUS_TONE } from './sessionTerminalMenus';
import { resolveDocumentTabStatusDot } from '@/components/ui/navigation/DocumentTabStrip';

/** Terminal lab B3: the list view's column, and the pane width under which the window falls back to tabs. */
export const SESSION_TERMINAL_LIST_METRICS = Object.freeze({
    widthPx: 220,
    minimumPaneWidthPx: 560,
    rowMinHeightPx: 40,
    nestedIndentPx: 26,
});
const L = SESSION_TERMINAL_LIST_METRICS;

/**
 * The list view: the same terminals as the strip, with a second line that says what each is doing
 * ("Needs you", "localhost:5173", "~/ · devbox"). Splits read as a group with their halves under it.
 */
export const SessionTerminalList = React.memo(function SessionTerminalList(props: Readonly<{
    tabs: readonly SessionTerminalTabDescriptor[];
    activeTabId: string | null;
    focusedTerminalId: string | null;
    onActivateTab: (tabId: string) => void;
    onFocusTerminal: (terminalId: string) => void;
    onTabMenu: (tabId: string, event: unknown) => void;
    /** One sentence above the rows when the list stands in for the terminal and needs saying why. */
    note?: string;
    testIdPrefix?: string;
}>) {
    const styles = stylesheet;
    const testId = (suffix: string) => `${props.testIdPrefix ?? 'terminal-list'}-${suffix}`;
    return (
        <ScrollView
            testID={testId('root')}
            style={styles.column}
            contentContainerStyle={styles.content}
            accessibilityRole="list"
            accessibilityLabel={t('terminalWorkspace.stripA11y')}
        >
            {props.note ? <Text testID={testId('note')} style={styles.note}>{props.note}</Text> : null}
            {props.tabs.map((tab) => tab.members.length === 1 ? (
                <SessionTerminalListRow
                    key={tab.tabId}
                    descriptor={tab.members[0]!}
                    selected={tab.tabId === props.activeTabId}
                    nested={false}
                    onPress={() => props.onActivateTab(tab.tabId)}
                    onMenu={(event) => props.onTabMenu(tab.tabId, event)}
                    testID={testId(`row-${toTestIdSafeValue(tab.tabId)}`)}
                />
            ) : (
                <View key={tab.tabId} accessibilityRole="none">
                    <View style={styles.groupHeader}>
                        <SplitGlyph />
                        <Text style={styles.groupLabel}>{t('terminalWorkspace.split')}</Text>
                    </View>
                    {tab.members.map((member) => (
                        <SessionTerminalListRow
                            key={member.terminalId}
                            descriptor={member}
                            selected={tab.tabId === props.activeTabId && member.terminalId === props.focusedTerminalId}
                            nested
                            onPress={() => props.onFocusTerminal(member.terminalId)}
                            onMenu={(event) => props.onTabMenu(tab.tabId, event)}
                            testID={testId(`row-${toTestIdSafeValue(member.terminalId)}`)}
                        />
                    ))}
                </View>
            ))}
        </ScrollView>
    );
});

function SplitGlyph() {
    const { theme } = useUnistyles();
    return <Icon name="square-split-horizontal" size={12} color={theme.colors.text.tertiary} />;
}

const SessionTerminalListRow = React.memo(function SessionTerminalListRow(props: Readonly<{
    descriptor: SessionTerminalDescriptor;
    selected: boolean;
    nested: boolean;
    onPress: () => void;
    onMenu: (event: unknown) => void;
    testID: string;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { descriptor } = props;
    const statusDot = descriptor.status ? resolveDocumentTabStatusDot(theme, SESSION_TERMINAL_STATUS_TONE[descriptor.status]) : null;
    const statusLabel = descriptor.status ? describeSessionTerminalStatus(descriptor.status, descriptor.title) : null;
    const openMenu = (event: unknown) => {
        (event as { preventDefault?: () => void } | null)?.preventDefault?.();
        props.onMenu(event);
    };
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityState={{ selected: props.selected }}
            accessibilityLabel={[descriptor.title, descriptor.detail, statusLabel].filter(Boolean).join(', ')}
            onPress={props.onPress}
            onLongPress={openMenu}
            {...(Platform.OS === 'web' ? { onContextMenu: openMenu } : null)}
            style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
                styles.row,
                props.nested ? styles.rowNested : null,
                props.selected ? styles.rowSelected : hovered ? styles.rowHovered : null,
            ]}
        >
            <View style={styles.mark}>
                {renderSessionTerminalMark(descriptor.mark, M.tabGlyphPx - 1, props.selected ? theme.colors.text.primary : theme.colors.text.secondary)}
            </View>
            <View style={styles.copy}>
                <Text style={[styles.title, props.selected ? styles.titleSelected : null]} numberOfLines={1}>{descriptor.title}</Text>
                {descriptor.detail ? <Text style={styles.detail} numberOfLines={1}>{descriptor.detail}</Text> : null}
            </View>
            <View style={styles.slot}>
                {statusDot ? <StatusDot color={statusDot.color} halo={statusDot.halo} size={6} /> : null}
            </View>
        </Pressable>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    column: {
        width: L.widthPx,
        flexGrow: 0,
        flexShrink: 0,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.default,
    },
    content: {
        padding: 6,
        gap: 2,
    },
    groupHeader: {
        height: 22,
        paddingTop: 6,
        paddingHorizontal: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    note: {
        ...M.tabSubtitle,
        color: theme.colors.text.secondary,
        ...Typography.default(),
        paddingHorizontal: 8,
        paddingTop: 4,
        paddingBottom: 8,
    },
    groupLabel: {
        ...M.tabSubtitle,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
    },
    row: {
        minHeight: L.rowMinHeightPx,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingLeft: 8,
        paddingRight: 6,
        paddingVertical: 4,
        borderRadius: M.tabRadiusPx - 1,
    },
    rowNested: {
        paddingLeft: L.nestedIndentPx,
    },
    rowSelected: {
        backgroundColor: theme.colors.surface.selected,
    },
    rowHovered: {
        backgroundColor: theme.colors.surface.inset,
    },
    mark: {
        width: M.tabGlyphPx,
        height: M.tabGlyphPx,
        alignItems: 'center',
        justifyContent: 'center',
    },
    copy: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...M.tabLabel,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    titleSelected: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    detail: {
        ...M.tabSubtitle,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
        fontVariant: ['tabular-nums'],
    },
    slot: {
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
