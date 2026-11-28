import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';

import { KEYBOARD_COMMAND_GROUP_TITLE_KEYS } from '@/components/settings/keyboard/keyboardSettings';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import { splitKeybindingLabel } from '../shortcutLabels';
import { resolveKeyboardCommands } from '../commands';
import { usePluginKeyboardCommands } from '../usePluginKeyboardCommands';
import type { KeyboardPlatform, KeyboardWebHost, KeybindingRule } from '../types';
import { buildShortcutsSheetModel } from './shortcutsSheetModel';

export type ShortcutsSheetProps = CustomModalInjectedProps & Readonly<{
    platform: KeyboardPlatform;
    host: KeyboardWebHost;
    singleKeyShortcutsEnabled: boolean;
    disabledCommandIds: readonly string[];
    overrides: Readonly<Record<string, readonly KeybindingRule[]>>;
}>;

/** Two columns of groups from this width of sheet body; one column below it. */
const TWO_COLUMN_MIN_WIDTH_PX = 640;

/**
 * The `?` sheet (lab ade-shell KB1): every bound command, grouped by the area it acts on, with the
 * keys as this device would press them. In a browser the segment shows the desktop app's keys too
 * (several chords differ where the browser owns them). Built from the command table and binding
 * policy Settings → Keyboard uses, so the two never disagree.
 */
export function ShortcutsSheet(props: ShortcutsSheetProps) {
    const router = useRouter();
    const [host, setHost] = React.useState<KeyboardWebHost>(props.host);
    const [bodyWidthPx, setBodyWidthPx] = React.useState<number | null>(null);
    const pluginCommands = usePluginKeyboardCommands();
    const commands = React.useMemo(() => resolveKeyboardCommands(props.overrides, pluginCommands), [props.overrides, pluginCommands]);
    const model = React.useMemo(() => buildShortcutsSheetModel({
        commands,
        platform: props.platform,
        host,
        singleKeyShortcutsEnabled: props.singleKeyShortcutsEnabled,
        disabledCommandIds: props.disabledCommandIds,
        overrides: props.overrides,
    }), [host, props.disabledCommandIds, props.overrides, props.platform, props.singleKeyShortcutsEnabled, commands]);
    const groups = React.useMemo(() => model.groups
        .map(group => ({ ...group, rows: group.rows.filter(row => row.label) }))
        .filter(group => group.rows.length > 0), [model.groups]);
    const twoColumns = bodyWidthPx !== null && bodyWidthPx >= TWO_COLUMN_MIN_WIDTH_PX;
    const columns = React.useMemo(() => {
        if (!twoColumns) return [groups];
        // Balance the two columns by row count, keeping the groups' order down each column.
        const total = groups.reduce((sum, group) => sum + group.rows.length + 2, 0);
        const left: typeof groups = [];
        const right: typeof groups = [];
        let leftCount = 0;
        for (const group of groups) {
            if (leftCount < total / 2) { left.push(group); leftCount += group.rows.length + 2; } else right.push(group);
        }
        return [left, right];
    }, [groups, twoColumns]);
    const onBodyLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setBodyWidthPx(current => current === next ? current : next);
    }, []);
    const openSettings = React.useCallback(() => {
        props.onClose();
        router.push('/settings/keyboard');
    }, [props, router]);

    return (
        <ModalCardFrame
            testID="shortcuts-sheet"
            title={t('commandPalette.shortcutsHelpTitle')}
            onClose={props.onClose}
            size="lg"
            scrollHost="bounded"
            bodyScroll="auto"
            actions={Platform.OS === 'web' ? (
                <SegmentedTabBar
                    testIDPrefix="shortcuts-sheet-host"
                    compact
                    segmentSizing="content"
                    tabs={[
                        { id: 'desktop', label: t('settingsKeyboard.shortcutHostDesktop') },
                        { id: 'browser', label: t('settingsKeyboard.shortcutHostBrowser') },
                    ]}
                    activeTabId={host}
                    onSelectTab={setHost}
                />
            ) : undefined}
            footer={(
                <View style={styles.footer}>
                    <Text style={styles.footerText}>{t('panes.shortcutsSheet.footer')}</Text>
                    <TextLinkButton testID="shortcuts-sheet-settings" label={t('panes.shortcutsSheet.openSettings')} onPress={openSettings} />
                </View>
            )}
        >
            <View style={styles.body} onLayout={onBodyLayout}>
                {groups.length === 0 ? (
                    <Text style={styles.footerText}>{t('commandPalette.shortcutsHelpEmpty')}</Text>
                ) : columns.map((column, columnIndex) => (
                    <View key={columnIndex} style={[styles.column, twoColumns ? styles.columnHalf : null]}>
                        {column.map(group => (
                            <View key={group.id} style={styles.group} testID={`shortcuts-sheet-group-${group.id}`}>
                                <Text accessibilityRole="header" style={styles.groupTitle}>{t(KEYBOARD_COMMAND_GROUP_TITLE_KEYS[group.id])}</Text>
                                {group.rows.map((row, index) => (
                                    <View key={row.commandId} style={[styles.row, index > 0 ? styles.rowDivider : null]} testID={`shortcuts-sheet-row-${row.commandId}`}>
                                        <Text numberOfLines={2} style={styles.rowTitle}>{row.title ?? t(row.titleKey)}</Text>
                                        <View style={styles.keys} accessibilityLabel={row.label}>
                                            {splitKeybindingLabel(row.label ?? '').map((key, keyIndex) => <KeyHint key={`${key}-${keyIndex}`} label={key} />)}
                                        </View>
                                    </View>
                                ))}
                            </View>
                        ))}
                    </View>
                ))}
            </View>
        </ModalCardFrame>
    );
}

const styles = StyleSheet.create((theme) => ({
    body: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s32, paddingHorizontal: theme.space.s16, paddingTop: theme.space.s4, paddingBottom: theme.space.s16 },
    column: { flex: 1, minWidth: 0, gap: theme.space.s20 },
    columnHalf: { flexBasis: 0 },
    group: { gap: theme.space.s2 },
    groupTitle: { ...Typography.variant('heading', 'semiBold'), color: theme.colors.text.primary, marginBottom: theme.space.s4 },
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s12, minHeight: 36, paddingVertical: theme.space.s4 },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.subtle },
    rowTitle: { ...Typography.variant('body'), color: theme.colors.text.primary, flex: 1, minWidth: 0 },
    keys: { flexDirection: 'row', gap: theme.space.s2, flexShrink: 0 },
    footer: { justifyContent: 'space-between', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space.s12, rowGap: theme.space.s4 },
    footerText: { ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 },
}));
