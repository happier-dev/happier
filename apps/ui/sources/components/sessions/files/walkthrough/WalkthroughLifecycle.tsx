import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { WalkthroughLineCounts, WalkthroughPath } from './WalkthroughAtoms';
import type { WalkthroughInventoryRow, WalkthroughOtherChange } from './walkthroughReading';

/**
 * A notice band at the top of the Walkthrough (lab WT2/WT3): one message, its cause, and its next action.
 * `tone` only colours the glyph; healthy notices (an update with Undo) stay neutral.
 */
export function WalkthroughNotice(props: Readonly<{
    testID?: string;
    tone: 'neutral' | 'warning' | 'danger' | 'offline';
    icon: IconName;
    message: React.ReactNode;
    actions?: React.ReactNode;
    phone?: boolean;
}>) {
    const { theme } = useUnistyles();
    const color = props.tone === 'warning'
        ? theme.colors.state.warning.foreground
        : props.tone === 'danger' ? theme.colors.state.danger.foreground : theme.colors.text.secondary;
    return (
        <View
            testID={props.testID}
            accessibilityRole="alert"
            style={[styles.notice, props.phone ? styles.noticePhone : null, props.tone === 'danger' ? styles.noticeDanger : null]}
        >
            <View style={styles.noticeBody}>
                <Icon name={props.icon} size={ICON_SIZE.sm} color={color} />
                <View style={styles.noticeMessage}>{typeof props.message === 'string' ? <Text style={styles.noticeText}>{props.message}</Text> : props.message}</View>
            </View>
            {props.actions ? <View style={[styles.noticeActions, props.phone ? styles.noticeActionsPhone : null]}>{props.actions}</View> : null}
        </View>
    );
}

