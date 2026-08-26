import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { parseOauthCallbackUrl } from '@/utils/auth/oauthCore';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import {
    connectedAccountFieldErrorId,
    useConnectedAccountInvalidFieldFocus,
} from './useConnectedAccountInvalidFieldFocus';
import { useConnectedAccountDraftNavigationGuard } from './useConnectedAccountDraftNavigationGuard';

const stylesheet = StyleSheet.create((theme) => ({
    input: {
        minHeight: 42,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.input.background,
        color: theme.colors.input.text,
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 12,
    },
    section: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    description: {
        marginBottom: 8,
    },
}));

type ConnectedAccountOAuthFormProps = Readonly<{
    authorizationUrl: string;
    callbackUrl: string;
    submitting: boolean;
    navigation?: unknown;
    onSubmit(completion: Readonly<{
        code: string;
        callbackUrl: string;
        state: string;
    }>): Promise<boolean | void> | boolean | void;
}>;

function ConnectedAccountOAuthFormBody(props: ConnectedAccountOAuthFormProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [callbackInput, setCallbackInput] = React.useState('');
    const [validationFailed, setValidationFailed] = React.useState(false);
    const [openFailed, setOpenFailed] = React.useState(false);
    const callbackErrorId = connectedAccountFieldErrorId(
        'connected-account-oauth',
        'callback',
    );
    const callbackInvalidFieldIds = validationFailed ? ['callback'] : [];
    const registerInvalidFieldTarget = useConnectedAccountInvalidFieldFocus({
        invalidFieldIds: callbackInvalidFieldIds,
        announcement: t('connectedServices.oauthPaste.invalidConfig'),
    });

    const submit = React.useCallback(async () => {
        const parsed = parseOauthCallbackUrl({
            url: callbackInput,
            redirectUri: props.callbackUrl,
        });
        if (!parsed.code || !parsed.state || parsed.error) {
            setValidationFailed(true);
            return false;
        }
        const accepted = await props.onSubmit({
            code: parsed.code,
            callbackUrl: props.callbackUrl,
            state: parsed.state,
        });
        return accepted !== false;
    }, [callbackInput, props]);
    const discardDraft = React.useCallback(() => {
        setCallbackInput('');
        setValidationFailed(false);
    }, []);
    useConnectedAccountDraftNavigationGuard({
        navigation: props.navigation,
        isDirty: callbackInput.length > 0,
        onDiscard: discardDraft,
        onSave: submit,
        tag: 'ConnectedAccountOAuthForm',
    });
    const openAuthorizationUrl = React.useCallback(async () => {
        setOpenFailed(false);
        try {
            if (!await openExternalUrl(props.authorizationUrl)) {
                setOpenFailed(true);
            }
        } catch {
            setOpenFailed(true);
        }
    }, [props.authorizationUrl]);

    return (
        <>
            <ItemGroup title={t('connectedServices.oauthPaste.openAuthorizationUrl')}>
                <View style={styles.section}>
                    <Text
                        selectable
                        style={[styles.description, { color: theme.colors.text.secondary }]}
                    >
                        {props.authorizationUrl}
                    </Text>
                    <RoundButton
                        testID="connected-account-oauth:open"
                        title={t('connectedServices.oauthPaste.openAuthorizationUrl')}
                        disabled={props.submitting || !props.authorizationUrl}
                        onPress={() => void openAuthorizationUrl()}
                    />
                    {openFailed ? (
                        <Text
                            testID="connected-account-oauth:open-error"
                            accessibilityRole="alert"
                            accessibilityLiveRegion="assertive"
                            style={[styles.description, { color: theme.colors.text.secondary }]}
                        >
                            {t('connectedServices.oauthPaste.alerts.failedToOpenUrl')}
                        </Text>
                    ) : null}
                </View>
            </ItemGroup>
            <ItemGroup
                title={t('connectedServices.oauthPaste.pasteRedirectUrl')}
                footer={validationFailed ? t('common.error') : undefined}
            >
                <View style={styles.section}>
                    <Text
                        style={[styles.description, { color: theme.colors.text.secondary }]}
                    >
                        {t('connectedServices.oauthPaste.pasteRedirectUrlPromptBody')}
                    </Text>
                    <TextInput
                        testID="connected-account-oauth:callback"
                        ref={registerInvalidFieldTarget('callback')}
                        nativeID="connected-account-oauth:callback"
                        accessibilityLabel={validationFailed
                            ? `${t('connectedServices.oauthPaste.pasteRedirectUrl')}: ${t('connectedServices.oauthPaste.invalidConfig')}`
                            : t('connectedServices.oauthPaste.pasteRedirectUrl')}
                        accessibilityHint={validationFailed
                            ? t('connectedServices.oauthPaste.invalidConfig')
                            : t('connectedServices.oauthPaste.pasteRedirectUrlPromptBody')}
                        value={callbackInput}
                        onChangeText={(value) => {
                            setCallbackInput(value);
                            setValidationFailed(false);
                        }}
                        placeholder={props.callbackUrl}
                        placeholderTextColor={theme.colors.input.placeholder}
                        autoCapitalize="none"
                        autoCorrect={false}
                        editable={!props.submitting}
                        style={styles.input}
                    />
                    {validationFailed ? (
                        <Text
                            testID={callbackErrorId}
                            nativeID={callbackErrorId}
                            accessibilityRole="alert"
                            accessibilityLiveRegion="assertive"
                            style={[styles.description, { color: theme.colors.text.secondary }]}
                        >
                            {t('connectedServices.oauthPaste.invalidConfig')}
                        </Text>
                    ) : null}
                    <RoundButton
                        testID="connected-account-oauth:submit"
                        title={t('common.continue')}
                        disabled={props.submitting || !callbackInput.trim()}
                        loading={props.submitting}
                        onPress={submit}
                    />
                </View>
            </ItemGroup>
        </>
    );
}

/** A changed OAuth redirect contract starts a new callback-paste lifetime. */
export const ConnectedAccountOAuthForm = React.memo(function ConnectedAccountOAuthForm(
    props: ConnectedAccountOAuthFormProps,
) {
    const draftKey = React.useMemo(
        () => JSON.stringify([props.authorizationUrl, props.callbackUrl]),
        [props.authorizationUrl, props.callbackUrl],
    );
    return <ConnectedAccountOAuthFormBody key={draftKey} {...props} />;
});
