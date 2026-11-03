import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AccountServiceEndpointV1 } from '@/sync/domains/server/serverProfiles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { OrganizationPolicyFieldNotice, readOrganizationPolicyFieldState } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { Text, TextInput } from '@/components/ui/text/Text';
import { WizardChoiceRow } from '@/components/onboarding/ui/WizardChoiceRow';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { SelectAccountServiceEndpointResult } from '@/sync/ops/accountDirectory/selectAccountServiceEndpoint';
import { formatAccountServiceHost } from '@/sync/domains/accountDirectory/accountDirectoryEndpoint';
import { readAccountServiceDisplayName } from './accountServiceDisplayName';
import { useAccountServiceSelection } from './useAccountServiceSelection';

export type AccountServiceSelectionResult = SelectAccountServiceEndpointResult;

export type AccountServiceSelectionFormProps = Readonly<{
    currentEndpoint: AccountServiceEndpointV1 | null;
    onBack: () => void;
    onSelect: (url: string, options: Readonly<{ signal: AbortSignal }>) => Promise<AccountServiceSelectionResult>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: theme.space.s16 },
    choices: { gap: theme.space.s10 },
    field: { gap: theme.space.s8 },
    label: { color: theme.colors.text.primary, ...Typography.variant('label', 'semiBold'),   },
    input: {
        minHeight: 54,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        fontSize: 16,
        lineHeight: 22,
        ...Typography.default(),
    },
    error: { color: theme.colors.state.danger.foreground, fontSize: 14, lineHeight: 20, ...Typography.default() },
    actions: { gap: theme.space.s12 },
}));

/** A choice row: the service's name, else the address that tells it apart (shown beneath too). */
function endpointLabel(endpoint: AccountServiceEndpointV1): string {
    return readAccountServiceDisplayName({
        url: endpoint.url,
        serverIdentityId: endpoint.serverIdentityId,
        savedName: endpoint.displayName,
    }) ?? formatAccountServiceHost(endpoint.url);
}

export const AccountServiceSelectionForm = React.memo(function AccountServiceSelectionForm(props: AccountServiceSelectionFormProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const policy = readOrganizationPolicyFieldState('accountService');
    const inputRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const currentEndpoint = props.currentEndpoint?.url ? props.currentEndpoint : null;
    const [showUrlInput, setShowUrlInput] = React.useState(currentEndpoint == null);
    const [url, setUrl] = React.useState('');
    const selection = useAccountServiceSelection(props.onSelect);
    const error = selection.error;

    const select = React.useCallback(async (rawUrl: string) => {
        const result = await selection.submit(rawUrl);
        if (result?.kind === 'selected') return;
        if (result || !rawUrl.trim()) {
            setShowUrlInput(true);
            inputRef.current?.focus();
        }
    }, [selection.submit]);

    const goBack = React.useCallback(() => {
        selection.cancel();
        props.onBack();
    }, [props.onBack, selection.cancel]);

    return (
        <View testID="account-service-selection-form" style={styles.root}>
            <OrganizationPolicyFieldNotice field="accountService" />
            <View style={styles.choices}>
                {currentEndpoint ? (
                    <WizardChoiceRow
                        testID="account-service-current-choice"
                        disabled={policy.disabled}
                        selected={false}
                        icon="globe"
                        title={endpointLabel(currentEndpoint)}
                        subtitle={currentEndpoint.url}
                        onPress={() => select(currentEndpoint.url)}
                    />
                ) : null}
                <WizardChoiceRow
                    testID="account-service-another-choice"
                    disabled={policy.disabled}
                    selected={showUrlInput}
                    icon="plus-circle"
                    title={t('homeAdd.otherSignInService')}
                    subtitle={t('homeAdd.otherSignInServiceSubtitle')}
                    onPress={() => {
                        setShowUrlInput(true);
                    }}
                />
            </View>
            {showUrlInput ? (
                <View style={styles.field}>
                    <Text style={styles.label}>{t('homeAdd.signInServiceAddress')}</Text>
                    <TextInput
                        ref={inputRef}
                        testID="account-service-url-input"
                        accessibilityLabel={t('homeAdd.signInServiceAddress')}
                        editable={!policy.disabled}
                        accessibilityState={{ disabled: policy.disabled }}
                        accessibilityHint={policy.accessibilityHint}
                        style={styles.input}
                        placeholder={t('common.urlPlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={url}
                        onChangeText={(value) => {
                            setUrl(value);
                            if (error) selection.clearError();
                        }}
                        onSubmitEditing={policy.disabled ? undefined : () => {
                            void select(url);
                        }}
                        autoFocus={!policy.disabled && props.currentEndpoint == null}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        returnKeyType="go"
                    />
                    {error ? <Text testID="account-service-url-error" accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
                </View>
            ) : null}
            <View style={styles.actions}>
                {showUrlInput ? (
                    <RoundButton testID="account-service-url-submit" title={t('common.continue')} disabled={policy.disabled} action={() => select(url)} />
                ) : null}
                <RoundButton testID="account-service-selection-back" title={t('common.back')} display="inverted" onPress={goBack} />
            </View>
        </View>
    );
});
