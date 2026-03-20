import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import type { AcpConfigOptionControl, AcpConfigOptionValueId } from '@/sync/acp/configOptionsControl';
import { t } from '@/text';

type AgentInputAcpConfigOptionsSectionProps = Readonly<{
    controls: ReadonlyArray<AcpConfigOptionControl>;
    headerAccessory?: React.ReactNode;
    onSelectValue?: (configId: string, valueId: AcpConfigOptionValueId) => void;
}>;

function parseAcpBooleanValueId(valueId: string): boolean {
    return valueId === 'true';
}

function formatValue(valueId: AcpConfigOptionValueId): string {
    return valueId;
}

export function AgentInputAcpConfigOptionsSection(props: AgentInputAcpConfigOptionsSectionProps) {
    if (props.controls.length === 0 && !props.headerAccessory) {
        return null;
    }

    return (
        <View style={styles.section}>
            <View style={styles.headerRow}>
                <Text style={styles.sectionTitle}>
                    {t('agentInput.acp.optionsSectionTitle')}
                </Text>
                {props.headerAccessory ? (
                    <View style={styles.headerAccessory}>
                        {props.headerAccessory}
                    </View>
                ) : null}
            </View>

            {props.controls.map((control) => {
                const option = control.option;
                const effectiveValue = control.effectiveValue;
                const isBool =
                    option.type === 'boolean' ||
                    option.type === 'bool' ||
                    option.type === 'toggle';

                if (isBool) {
                    const boolValue = parseAcpBooleanValueId(effectiveValue);
                    return (
                        <Pressable
                            key={option.id}
                            onPress={() => props.onSelectValue?.(option.id, boolValue ? 'false' : 'true')}
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
                                        onValueChange={(next) => props.onSelectValue?.(option.id, next ? 'true' : 'false')}
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
        gap: 10,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    headerAccessory: {
        flexShrink: 0,
    },
    sectionTitle: {
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        color: theme.colors.textSecondary,
    },
    optionRow: {
        borderRadius: 14,
        paddingHorizontal: 12,
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
        gap: 4,
    },
    optionLabel: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
    },
    optionDescription: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    switchWrap: {
        paddingLeft: 8,
    },
    configCard: {
        gap: 6,
        borderRadius: 14,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    choiceRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        paddingTop: 4,
    },
    choicePill: {
        minHeight: 34,
        paddingHorizontal: 12,
        paddingVertical: 8,
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
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.textSecondary,
    },
    choiceLabelSelected: {
        color: theme.colors.text,
    },
}));