export function WalkthroughNoticeLink(props: Readonly<{ label: string; onPress: () => void; testID?: string }>) {
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            onPress={props.onPress}
            style={(state) => [styles.link, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
        >
            <Text style={styles.linkText}>{props.label}</Text>
        </HappierPressable>
    );
}

export function WalkthroughNoticeButton(props: Readonly<{ label: string; onPress: () => void; icon?: IconName; testID?: string }>) {
    const { theme } = useUnistyles();
    return (
        <RoundButton
            testID={props.testID}
            size="small"
            display="secondary"
            title={props.label}
            leading={props.icon ? <Icon name={props.icon} size={ICON_SIZE.xs} color={theme.colors.text.primary} /> : undefined}
            onPress={props.onPress}
        />
    );
}

/** Before a word is written: every file in the comparison, its counts, and what the model has read (lab WT2-1). */
export const WalkthroughInventory = React.memo(function WalkthroughInventory(props: Readonly<{
    rows: readonly WalkthroughInventoryRow[];
    phone?: boolean;
    onOpenFile?: (path: string) => void;
}>) {
    const { theme } = useUnistyles();
    return (
        <View testID="walkthrough-inventory" style={[styles.inventory, props.phone ? styles.inventoryPhone : null]}>
            <Text style={styles.inventoryTitle}>{t('walkthrough.inventory.title')}</Text>
            {props.rows.map((row) => (
                <HappierPressable
                    key={row.path}
                    testID={`walkthrough-inventory-${row.path}`}
                    accessibilityRole="link"
                    accessibilityLabel={row.path}
                    onPress={() => props.onOpenFile?.(row.path)}
                    style={(state) => [styles.inventoryRow, state.pressed ? styles.pressed : null]}
                >
                    <Text style={styles.changeLetter}>{row.changeKind === 'added' ? 'A' : row.changeKind === 'deleted' ? 'D' : 'M'}</Text>
                    <WalkthroughPath path={row.path} />
                    <View style={styles.grow} />
                    {row.lockfile ? <Text style={styles.tag}>{t('scmComparison.lockfileTag')}</Text> : row.generated ? <Text style={styles.tag}>{t('scmComparison.generatedTag')}</Text> : (
                        <View style={styles.readState}>
                            <Icon
                                name={row.reading === 'read' ? 'check' : row.reading === 'unavailable' ? 'lock' : 'circle'}
                                size={12}
                                color={row.reading === 'read' ? theme.colors.state.success.foreground : theme.colors.text.tertiary}
                            />
                            <Text style={styles.readStateText}>{row.reading === 'read' ? t('walkthrough.inventory.read') : row.reading === 'unavailable' ? t('walkthrough.inventory.unavailable') : t('walkthrough.inventory.reading')}</Text>
                        </View>
                    )}
                    <View style={styles.countsSlot}><WalkthroughLineCounts added={row.added} removed={row.removed} /></View>
                </HappierPressable>
            ))}
        </View>
    );
});

function otherWhy(other: WalkthroughOtherChange): string | null {
    if (other.unavailableReason && other.unavailableReason !== 'binary') return t('walkthrough.evidence.unavailable', { reason: other.unavailableReason });
    if (other.binary) return t('walkthrough.evidence.binary');
    return null;
}

/** The tail of the story: everything no stop explains, still one press from its diff (lab WT1-A). */
export const WalkthroughOtherChanges = React.memo(function WalkthroughOtherChanges(props: Readonly<{
    others: readonly WalkthroughOtherChange[];
    phone?: boolean;
    onOpenFile?: (path: string) => void;
}>) {
    const { theme } = useUnistyles();
    if (props.others.length === 0) return null;
    return (
        <View testID="walkthrough-other-changes" style={[styles.others, props.phone ? styles.othersPhone : null]}>
            <Text accessibilityRole="header" style={styles.othersTitle}>
                {t('walkthrough.otherChanges')}
                <Text style={styles.othersCount}>{`  ${props.others.length}`}</Text>
            </Text>
            <Text style={styles.othersDescription}>{t('walkthrough.otherChangesDescription')}</Text>
            {props.others.map((other, index) => {
                const why = otherWhy(other);
                return (
                    <HappierPressable
                        key={other.path}
                        testID={`walkthrough-other-${other.path}`}
                        accessibilityRole="link"
                        accessibilityLabel={t('walkthrough.openInFiles', { file: other.path })}
                        onPress={() => props.onOpenFile?.(other.path)}
                        style={(state) => [styles.otherRow, index > 0 ? styles.otherRowDivided : null, state.pressed ? styles.pressed : null]}
                    >
                        <Icon name="caret-right" size={13} color={theme.colors.text.tertiary} />
                        <WalkthroughPath path={other.path} />
                        <View style={styles.grow}>{why ? <Text style={styles.why} numberOfLines={1}>{why}</Text> : null}</View>
                        {other.lockfile ? <Text style={styles.tag}>{t('scmComparison.lockfileTag')}</Text> : other.generated ? <Text style={styles.tag}>{t('scmComparison.generatedTag')}</Text> : null}
                        <WalkthroughLineCounts added={other.added} removed={other.removed} />
                    </HappierPressable>
                );
            })}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    notice: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 44,
        paddingHorizontal: 20,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface.inset,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.default,
    },
    noticePhone: { flexDirection: 'column', alignItems: 'stretch' },
    noticeBody: { flexDirection: 'row', alignItems: 'center', gap: 10, flexGrow: 1, flexShrink: 1, minWidth: 0 },
    noticeDanger: { backgroundColor: theme.colors.state.danger.background },
    noticeMessage: { flex: 1, minWidth: 0 },
    noticeText: { fontSize: 13, lineHeight: 19, color: theme.colors.text.primary, ...Typography.default() },
    noticeActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    noticeActionsPhone: { alignSelf: 'flex-end' },
    link: { paddingVertical: 4, paddingHorizontal: 2 },
    linkText: { fontSize: 13, color: theme.colors.text.primary, textDecorationLine: 'underline', ...Typography.default('semiBold') },
    inventory: { paddingTop: 18 },
    inventoryPhone: { paddingHorizontal: 16 },
    inventoryTitle: { fontSize: 12.5, color: theme.colors.text.secondary, marginBottom: 6, ...Typography.default('medium') },
    inventoryRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 34, borderRadius: 6, paddingHorizontal: 4 },
    changeLetter: { width: 12, fontSize: 11, color: theme.colors.text.tertiary, ...Typography.mono('semiBold') },
    grow: { flex: 1, minWidth: 0 },
    readState: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 82 },
    readStateText: { fontSize: 12.5, color: theme.colors.text.tertiary, ...Typography.default() },
    countsSlot: { minWidth: 56, alignItems: 'flex-end' },
    tag: {
        fontSize: 11.5,
        color: theme.colors.text.secondary,
        backgroundColor: theme.colors.surface.inset,
        borderRadius: 5,
        paddingHorizontal: 6,
        paddingVertical: 2,
        overflow: 'hidden',
        ...Typography.default('medium'),
    },
    pressed: { backgroundColor: theme.colors.surface.pressed },
    others: {
        marginTop: 22,
        paddingTop: 22,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    othersPhone: { marginHorizontal: 16 },
    othersTitle: { fontSize: 15, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    othersCount: { color: theme.colors.text.tertiary, ...Typography.default('medium') },
    othersDescription: { marginTop: 4, marginBottom: 10, fontSize: 13, color: theme.colors.text.secondary, ...Typography.default() },
    otherRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, paddingHorizontal: 12 },
    otherRowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    why: { fontSize: 12.5, color: theme.colors.text.tertiary, ...Typography.default() },
}));
