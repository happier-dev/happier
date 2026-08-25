import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { PluginSettingFieldV2 } from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { resolveProjectedLocalizedText } from '@/components/plugins/surfaces/resolvePluginDisplayString';

const stylesheet = StyleSheet.create((theme) => ({
    field: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
        marginBottom: 4,
    },
    description: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
        marginBottom: 8,
    },
    input: {
        ...Typography.default(),
        minHeight: 44,
        borderRadius: 10,
        borderCurve: 'continuous',
        borderWidth: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
    },
    multilineInput: {
        minHeight: 88,
        textAlignVertical: 'top',
    },
    actions: {
        alignItems: 'flex-end',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
}));

type ManualAuthenticationField =
    & Omit<PluginSettingFieldV2, 'secret'>
    & Readonly<{ secret?: boolean }>;

function compareFields(left: ManualAuthenticationField, right: ManualAuthenticationField): number {
    const leftOrder = left.presentation?.order ?? Number.POSITIVE_INFINITY;
    const rightOrder = right.presentation?.order ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.id.localeCompare(right.id);
}

function isValidFieldValue(field: ManualAuthenticationField, value: string): boolean {
    const schema = field.schema;
    if (schema.type !== undefined && schema.type !== 'string') return false;
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    if (schema.enum !== undefined && !schema.enum.includes(value)) return false;
    if (schema.const !== undefined && schema.const !== value) return false;
    if (schema.pattern !== undefined) {
        try {
            if (!new RegExp(schema.pattern).test(value)) return false;
        } catch {
            return false;
        }
    }
    return true;
}

export const ConnectedAccountManualForm = React.memo(function ConnectedAccountManualForm(props: Readonly<{
    title: string;
    localize?: (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => string;
    fields: readonly ManualAuthenticationField[];
    submitting: boolean;
    onSubmit(input: Readonly<{
        fields: Readonly<Record<string, string>>;
    }>): Promise<void> | void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [draft, setDraft] = React.useState<Readonly<Record<string, string>>>(() => (
        Object.fromEntries(props.fields.map((field) => [field.id, '']))
    ));
    const [validationFailed, setValidationFailed] = React.useState(false);

    const fields = React.useMemo(
        () => [...props.fields]
            .filter((field) => field.presentation?.hidden !== true)
            .sort(compareFields),
        [props.fields],
    );
    const submit = React.useCallback(async () => {
        const values = Object.fromEntries(
            props.fields.map((field) => [field.id, draft[field.id] ?? '']),
        );
        if (props.fields.some((field) => !isValidFieldValue(field, values[field.id] ?? ''))) {
            setValidationFailed(true);
            return;
        }
        await props.onSubmit({ fields: values });
    }, [draft, props]);

    return (
        <ItemGroup
            title={props.title}
            footer={validationFailed ? t('common.error') : undefined}
        >
            {fields.map((field) => {
                const title = resolveProjectedLocalizedText(field.title, props.localize);
                const description = resolveProjectedLocalizedText(field.description, props.localize);
                const multiline = field.presentation?.control === 'textarea';
                return (
                    <View key={field.id} style={styles.field}>
                        <Text style={styles.label}>{title}</Text>
                        {description ? <Text style={styles.description}>{description}</Text> : null}
                        <TextInput
                            testID={`connected-account-manual:${field.id}`}
                            accessibilityLabel={title}
                            value={draft[field.id] ?? ''}
                            onChangeText={(value) => {
                                setDraft((current) => ({ ...current, [field.id]: value }));
                                setValidationFailed(false);
                            }}
                            editable={!props.submitting}
                            secureTextEntry={field.secret === true}
                            multiline={multiline}
                            autoCapitalize="none"
                            autoCorrect={false}
                            placeholder={resolveProjectedLocalizedText(field.presentation?.placeholder, props.localize)}
                            placeholderTextColor={theme.colors.input.placeholder}
                            style={[
                                styles.input,
                                multiline ? styles.multilineInput : undefined,
                                {
                                    color: theme.colors.input.text,
                                    backgroundColor: theme.colors.input.background,
                                    borderColor: theme.colors.border.default,
                                },
                            ]}
                        />
                    </View>
                );
            })}
            <View style={styles.actions}>
                <RoundButton
                    testID="connected-account-manual:submit"
                    title={t('common.continue')}
                    disabled={props.submitting}
                    loading={props.submitting}
                    onPress={submit}
                />
            </View>
        </ItemGroup>
    );
});
