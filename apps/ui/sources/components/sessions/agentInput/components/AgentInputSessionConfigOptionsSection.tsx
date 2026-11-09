import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import type { SessionConfigOptionControl, SessionConfigOptionValueId } from '@/sync/domains/sessionControl/configOptionsControl';
import {
    isBooleanConfigOptionType,
    resolveBooleanConfigOptionNextValue,
    resolveBooleanConfigOptionValue,
} from '@/sync/domains/sessionControl/configOptionsControl';
import { t } from '@/text';
import { motionTokens } from '@/components/ui/motion/motionTokens';

type AgentInputSessionConfigOptionsSectionProps = Readonly<{
    controls: ReadonlyArray<SessionConfigOptionControl>;
    onSelectValue?: (configId: string, valueId: SessionConfigOptionValueId) => void;
}>;

function formatValue(valueId: SessionConfigOptionValueId): string {
    return valueId;
}

function choiceIdentity(parts: readonly string[]): string {
    return JSON.stringify(parts);
}

export function AgentInputSessionConfigOptionsSection(props: AgentInputSessionConfigOptionsSectionProps) {
    const { theme } = useUnistyles();
    const transientStyles = React.useMemo(() => ({
        choicePillSelected: {
            borderColor: theme.colors.radio.active,
        },
        optionRowPressed: {
            opacity: motionTokens.press.opacitySubtle,
        },
    }), [theme.colors.radio.active]);

    if (props.controls.length === 0) {
        return null;
    }

    return (
        <View style={styles.section}>
            {props.controls.map((control, index) => {
                const option = control.option;
                const effectiveValue = control.effectiveValue;
                const isBool = isBooleanConfigOptionType(option.type);
                const isDisabled = control.disabled === true;

                if (isBool) {
                    const boolValue = resolveBooleanConfigOptionValue(option, effectiveValue);
                    return (
                        <Pressable
                            key={option.id}
                            disabled={isDisabled}
                            onPress={() => props.onSelectValue?.(
                                option.id,
                                resolveBooleanConfigOptionNextValue(option, !boolValue),
                            )}
                            style={({ pressed }) => [
                                styles.optionRow,
                                index > 0 ? styles.rowDivider : null,
                                isDisabled ? styles.optionDisabled : null,
                                pressed && !isDisabled ? transientStyles.optionRowPressed : null,
                            ]}
                        >
                            <View style={styles.booleanContent}>
                                <View style={styles.optionContent}>
                                    <Text style={styles.optionLabel}>
                                        {option.name}
                                    </Text>
                                    <Text style={styles.optionDescription}>
                                        {control.isPending
                                            ? t('agentInput.acp.pendingValue', {
                                                current: formatValue(option.currentValue),
                                                requested: formatValue(control.requestedValue!),
                                            })
                                            : t('agentInput.acp.currentValue', { value: formatValue(option.currentValue) })}
                                    </Text>
                                    {isDisabled && control.disabledByOptionName ? (
                                        <Text
                                            testID={`agent-input-config-option-overridden:${option.id}`}
                                            style={styles.optionDescription}
                                        >
                                            {t('agentInput.acp.optionOverriddenBy', { name: control.disabledByOptionName })}
                                        </Text>
                                    ) : null}
                                    {option.description ? (
                                        <Text style={styles.optionDescription}>
                                            {option.description}
                                        </Text>
                                    ) : null}
                                </View>
                                <View style={styles.switchWrap}>
                                    <Switch
                                        accessibilityLabel={option.name}
                                        value={boolValue}
                                        disabled={isDisabled}
                                        onValueChange={(next) => props.onSelectValue?.(
                                            option.id,
                                            resolveBooleanConfigOptionNextValue(option, next),
                                        )}
                                    />
                                </View>
                            </View>
                        </Pressable>
                    );
                }

                const choices = option.options ?? option.groups?.flatMap((group) => group.options) ?? [];
                const currentLabel =
                    choices.find((entry) => entry.value === option.currentValue)?.name ??
                    formatValue(option.currentValue);
                const requestedLabel =
                    control.requestedValue !== undefined
                        ? choices.find((entry) => entry.value === control.requestedValue)?.name ??
                            formatValue(control.requestedValue)
                        : null;

                const isSelect = option.type === 'select' && choices.length > 0;
                // While overridden, highlight what the agent is ACTUALLY running rather than the
                // stored intent. With no matching choice, highlight nothing instead of pointing
                // at a pill the forced value does not correspond to.
                const highlightedValue = isDisabled
                    ? control.overriddenEffectiveValue ?? null
                    : effectiveValue;
                const renderChoice = (choice: { value: string; name: string }, identity: string) => {
                    const isSelected = choice.value === highlightedValue;
                    return (
                        <Pressable
                            testID={`agent-input-config-option-option:${identity}`}
                            key={identity}
                            disabled={isDisabled}
                            onPress={() => props.onSelectValue?.(option.id, choice.value)}
                            style={({ pressed }) => [
                                styles.choicePill,
                                isSelected ? transientStyles.choicePillSelected : null,
                                pressed && !isDisabled ? transientStyles.optionRowPressed : null,
                            ]}
                        >
                            <Text style={[styles.choiceLabel, isSelected ? styles.choiceLabelSelected : null]}>
                                {choice.name}
                            </Text>
                        </Pressable>
                    );
                };

                return (
                    <View
                        key={option.id}
                        testID={`agent-input-config-option:${option.id}`}
                        style={[styles.configCard, index > 0 ? styles.rowDivider : null, isDisabled ? styles.optionDisabled : null]}
                    >
                        <View style={styles.optionHeader}>
                            <Text style={[styles.optionLabel, styles.optionHeaderLabel]}>
                                {option.name}
                            </Text>
                            <Text
                                testID={`agent-input-config-option-summary:${option.id}`}
                                style={[styles.optionDescription, styles.optionSummary]}
                            >
                                {control.isPending && requestedLabel
                                    ? t('agentInput.acp.pendingValue', { current: currentLabel, requested: requestedLabel })
                                    : t('agentInput.acp.currentValue', { value: currentLabel })}
                            </Text>
                        </View>
                        {isDisabled && control.disabledByOptionName ? (
                            <Text
                                testID={`agent-input-config-option-overridden:${option.id}`}
                                style={styles.optionDescription}
                            >
                                {t('agentInput.acp.optionOverriddenBy', { name: control.disabledByOptionName })}
                            </Text>
                        ) : null}
                        {option.description ? (
                            <Text style={styles.optionDescription}>
                                {option.description}
                            </Text>
                        ) : null}

                        {isSelect ? (
                            <View style={styles.choiceRow}>
                                {option.groups?.length ? option.groups.map((group) => (
                                    <View key={group.id} style={styles.group}>
                                        <Text accessibilityRole="header" style={styles.groupLabel}>{group.name}</Text>
                                        <View style={styles.choiceRow}>
                                            {group.options.map((choice) => renderChoice(
                                                choice,
                                                choiceIdentity([option.id, group.id, choice.value]),
                                            ))}
                                        </View>
                                    </View>
                                )) : option.options?.map((choice) => renderChoice(
                                    choice,
                                    choiceIdentity([option.id, choice.value]),
                                ))}
                            </View>
                        ) : null}
                    </View>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // One sheet per block of controls: rows divided by hairlines, not a stack of bordered cards.
    section: {
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden',
    },
    rowDivider: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
    optionHeader: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: theme.space.s12,
    },
    optionHeaderLabel: {
        flexShrink: 0,
    },
    optionSummary: {
        flexShrink: 1,
        textAlign: 'right',
        fontVariant: ['tabular-nums'],
    },
    optionDisabled: {
        opacity: 0.5,
    },
    optionRow: {
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s10,
    },
    booleanContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    optionContent: {
        flex: 1,
        flexShrink: 1,
        gap: 3,
    },
    optionLabel: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    optionDescription: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    switchWrap: {
        paddingLeft: theme.space.s8,
    },
    configCard: {
        gap: theme.space.s4,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s10,
    },
    choiceRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s6,
        paddingTop: theme.space.s2,
    },
    group: {
        gap: theme.space.s4,
        width: '100%',
    },
    groupLabel: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    choicePill: {
        minHeight: 30,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s6,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        justifyContent: 'center',
    },
    choiceLabel: {
        ...Typography.variant('meta', 'medium'),
        color: theme.colors.text.secondary,
    },
    choiceLabelSelected: {
        color: theme.colors.text.primary,
    },
}));
