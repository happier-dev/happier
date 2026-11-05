import * as React from 'react';
import { View } from 'react-native';
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
import { OptionPickerSelectedControlsContext } from './optionPickerSelectedControlsState';

const NO_CONTROLS: readonly SessionConfigOptionControl[] = [];

/**
 * The selected option's live controls, inside its card. Only the current choice carries controls; every
 * other card is its name and description (owner 2026-11-04, matching the 0.2 engine popover). Picking
 * another card selects it, and then its card shows its own controls.
 */
export function OptionPickerSelectedControls() {
    const context = React.useContext(OptionPickerSelectedControlsContext);
    const segmentedOverflow = React.useMemo(() => ({ label: t('common.more') }), []);
    const { multiColumn, onSelect } = context;
    const controls = context.controls ?? NO_CONTROLS;
    const idBase = 'model-picker-overlay-selected-option-control';
    if (controls.length === 0) return null;
    return (
        <View testID="model-picker-overlay-selected-controls"
            style={[styles.panel, multiColumn ? styles.panelCard : null, multiColumn ? null : styles.panelFill]}>
            <View style={styles.controls}>
                {controls.map(control => {
                    const option = control.option;
                    const controlAccessibilityLabel = t('modelPickerOverlay.optionControlA11y', { name: option.name });
                    const overriddenBy = control.disabled === true ? control.disabledByOptionName : undefined;
                    const secondaryText = overriddenBy ? t('agentInput.acp.optionOverriddenBy', { name: overriddenBy }) : option.description;
                    const secondary = secondaryText ? (
                        <Text testID={overriddenBy ? `${idBase}-overridden:${option.id}` : undefined}
                            style={styles.description}>{secondaryText}</Text>
                    ) : null;
                    if (isBooleanConfigOptionType(option.type)) {
                        const boolValue = resolveBooleanConfigOptionValue(option, String(control.effectiveValue) as SessionConfigOptionValueId);
                        return (
                            <View key={option.id} testID={`${idBase}:${option.id}`} style={styles.row}>
                                <View style={styles.textBlock}>
                                    <Text style={styles.title}>{option.name}</Text>
                                    {secondary}
                                </View>
                                <Switch testID={`${idBase}-switch:${option.id}`}
                                    accessibilityLabel={controlAccessibilityLabel} value={boolValue} disabled={control.disabled === true}
                                    onValueChange={next => {
                                        if (control.disabled === true) return;
                                        onSelect?.(option.id, resolveBooleanConfigOptionNextValue(option, next));
                                    }} compact />
                            </View>
                        );
                    }
                    // An override outside the available segments highlights nothing.
                    const highlightedValue = control.disabled === true ? control.overriddenEffectiveValue ?? '' : control.effectiveValue;
                    // More choices than one segmented control holds, or long ones, are the one field select, decided once
                    // for the whole option by the shared choice-control rule. Thinking effort is an ordinal scale, so
                    // Low · Medium · High · XHigh · Max stays one segmented row (owner ruling 2026-11-04).
                    const groups = option.groups?.length ? option.groups : [{ id: null, name: null, options: option.options ?? [] }];
                    const asSelect = resolveHappierChoiceControl({ kind: 'select', value: highlightedValue, multiple: false },
                        groups.flatMap(group => group.options.map(choice => ({ label: choice.name }))),
                        { ordinal: option.id === PROVIDER_REASONING_EFFORT_OPTION_ID }) === 'list';
                    return (
                        <View key={option.id} testID={`${idBase}:${option.id}`} style={styles.group}>
                            <Text style={styles.title}>{option.name}</Text>
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
                        </View>
                    );
                })}
            </View>
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    // Match the selected row's existing inset; the card owns its background in grid mode.
    panel: { paddingHorizontal: 14, paddingBottom: theme.space.s10 },
    // On a card the controls start on the card title's edge, not a list row's.
    panelCard: { paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX },
    panelFill: { backgroundColor: theme.colors.surface.selected },
    controls: { gap: theme.space.s10 },
    group: { gap: 3 },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.s8 },
    textBlock: { flex: 1, gap: 1 },
    title: { ...Typography.variant('meta', 'medium'), color: theme.colors.text.secondary },
    description: { fontSize: 11, lineHeight: 14, color: theme.colors.text.tertiary },
    groupLabel: { fontSize: 11, lineHeight: 14, fontWeight: '600', color: theme.colors.text.secondary },
}));
