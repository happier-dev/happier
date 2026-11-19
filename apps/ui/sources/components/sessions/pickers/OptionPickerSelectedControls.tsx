import * as React from 'react';
import { resolveThemeSurfaceAddress, useHappierThemeSurfaceOverridesEnabled } from '@happier-dev/plugin-ui/presentation';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
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

/**
 * One row of the selected option's options (lab round 4 B, owner 2026-11-19): a small grey caption, then its
 * control. `below` puts the control under the caption line, whose right end carries an optional quiet note
 * (an effort scale, a two-part switch). `beside` keeps the caption and its description as one block with the
 * control on its right (a switch, an icon button). Every line starts on the card's text edge.
 */
export function OptionPickerBandRow(props: Readonly<{
    label: string;
    children: React.ReactNode;
    /** Under the caption, inside the caption's block (a description, a source and its usage). */
    detail?: React.ReactNode;
    note?: React.ReactNode;
    placement?: 'below' | 'beside';
    testID?: string;
    dataSet?: Record<string, string>;
    style?: StyleProp<ViewStyle>;
}>) {
    const caption = (
        <View style={styles.captionLine}>
            <Text style={styles.caption}>{props.label}</Text>
            {props.note ? <View style={styles.note}>{props.note}</View> : null}
        </View>
    );
    if (props.placement === 'beside') {
        return (
            <View testID={props.testID} {...(props.dataSet ? { dataSet: props.dataSet } : {})}
                style={[styles.row, styles.rowBeside, props.style]}>
                <View style={styles.block}>
                    {caption}
                    {props.detail}
                </View>
                {props.children}
            </View>
        );
    }
    return (
        <View testID={props.testID} {...(props.dataSet ? { dataSet: props.dataSet } : {})} style={[styles.row, props.style]}>
            {caption}
            {props.detail}
            {props.children}
        </View>
    );
}

/**
 * The selected option's options, inside its tile (lab round 4 B, owner pick 2026-11-19): only the current choice
 * carries options; every other card is its name and description (owner 2026-11-04, matching the 0.2 engine
 * popover). No box and no dividers inside the tile: captioned rows, then any rows the picker adds (Runs through).
 */
export function OptionPickerSelectedControls() {
    const context = React.useContext(OptionPickerSelectedControlsContext);
    const themeSurfaceEnabled = useHappierThemeSurfaceOverridesEnabled();
    const segmentedOverflow = React.useMemo(() => ({ label: t('common.more') }), []);
    const { multiColumn, onSelect, band } = context;
    const controls = context.controls ?? NO_CONTROLS;
    const idBase = 'model-picker-overlay-selected-option-control';
    if (controls.length === 0 && !band?.rows) return null;
    return (
        <View testID="model-picker-overlay-selected-controls"
            style={[styles.panel, multiColumn ? styles.panelCard : styles.panelList]}>
            {controls.map(control => {
                const option = control.option;
                const controlAccessibilityLabel = t('modelPickerOverlay.optionControlA11y', { name: option.name });
                const overriddenBy = control.disabled === true ? control.disabledByOptionName : undefined;
                const secondaryText = overriddenBy ? t('agentInput.acp.optionOverriddenBy', { name: overriddenBy }) : option.description;
                const secondary = secondaryText ? (
                    <Text testID={overriddenBy ? `${idBase}-overridden:${option.id}` : undefined}
                        style={styles.description}>{secondaryText}</Text>
                ) : undefined;
                const note = band?.controlNotes?.[option.id];
                if (isBooleanConfigOptionType(option.type)) {
                    const boolValue = resolveBooleanConfigOptionValue(option, String(control.effectiveValue) as SessionConfigOptionValueId);
                    return (
                        <OptionPickerBandRow key={option.id} testID={`${idBase}:${option.id}`} label={option.name}
                            detail={secondary} note={note} placement="beside">
                            <Switch testID={`${idBase}-switch:${option.id}`}
                                accessibilityLabel={controlAccessibilityLabel} value={boolValue} disabled={control.disabled === true}
                                onValueChange={next => {
                                    if (control.disabled === true) return;
                                    onSelect?.(option.id, resolveBooleanConfigOptionNextValue(option, next));
                                }} compact />
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
                    <OptionPickerBandRow key={option.id} testID={`${idBase}:${option.id}`} label={option.name}
                        detail={secondary} note={note}
                        {...(surface ? { dataSet: { ...surface, state: surface.state ?? 'default' } } : {})}
                        style={themeSurfaceStyles.surface(themeSurfaceEnabled ? surface : undefined)}>
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
                                            // A card narrower than its choices shows them as one field select instead of cutting a label.
                                            overflow={segmentedOverflow}
                                            accessibilityLabel={groupAccessibilityLabel}
                                            compact activeLabelStyle={Typography.default('semiBold')} />
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </OptionPickerBandRow>
                );
            })}
            {band?.rows ?? null}
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    // Match the selected row's existing inset; the card owns its tile in grid mode.
    panel: { paddingBottom: theme.space.s10, gap: theme.space.s10 },
    // On a card the rows start on the card title's edge, not a list row's.
    panelCard: { paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX, paddingTop: theme.space.s2 },
    // A phone list row paints its own selected fill; its options continue that fill.
    panelList: { paddingHorizontal: OPTION_PICKER_LIST_TEXT_INSET_PX, backgroundColor: theme.colors.surface.selected },
    row: { gap: theme.space.s4 },
    rowBeside: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    block: { flex: 1, minWidth: 0, gap: 1 },
    captionLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    caption: { ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 },
    note: { marginLeft: 'auto', flexShrink: 1 },
    description: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
    groupLabel: { ...Typography.variant('micro', 'semiBold'), color: theme.colors.text.secondary },
}));
