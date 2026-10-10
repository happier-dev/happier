import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { ITEM_ICON_GLYPH_SIZE } from '@/components/ui/lists/itemDensityMetrics';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { t } from '@/text';
import {
    SHARE_ACCESS_LEVEL_ORDER,
    type ShareAccessLevel,
    type ShareGrantRowModel,
    type ShareSheetActions,
    type ShareSheetAdapter,
    type ShareSheetSectionContext,
} from './shareSheetTypes';

const styles = StyleSheet.create((theme) => ({
    controls: { gap: 8 },
    choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    action: { minHeight: resolveMinimumInteractiveTargetSize(Platform.OS), justifyContent: 'center', paddingHorizontal: 8 },
    text: { color: theme.colors.text.primary },
    secondary: { color: theme.colors.text.secondary },
    selected: { color: theme.colors.text.link },
    inline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
    actionContent: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    trailingAction: { paddingRight: 0 },
}));

/** Levels in the one sheet order, whatever order the adapter's controller produced them in. */
export function orderShareAccessLevels(levels: readonly ShareAccessLevel[]): readonly ShareAccessLevel[] {
    return SHARE_ACCESS_LEVEL_ORDER.filter((level) => levels.includes(level));
}

/** The sheet's one quiet text action (level choice, remove, retry, explain). */
export function ShareRowAction(props: Readonly<{
    label: string; testID: string; onPress(): void; disabled?: boolean; selected?: boolean; accessibilityLabel?: string;
    trailing?: React.ReactNode;
}>): React.ReactElement {
    return <Pressable testID={props.testID} accessibilityRole="button" accessibilityLabel={props.accessibilityLabel ?? props.label}
        accessibilityState={{ disabled: props.disabled === true, ...(props.selected === undefined ? {} : { selected: props.selected }) }}
        disabled={props.disabled} onPress={props.onPress} style={[styles.action, props.trailing ? styles.trailingAction : null]}>
        <View style={styles.actionContent}>
            <Text style={props.selected ? styles.selected : styles.text}>{props.label}</Text>
            {props.trailing}
        </View>
    </Pressable>;
}

function isBusy(row: ShareGrantRowModel): boolean {
    return row.operation.kind === 'saving' || row.operation.kind === 'removing';
}

/** The row's right-side level: its adapter label, a policy lock, and the way into its choices. */
export function ShareLevelControl<TRow extends ShareGrantRowModel>(props: Readonly<{
    row: TRow; adapter: ShareSheetAdapter<TRow>; actions: ShareSheetActions; onExpand(): void; testID: string; editable: boolean;
}>): React.ReactElement {
    const { row, actions } = props;
    const { theme } = useUnistyles();
    // Beside the row's own text, so the lock glyph follows the list density like every other glyph.
    const glyphSize = ITEM_ICON_GLYPH_SIZE[useResolvedItemDensity()];
    const label = props.adapter.levels[row.level.value]?.label ?? t('shareSheet.accessLevel');
    return <View style={styles.inline}>
        {props.adapter.showsLevelLock?.(row) ? <SafeIonicons name="lock-closed-outline" size={glyphSize} color={theme.colors.text.secondary} /> : null}
        <ShareRowAction label={label} testID={props.testID}
            accessibilityLabel={t('shareSheet.accessibleControl', { name: row.principal.accessibilityLabel, control: t('shareSheet.accessLevel'), value: label })}
            disabled={isBusy(row)}
            trailing={props.editable && row.level.kind === 'editable'
                ? <SafeIonicons name="chevron-down" size={glyphSize} color={theme.colors.text.secondary} /> : undefined}
            onPress={() => row.level.kind === 'locked' ? actions.explain(row.level.reason) : props.onExpand()} />
    </View>;
}

/** One expanded grant: its level choices, the adapter's own controls, retry, and two-step removal. */
export function ShareGrantRow<TRow extends ShareGrantRowModel>(props: Readonly<{
    row: TRow; adapter: ShareSheetAdapter<TRow>; actions: ShareSheetActions; context: ShareSheetSectionContext;
}>): React.ReactElement {
    const { row, actions, adapter, context } = props;
    const { editable } = context;
    const busy = isBusy(row);
    const removalLabels = adapter.removalLabels?.(row);
    const id = (kind: string) => `${context.idPrefix}${adapter.namespace}-${kind}:${row.principal.key}`;
    return <View style={styles.controls}>
        {row.level.kind === 'locked' ? <Text style={styles.secondary}>{row.level.reason.message}</Text> : null}
        {editable && row.level.kind === 'editable' ? <View style={styles.choices}>
            {orderShareAccessLevels(row.level.options).flatMap((level) => {
                const presentation = adapter.levels[level];
                if (!presentation) return [];
                const label = presentation.label;
                return <ShareRowAction key={level} label={label}
                    testID={`${id('level')}:${level}`} disabled={busy} selected={row.level.value === level}
                    accessibilityLabel={`${row.principal.accessibilityLabel}, ${label}`}
                    onPress={() => actions.setAccessLevel(row.grant, level)} />;
            })}
        </View> : null}
        {adapter.renderGrantDetails?.(row, context) ?? null}
        {row.operation.kind === 'error' ? <Text accessibilityLiveRegion="polite" style={styles.secondary}>{row.operation.error.message}</Text> : null}
        {editable && row.operation.kind === 'error' && row.operation.error.retryable ? <ShareRowAction
            testID={id('retry')} label={t('common.retry')} accessibilityLabel={`${row.principal.accessibilityLabel}, ${t('common.retry')}`}
            onPress={() => actions.retryMutation(row.grant)} /> : null}
        {editable && row.removal.kind === 'allowed' ? <ShareRowAction testID={id('remove')} label={removalLabels?.request ?? t('shareSheet.remove')}
            disabled={busy} onPress={() => actions.requestRemove(row.grant)} /> : null}
        {editable && row.removal.kind === 'confirming' ? <>
            {row.removal.consequences.map((consequence) => <Text key={consequence}
                testID={id('remove-consequence')} accessibilityLiveRegion="polite" style={styles.secondary}>{consequence}</Text>)}
            <View style={styles.choices}>
                <ShareRowAction testID={id('remove-confirm')} label={removalLabels?.confirm ?? t('shareSheet.confirmRemove')}
                    disabled={busy} onPress={() => actions.confirmRemove(row.grant)} />
                <ShareRowAction testID={id('remove-cancel')} label={t('common.cancel')}
                    disabled={busy} onPress={() => actions.cancelRemove(row.grant)} />
            </View>
        </> : null}
        {row.removal.kind === 'blocked' ? <ShareRowAction testID={id('remove-reason')} label={row.removal.reason.message}
            onPress={() => { if (row.removal.kind === 'blocked') actions.explain(row.removal.reason); }} /> : null}
    </View>;
}
