import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

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

export function AgentInputSessionConfigOptionsSection(props: AgentInputSessionConfigOptionsSectionProps) {
    if (props.controls.length === 0) {
        return null;
    }

    return (
        <View style={styles.section}>
            {props.controls.map((control) => {
                const option = control.option;
                const effectiveValue = control.effectiveValue;
                const isBool = isBooleanConfigOptionType(option.type);

                if (isBool) {
                    const boolValue = resolveBooleanConfigOptionValue(option, effectiveValue);
                    return (
                        <Pressable
                            key={option.id}
                            onPress={() => props.onSelectValue?.(
                                option.id,
                                resolveBooleanConfigOptionNextValue(option, !boolValue),
                            )}
                            style={({ pressed }) => [
                                styles.optionRow,
                                pressed ? styles.optionRowPressed : null,
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
                                    {option.description ? (
                                        <Text style={styles.optionDescription}>
                                            {option.description}
                                        </Text>
                                    ) : null}
                                </View>
                                <View style={styles.switchWrap}>
                                    <Switch
                                        value={boolValue}
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

                const currentLabel =
                    option.options?.find((entry) => entry.value === option.currentValue)?.name ??
                    formatValue(option.currentValue);
                const requestedLabel =
                    control.requestedValue !== undefined
                        ? option.options?.find((entry) => entry.value === control.requestedValue)?.name ??
                            formatValue(control.requestedValue)
                        : null;

                const isSelect = option.type === 'select' && (option.options?.length ?? 0) > 0;

                return (
                    <View key={option.id} testID={`agent-input-config-option:${option.id}`} style={styles.configCard}>
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
                        {option.description ? (
                            <Text style={styles.optionDescription}>
                                {option.description}
                            </Text>
                        ) : null}

                        {isSelect ? (
                            <View style={styles.choiceRow}>
                                {option.options?.map((choice) => {
                                    const isSelected = choice.value === effectiveValue;
                                    return (
                                        <Pressable
                                            testID={`agent-input-config-option-option:${option.id}:${String(choice.value)}`}
                                            key={`${option.id}:${String(choice.value)}`}
                                            onPress={() => props.onSelectValue?.(option.id, choice.value)}
                                            style={({ pressed }) => [
                                                styles.choicePill,
                                                isSelected ? styles.choicePillSelected : null,
                                                pressed ? styles.optionRowPressed : null,
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
    optionRow: {
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    optionRowPressed: {
        opacity: 0.85,
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
        color: theme.colors.text,
    },
    optionDescription: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
    },
    switchWrap: {
        paddingLeft: 8,
    },
    configCard: {
        gap: 5,
        borderRadius: 12,
        paddingHorizontal: 10,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    choiceRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        paddingTop: 2,
    },
    choicePill: {
        minHeight: 30,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        justifyContent: 'center',
    },
    choicePillSelected: {
        borderColor: theme.colors.radio.active,
    },
    choiceLabel: {
        fontSize: 12,
        fontWeight: '500',
        color: theme.colors.textSecondary,
    },
    choiceLabelSelected: {
        color: theme.colors.text,
    },
}));
