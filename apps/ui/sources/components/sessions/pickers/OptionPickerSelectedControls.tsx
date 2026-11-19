import * as React from 'react';
import { resolveThemeSurfaceAddress, useHappierMaterialColorResolver, useHappierThemeSurfaceOverridesEnabled } from '@happier-dev/plugin-ui/presentation';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/ui/forms/Switch';
import { resolveHappierChoiceControl } from '@happier-dev/plugin-ui/presentation';
import { PROVIDER_REASONING_EFFORT_OPTION_ID } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import { SegmentedTabBar, SegmentedValueSelect } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { isBooleanConfigOptionType, resolveBooleanConfigOptionNextValue, resolveBooleanConfigOptionValue,
    type SessionConfigOptionControl, type SessionConfigOptionValueId } from '@/sync/domains/sessionControl/configOptionsControl';
import { t } from '@/text';
import { SELECTION_LIST_CARD_CONTENT_INSET_PX } from '@/components/ui/selectionList/_constants';
import { OPTION_PICKER_LIST_TEXT_INSET_PX, OptionPickerSelectedControlsContext } from './optionPickerSelectedControlsState';

const NO_CONTROLS: readonly SessionConfigOptionControl[] = [];

/** The band's one label column on a wide pane (lab A2): Thinking, Ultracode and Runs through share one edge. */
const BAND_LABEL_COLUMN_PX = 104;

/**
 * One row of the selected option's band: its label, its control, then an optional quiet note. In the grid the band
 * spans the whole row under the selected card (`SelectionListColumnRow`), so the label takes one column beside the
 * control; a phone list stacks the label over a full-width control.
 */
export function OptionPickerBandRow(props: Readonly<{
    label: string;
    children: React.ReactNode;
    note?: React.ReactNode;
    testID?: string;
    dataSet?: Record<string, string>;
    style?: StyleProp<ViewStyle>;
}>) {
    const { multiColumn } = React.useContext(OptionPickerSelectedControlsContext);
    return (
        <View testID={props.testID} {...(props.dataSet ? { dataSet: props.dataSet } : {})}
            style={[styles.row, multiColumn ? styles.rowWide : null, props.style]}>
            <Text style={[styles.label, multiColumn ? styles.labelColumn : null]}>{props.label}</Text>
            <View style={[styles.body, multiColumn ? styles.bodyWide : null]}>
                {props.children}
                {props.note}
            </View>
        </View>
    );
}

/**
 * The selected option's band (lab A2, owner pick 2026-11-18): only the current choice carries options; every
 * other card is its name and description (owner 2026-11-04, matching the 0.2 engine popover). The band is one
 * soft well of labelled rows: the option controls, then any rows the picker adds (Runs through).
 */
