import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { ActionInputFieldHint } from '@happier-dev/protocol';

import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

export type ActionFieldOption = Readonly<{
    value: string;
    label: string;
    disabled?: boolean;
}>;

export function getValueAtPath(input: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.').filter(Boolean);
    let cur: any = input;
    for (const part of parts) {
        if (!cur || typeof cur !== 'object') return undefined;
        cur = cur[part];
    }
    return cur;
}

export function setValueAtTopLevelPatch(input: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
    const parts = path.split('.').filter(Boolean);
    if (parts.length === 0) return {};
    const top = parts[0]!;
    if (parts.length === 1) return { [top]: value };

    const rest = parts.slice(1);
    const prevTop: any = (input as any)[top];
    const nextTop = (() => {
        const base = prevTop && typeof prevTop === 'object' ? { ...(prevTop as any) } : {};
        let cur: any = base;
        for (let i = 0; i < rest.length; i += 1) {
            const key = rest[i]!;
            if (i === rest.length - 1) {
                cur[key] = value;
            } else {
                const existing = cur[key];
                cur[key] = existing && typeof existing === 'object' ? { ...(existing as any) } : {};
                cur = cur[key];
            }
        }
        return base;
    })();
    return { [top]: nextTop };
}

function ActionFieldChip(props: Readonly<{
    selected: boolean;
    label: string;
    onPress: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
}>) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: props.selected, disabled: props.disabled === true }}
            accessibilityLabel={props.accessibilityLabel}
            disabled={props.disabled === true}
            onPress={props.disabled ? undefined : props.onPress}
            style={({ pressed }) => ({
                paddingVertical: 8,
                paddingHorizontal: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.colors.divider,
                opacity: props.disabled ? 0.4 : pressed ? 0.7 : 1,
                backgroundColor: props.selected ? (theme.colors.surfaceHighest ?? theme.colors.surfaceHigh) : 'transparent',
            })}
        >
            <Text style={{ color: theme.colors.text }}>{props.label}</Text>
        </Pressable>
    );
}

