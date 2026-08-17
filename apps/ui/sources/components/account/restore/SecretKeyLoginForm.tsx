import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from 'expo-router';

import {
    useAuth,
    type AuthCredentialLifecycleResult,
} from '@/auth/context/AuthContext';
import { authGetToken } from '@/auth/flows/getToken';
import { normalizeSecretKey } from '@/auth/recovery/secretKeyBackup';
import { decodeBase64 } from '@/encryption/base64';
import { Modal } from '@/modal';
import {
    activateStackRuntimeServer,
    readStackRuntimeServerUrl,
} from '@/sync/domains/server/stackRuntimeServer';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text, TextInput } from '@/components/ui/text/Text';
import { trackAccountRestored } from '@/track';
import { Icon } from '@/components/ui/icons/Icon';
import {
    presentFirstKeyCredentialLifecycle,
} from '@/components/account/presentFirstKeyCredentialLifecycle';
import {
    guardAccountEncryptionFirstKeyCredentialMutation,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';

async function guardStackAuthIngress(
): Promise<AuthCredentialLifecycleResult> {
    const current =
        await guardAccountEncryptionFirstKeyCredentialMutation();
    if (current.kind !== 'allowed') return current;
    const stackServerUrl = readStackRuntimeServerUrl();
    if (!stackServerUrl) return { kind: 'completed' };
    const target =
        await guardAccountEncryptionFirstKeyCredentialMutation({
            serverUrl: stackServerUrl,
        });
    return target.kind === 'allowed'
        ? { kind: 'completed' }
        : target;
}

export type SecretKeyLoginFormProps = Readonly<{
    embedded?: boolean;
    onSuccess?: () => void;
    submitTitle?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    noticeCard: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 14,
        backgroundColor: theme.colors.surface.base,
        marginBottom: 16,
    },
    noticeText: {
        fontSize: 16,
        color: theme.colors.text.secondary,
        lineHeight: 24,
        ...Typography.default(),
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        padding: 16,
        paddingRight: 52,
        borderRadius: 14,
        ...Typography.mono(),
        fontSize: 14,
        lineHeight: 20,
        minHeight: 54,
        color: theme.colors.input.text,
    },
    textInputWrapper: {
        width: '100%',
        position: 'relative',
        marginBottom: 24,
    },
    revealButton: {
        position: 'absolute',
        right: 10,
        top: 0,
        bottom: 0,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 8,
    },
}));

export const SecretKeyLoginForm = React.memo(function SecretKeyLoginForm(props: SecretKeyLoginFormProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const auth = useAuth();
    const router = useRouter();

    const [secretKey, setSecretKey] = React.useState('');
    const [revealed, setRevealed] = React.useState(false);

    const handleSuccess = React.useCallback(() => {
        if (props.onSuccess) {
            props.onSuccess();
            return;
        }
        router.dismissTo('/');
    }, [props.onSuccess, router]);

    const handleLogin = React.useCallback(async () => {
        const trimmedKey = secretKey.trim();
        if (!trimmedKey) {
            Modal.alert(t('common.error'), t('connect.enterSecretKey'));
            return;
        }

        try {
            let mayActivateStack = false;
            await presentFirstKeyCredentialLifecycle({
                run: guardStackAuthIngress,
                onCompleted: () => {
                    mayActivateStack = true;
                },
            });
            if (!mayActivateStack) return;

            const normalizedKey = normalizeSecretKey(trimmedKey);
            const secretBytes = decodeBase64(normalizedKey, 'base64url');
            if (secretBytes.length !== 32) {
                throw new Error('Invalid secret key length');
            }

            activateStackRuntimeServer({ scope: 'device' });

            const token = await authGetToken(secretBytes);
            if (!token) {
                throw new Error('Failed to authenticate with provided key');
            }

            await presentFirstKeyCredentialLifecycle({
                run: async () =>
                    await auth.login(token, normalizedKey),
                onCompleted: () => {
                    trackAccountRestored();
                    handleSuccess();
                },
            });
        } catch {
            Modal.alert(t('common.error'), t('connect.invalidSecretKey'));
        }
    }, [auth, handleSuccess, secretKey]);

    return (
        <>
            <View style={styles.noticeCard}>
                <Text style={styles.noticeText}>{t('connect.restoreWithSecretKeyDescription')}</Text>
            </View>

            <View style={styles.textInputWrapper}>
                <TextInput
                    testID="restore-manual-secret-input"
                    accessibilityLabel={t('connect.secretKeyInputLabel')}
                    style={styles.textInput}
                    placeholder={t('connect.secretKeyPlaceholder')}
                    placeholderTextColor={theme.colors.input.placeholder}
                    value={secretKey}
                    onChangeText={setSecretKey}
                    secureTextEntry={!revealed}
                    autoCapitalize="none"
                    autoCorrect={false}
                    multiline={false}
                />

                <Pressable
                    testID="restore-manual-secret-reveal"
                    accessibilityRole="button"
                    accessibilityLabel={revealed ? t('settingsAccount.tapToHide') : t('settingsAccount.tapToReveal')}
                    onPress={() => setRevealed((v) => !v)}
                    style={styles.revealButton}
                    hitSlop={10}
                >
                    <Icon
                        name={revealed ? 'eye-slash' : 'eye'}
                        size={20}
                        color={theme.colors.text.secondary}
                    />
                </Pressable>
            </View>

            <RoundButton
                testID="restore-manual-submit"
                title={props.submitTitle ?? t('connect.restoreAccount')}
                action={handleLogin}
            />
        </>
    );
});
