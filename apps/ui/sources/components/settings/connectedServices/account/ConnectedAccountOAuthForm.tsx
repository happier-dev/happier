import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';
import { parseOauthCallbackUrl } from '@/utils/auth/oauthCore';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

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

export const ConnectedAccountOAuthForm = React.memo(function ConnectedAccountOAuthForm(props: Readonly<{
    authorizationUrl: string;
    callbackUrl: string;
    submitting: boolean;
    onSubmit(completion: Readonly<{
        code: string;
        callbackUrl: string;
        state: string;
    }>): Promise<void> | void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [callbackInput, setCallbackInput] = React.useState('');
    const [validationFailed, setValidationFailed] = React.useState(false);

    const submit = React.useCallback(async () => {
        const parsed = parseOauthCallbackUrl({
            url: callbackInput,
            redirectUri: props.callbackUrl,
        });
        if (!parsed.code || !parsed.state || parsed.error) {
            setValidationFailed(true);
            return;
        }
        await props.onSubmit({
            code: parsed.code,
            callbackUrl: props.callbackUrl,
            state: parsed.state,
        });
    }, [callbackInput, props]);

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
                        onPress={() => {
                            void openExternalUrl(props.authorizationUrl);
                        }}
                    />
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
});