export function OptionPickerSelectedControls() {
    const context = React.useContext(OptionPickerSelectedControlsContext);
    const themeSurfaceEnabled = useHappierThemeSurfaceOverridesEnabled();
    const segmentedOverflow = React.useMemo(() => ({ label: t('common.more') }), []);
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const { multiColumn, onSelect, band } = context;
    const controls = context.controls ?? NO_CONTROLS;
    const idBase = 'model-picker-overlay-selected-option-control';
    if (controls.length === 0 && !band?.rows) return null;
    return (
        <View testID="model-picker-overlay-selected-controls"
            style={[styles.panel, multiColumn ? styles.panelCard : styles.panelList]}>
            <View style={[styles.band, { backgroundColor: paintColor(theme.colors.surface.selected) }]}>
                {controls.map((control, index) => {
                    const option = control.option;
                    const divided = index > 0 ? styles.divided : null;
                    const controlAccessibilityLabel = t('modelPickerOverlay.optionControlA11y', { name: option.name });
                    const overriddenBy = control.disabled === true ? control.disabledByOptionName : undefined;
                    const secondaryText = overriddenBy ? t('agentInput.acp.optionOverriddenBy', { name: overriddenBy }) : option.description;
                    const secondary = secondaryText ? (
                        <Text testID={overriddenBy ? `${idBase}-overridden:${option.id}` : undefined}
                            style={styles.description}>{secondaryText}</Text>
                    ) : null;
                    const note = band?.controlNotes?.[option.id];
                    if (isBooleanConfigOptionType(option.type)) {
                        const boolValue = resolveBooleanConfigOptionValue(option, String(control.effectiveValue) as SessionConfigOptionValueId);
                        return (
                            <OptionPickerBandRow key={option.id} testID={`${idBase}:${option.id}`} label={option.name}
                                note={note} style={divided}>
                                <View style={styles.booleanBody}>
                                    <View style={styles.textBlock}>{secondary}</View>
                                    <Switch testID={`${idBase}-switch:${option.id}`}
                                        accessibilityLabel={controlAccessibilityLabel} value={boolValue} disabled={control.disabled === true}
                                        onValueChange={next => {
                                            if (control.disabled === true) return;
                                            onSelect?.(option.id, resolveBooleanConfigOptionNextValue(option, next));
                                        }} compact />
                                </View>
                            </OptionPickerBandRow>
                        );
                    }
                    // An override outside the available segments highlights nothing.
                    const highlightedValue = control.disabled === true ? control.overriddenEffectiveValue ?? '' : control.effectiveValue;
                    // More choices than one segmented control holds, or long ones, are the one field select, decided once
                    // for the whole option by the shared choice-control rule. Thinking effort is an ordinal scale, so
                    // Low · Medium · High · XHigh · Max stays one segmented row (owner ruling 2026-11-04).
                    const groups = option.groups?.length ? option.groups : [{ id: null, name: null, options: option.options ?? [] }];
                    const ordinal = option.id === PROVIDER_REASONING_EFFORT_OPTION_ID;
                    const surface = ordinal && context.effortSurface
                        ? resolveThemeSurfaceAddress(context.effortSurface, { disabled: control.disabled === true })
                        : undefined;
                    const asSelect = resolveHappierChoiceControl({ kind: 'select', value: highlightedValue, multiple: false },
                        groups.flatMap(group => group.options.map(choice => ({ label: choice.name }))),
                        { ordinal }) === 'list';
                    return (
                        <OptionPickerBandRow key={option.id} testID={`${idBase}:${option.id}`} label={option.name} note={note}
                            {...(surface ? { dataSet: { ...surface, state: surface.state ?? 'default' } } : {})}
                            style={[divided, themeSurfaceStyles.surface(themeSurfaceEnabled ? surface : undefined)]}>
                            <View style={styles.choiceBody}>
                                {secondary}
                                {groups.map(group => {
                                    const tabs = group.options.map(choice => ({ id: choice.value, label: choice.name }));
                                    const selectTab = (tabId: string) => {
                                        if (control.disabled === true) return;
                                        onSelect?.(option.id, tabId as SessionConfigOptionValueId);
                                    };
                                    const testIDPrefix = `${idBase}-option:${option.id}${group.id === null ? '' : `:${group.id}`}`;
                                    const groupAccessibilityLabel = group.name ? `${controlAccessibilityLabel}: ${group.name}` : controlAccessibilityLabel;
                                    return (
                                        <React.Fragment key={group.id ?? 'choices'}>
                                            {group.name ? <Text accessibilityRole="header" style={styles.groupLabel}>{group.name}</Text> : null}
                                            {asSelect ? (
                                                <SegmentedValueSelect tabs={tabs} activeTabId={highlightedValue}
                                                    disabled={control.disabled === true} onSelectTab={selectTab}
                                                    accessibilityLabel={groupAccessibilityLabel} testID={`${testIDPrefix}:select`} />
                                            ) : (
                                                <SegmentedTabBar role="radiogroup" tabs={tabs}
                                                    segmentSizing={ordinal ? 'equal-or-label' : undefined}
                                                    activeTabId={highlightedValue} disabled={control.disabled === true}
                                                    onSelectTab={selectTab}
                                                    testIDPrefix={testIDPrefix}
                                                    // A band narrower than its choices shows them as one field select instead of cutting a label.
                                                    overflow={segmentedOverflow}
                                                    accessibilityLabel={groupAccessibilityLabel}
                                                    compact activeLabelStyle={Typography.default('semiBold')} />
                                            )}
                                        </React.Fragment>
                                    );
                                })}
                            </View>
                        </OptionPickerBandRow>
                    );
                })}
                {band?.rows ? (
                    <View style={controls.length > 0 ? styles.divided : null}>{band.rows}</View>
                ) : null}
            </View>
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    // The band sits under the selected row: on a list row at the row's text inset, on a card at the card's edge.
    panel: { paddingBottom: theme.space.s10 },
    panelList: { paddingHorizontal: OPTION_PICKER_LIST_TEXT_INSET_PX - SELECTION_LIST_CARD_CONTENT_INSET_PX },
    panelCard: { paddingTop: theme.space.s2 },
    // One soft well (the selection surface the card used to paint), its text on the card title's edge.
    band: {
        borderRadius: theme.borderRadius.lg,
        paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX,
    },
    row: { paddingVertical: theme.space.s8, gap: theme.space.s6 },
    rowWide: { flexDirection: 'row', alignItems: 'flex-start' },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.divider },
    label: { ...Typography.variant('body'), color: theme.colors.text.primary },
    // Centred on a one-line control (a segmented row, a switch, a field select).
    labelColumn: { width: BAND_LABEL_COLUMN_PX, flexShrink: 0, paddingTop: theme.space.s6 },
    bodyWide: { flex: 1, minWidth: 0 },
    body: { gap: theme.space.s4 },
    choiceBody: { flexShrink: 1, gap: theme.space.s2 },
    booleanBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    textBlock: { flex: 1, minWidth: 0 },
    description: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
    groupLabel: { ...Typography.variant('micro', 'semiBold'), color: theme.colors.text.secondary },
}));
