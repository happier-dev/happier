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
            opacity: 0.85,
        },
    }), [theme.colors.radio.active]);

    if (props.controls.length === 0) {
        return null;
    }

    return (
        <View style={styles.section}>
            {props.controls.map((control) => {
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

                return (
                    <View
                        key={option.id}
                        testID={`agent-input-config-option:${option.id}`}
                        style={[styles.configCard, isDisabled ? styles.optionDisabled : null]}
                    >
                        <Text style={styles.optionLabel}>
                            {option.name}
                        </Text>
                        <Text
                            testID={`agent-input-config-option-summary:${option.id}`}
                            style={styles.optionDescription}
                        >
                            {control.isPending && requestedLabel
                                ? t('agentInput.acp.pendingValue', { current: currentLabel, requested: requestedLabel })
                                : t('agentInput.acp.currentValue', { value: currentLabel })}
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

                        {isSelect ? (
                            <View style={styles.choiceRow}>
                                {option.groups?.map((group) => (
                                    <View key={group.id} style={styles.group}>
                                        <Text accessibilityRole="header" style={styles.groupLabel}>{group.name}</Text>
                                        <View style={styles.choiceRow}>
                                            {group.options.map((choice) => {
                                                const isSelected = choice.value === highlightedValue;
                                                const identity = choiceIdentity([option.id, group.id, choice.value]);
                                                return (
                                                    <Pressable
                                                        testID={`agent-input-config-option-option:${identity}`}
                                                        key={identity}
                                                        disabled={isDisabled}
                                                        onPress={() => props.onSelectValue?.(option.id, choice.value)}
                                                        style={({ pressed }) => [styles.choicePill, isSelected ? transientStyles.choicePillSelected : null, pressed && !isDisabled ? transientStyles.optionRowPressed : null]}
                                                    >
                                                        <Text style={[styles.choiceLabel, isSelected ? styles.choiceLabelSelected : null]}>{choice.name}</Text>
                                                    </Pressable>
                                                );
                                            })}
                                        </View>
                                    </View>
                                ))}
                                {option.options?.map((choice) => {
                                    const isSelected = choice.value === highlightedValue;
                                    const identity = choiceIdentity([option.id, choice.value]);
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
                                            <Text
                                                style={[
                                                    styles.choiceLabel,
                                                    isSelected ? styles.choiceLabelSelected : null,
                                                ]}
                                            >
                                                {choice.name}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </View>
                        ) : null}
                    </View>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    section: {
        gap: 8,
    },
    optionDisabled: {
        opacity: 0.5,
    },
    optionRow: {
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    booleanContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    optionContent: {
        flex: 1,
        flexShrink: 1,
        gap: 3,
    },
    optionLabel: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    optionDescription: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    switchWrap: {
        paddingLeft: 8,
    },
    configCard: {
        gap: 5,
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    choiceRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        paddingTop: 2,
    },
    group: {
        gap: 4,
        width: '100%',
    },
    groupLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
    },
    choicePill: {
        minHeight: 30,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        justifyContent: 'center',
    },
    choiceLabel: {
        fontSize: 12,
        fontWeight: '500',
        color: theme.colors.text.secondary,
    },
    choiceLabelSelected: {
        color: theme.colors.text.primary,
    },
}));