export function ActionInputFields(props: Readonly<{
    fields: readonly ActionInputFieldHint[];
    input: Record<string, unknown>;
    editable: boolean;
    resolveFieldOptions: (field: ActionInputFieldHint) => readonly ActionFieldOption[];
    onPatch: (patch: Record<string, unknown>) => void;
    resolveFieldTestID?: (field: ActionInputFieldHint) => string | undefined;
    getChipAccessibilityLabel?: (args: Readonly<{
        field: ActionInputFieldHint;
        option: ActionFieldOption;
        selected: boolean;
    }>) => string | undefined;
}>) {
    const { theme } = useUnistyles();

    return (
        <>
            {props.fields.map((field) => {
                const path = typeof field?.path === 'string' ? field.path : '';
                const widget = typeof field?.widget === 'string' ? field.widget : '';
                if (!path || !widget) return null;

                const label = typeof field?.title === 'string' ? field.title : path;
                const value = getValueAtPath(props.input, path);
                const disabled = (field as any)?.disabled === true;
                const fieldTestID = props.resolveFieldTestID?.(field);

                if (widget === 'multiselect') {
                    const selected = Array.isArray(value) ? (value as unknown[]).map(String) : [];
                    const options = props.resolveFieldOptions(field);
                    const isRequired = field?.required === true;
                    return (
                        <View key={path} style={{ marginTop: 10 }}>
                            <Text style={{ color: theme.colors.textSecondary, marginBottom: 6 }}>{label}</Text>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                                {options.map((option) => {
                                    const isSelected = selected.includes(option.value);
                                    const blocksDeselection = isRequired && isSelected && selected.length <= 1;
                                    return (
                                        <ActionFieldChip
                                            key={option.value}
                                            label={option.label}
                                            selected={isSelected}
                                            disabled={!props.editable || disabled || option.disabled === true}
                                            accessibilityLabel={props.getChipAccessibilityLabel?.({ field, option, selected: isSelected })}
                                            onPress={() => {
                                                if (!props.editable || disabled || option.disabled === true) return;
                                                if (blocksDeselection) return;
                                                const next = isSelected
                                                    ? selected.filter((id) => id !== option.value)
                                                    : [...selected, option.value];
                                                props.onPatch(setValueAtTopLevelPatch(props.input, path, next));
                                            }}
                                        />
                                    );
                                })}
                            </View>
                        </View>
                    );
                }

                if (widget === 'select') {
                    const selected = typeof value === 'string' ? value : '';
                    const options = props.resolveFieldOptions(field);
                    return (
                        <View key={path} style={{ marginTop: 10 }}>
                            <Text style={{ color: theme.colors.textSecondary, marginBottom: 6 }}>{label}</Text>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                                {options.map((option) => (
                                    <ActionFieldChip
                                        key={option.value}
                                        label={option.label}
                                        selected={selected === option.value}
                                        disabled={!props.editable || disabled || option.disabled === true}
                                        accessibilityLabel={props.getChipAccessibilityLabel?.({ field, option, selected: selected === option.value })}
                                        onPress={() => {
                                            if (!props.editable || disabled || option.disabled === true) return;
                                            props.onPatch(setValueAtTopLevelPatch(props.input, path, option.value));
                                        }}
                                    />
                                ))}
                            </View>
                        </View>
                    );
                }

                if (widget === 'toggle' || widget === 'checkbox') {
                    const selected = value === true;
                    return (
                        <View key={path} style={{ marginTop: 10 }}>
                            <Text style={{ color: theme.colors.textSecondary, marginBottom: 6 }}>{label}</Text>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                                <ActionFieldChip
                                    label={t('common.on')}
                                    selected={selected}
                                    disabled={!props.editable || disabled}
                                    accessibilityLabel={props.getChipAccessibilityLabel?.({ field, option: { value: 'true', label: t('common.on') }, selected })}
                                    onPress={() => {
                                        if (!props.editable || disabled) return;
                                        props.onPatch(setValueAtTopLevelPatch(props.input, path, true));
                                    }}
                                />
                                <ActionFieldChip
                                    label={t('common.off')}
                                    selected={!selected}
                                    disabled={!props.editable || disabled}
                                    accessibilityLabel={props.getChipAccessibilityLabel?.({ field, option: { value: 'false', label: t('common.off') }, selected: !selected })}
                                    onPress={() => {
                                        if (!props.editable || disabled) return;
                                        props.onPatch(setValueAtTopLevelPatch(props.input, path, false));
                                    }}
                                />
                            </View>
                        </View>
                    );
                }

                if (widget === 'text_list') {
                    const separator = field?.listSeparator === 'newline' ? '\n' : ',';
                    const items = Array.isArray(value)
                        ? (value as unknown[]).map((item) => String(item ?? '').trim()).filter(Boolean)
                        : [];
                    const displayValue = separator === '\n' ? items.join('\n') : items.join(', ');
                    return (
                        <View key={path} style={{ marginTop: 10 }}>
                            <Text style={{ color: theme.colors.textSecondary, marginBottom: 6 }}>{label}</Text>
                            <TextInput
                                testID={fieldTestID}
                                editable={props.editable && !disabled}
                                value={displayValue}
                                onChangeText={(text) => {
                                    const parts = separator === '\n' ? String(text ?? '').split('\n') : String(text ?? '').split(',');
                                    const next = parts.map((part) => part.trim()).filter((part) => part.length > 0);
                                    props.onPatch(setValueAtTopLevelPatch(props.input, path, next));
                                }}
                                multiline={field?.listSeparator === 'newline'}
                                placeholderTextColor={theme.colors.textSecondary}
                                style={{
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider,
                                    borderRadius: 10,
                                    padding: 10,
                                    ...(field?.listSeparator === 'newline' ? { minHeight: 80 } : {}),
                                    color: theme.colors.text,
                                }}
                            />
                        </View>
                    );
                }

                if (widget === 'textarea' || widget === 'text') {
                    const displayValue = typeof value === 'string' ? value : '';
                    const multiline = widget === 'textarea';
                    return (
                        <View key={path} style={{ marginTop: 10 }}>
                            <Text style={{ color: theme.colors.textSecondary, marginBottom: 6 }}>{label}</Text>
                            <TextInput
                                testID={fieldTestID}
                                editable={props.editable && !disabled}
                                value={displayValue}
                                onChangeText={(text) => props.onPatch(setValueAtTopLevelPatch(props.input, path, text))}
                                multiline={multiline}
                                placeholderTextColor={theme.colors.textSecondary}
                                style={{
                                    borderWidth: 1,
                                    borderColor: theme.colors.divider,
                                    borderRadius: 10,
                                    padding: 10,
                                    ...(multiline ? { minHeight: 80 } : {}),
                                    color: theme.colors.text,
                                }}
                            />
                        </View>
                    );
                }

                return null;
            })}
        </>
    );
}
