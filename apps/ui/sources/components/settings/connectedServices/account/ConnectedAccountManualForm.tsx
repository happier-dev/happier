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

import {
    connectedAccountFieldErrorId,
    useConnectedAccountInvalidFieldFocus,
} from './useConnectedAccountInvalidFieldFocus';
import { useConnectedAccountDraftNavigationGuard } from './useConnectedAccountDraftNavigationGuard';

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

type ConnectedAccountManualFormProps = Readonly<{
    title: string;
    localize?: (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => string;
    fields: readonly ManualAuthenticationField[];
    submitting: boolean;
    navigation?: unknown;
    onSubmit(input: Readonly<{
        fields: Readonly<Record<string, string>>;
    }>): Promise<boolean | void> | boolean | void;
}>;

function ConnectedAccountManualFormBody(props: ConnectedAccountManualFormProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const initialDraft = React.useMemo(() => (
        Object.fromEntries(props.fields.map((field) => [field.id, '']))
    ), [props.fields]);
    const [draft, setDraft] = React.useState<Readonly<Record<string, string>>>(() => (
        initialDraft
    ));
    const [invalidFieldIds, setInvalidFieldIds] = React.useState<readonly string[]>([]);

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
        const invalid = fields
            .filter((field) => !isValidFieldValue(field, values[field.id] ?? ''))
            .map((field) => field.id);
        if (invalid.length > 0) {
            setInvalidFieldIds(invalid);
            return false;
        }
        const accepted = await props.onSubmit({ fields: values });
        return accepted !== false;
    }, [draft, fields, props]);
    const discardDraft = React.useCallback(() => {
        setDraft(initialDraft);
        setInvalidFieldIds([]);
    }, [initialDraft]);
    const isDirty = props.fields.some((field) => (
        (draft[field.id] ?? '') !== (initialDraft[field.id] ?? '')
    ));
    useConnectedAccountDraftNavigationGuard({
        navigation: props.navigation,
        isDirty,
        onDiscard: discardDraft,
        onSave: submit,
        tag: 'ConnectedAccountManualForm',
    });
    const registerInvalidFieldTarget = useConnectedAccountInvalidFieldFocus({
        invalidFieldIds,
        announcement: t('common.error'),
    });

    return (
        <ItemGroup
            title={props.title}
            footer={invalidFieldIds.length > 0 ? t('common.error') : undefined}
        >
            {fields.map((field) => {
                const title = resolveProjectedLocalizedText(field.title, props.localize);
                const description = resolveProjectedLocalizedText(field.description, props.localize);
                const multiline = field.presentation?.control === 'textarea';
                const invalid = invalidFieldIds.includes(field.id);
                const errorId = connectedAccountFieldErrorId(
                    'connected-account-manual',
                    field.id,
                );
                return (
                    <View key={field.id} style={styles.field}>
                        <Text style={styles.label}>{title}</Text>
                        {description ? <Text style={styles.description}>{description}</Text> : null}
                        <TextInput
                            testID={`connected-account-manual:${field.id}`}
                            ref={registerInvalidFieldTarget(field.id)}
                            nativeID={`connected-account-manual:${field.id}`}
                            accessibilityLabel={invalid ? `${title}: ${t('common.error')}` : title}
                            accessibilityHint={invalid
                                ? t('common.error')
                                : description || undefined}
                            value={draft[field.id] ?? ''}
                            onChangeText={(value) => {
                                setDraft((current) => ({ ...current, [field.id]: value }));
                                setInvalidFieldIds((current) => current.filter((id) => id !== field.id));
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
                        {invalid ? (
                            <Text
                                testID={errorId}
                                nativeID={errorId}
                                accessibilityRole="alert"
                                accessibilityLiveRegion="assertive"
                                style={styles.description}
                            >
                                {t('common.error')}
                            </Text>
                        ) : null}
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
}

/**
 * Manual credential fields can change while the route stays mounted (for
 * example after a daemon descriptor refresh). A semantic descriptor key gives
 * the form a fresh local lifetime, so no secret draft survives into a new mode.
 */
export const ConnectedAccountManualForm = React.memo(function ConnectedAccountManualForm(
    props: ConnectedAccountManualFormProps,
) {
    const draftKey = React.useMemo(() => JSON.stringify(props.fields), [props.fields]);
    return <ConnectedAccountManualFormBody key={draftKey} {...props} />;
});
