import * as React from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { AuthEntryOptions } from './useAuthEntryOptions';

export type AuthEntryViewProps = Readonly<{
    layout: 'portrait' | 'landscape';
    isDesktopShell: boolean;
    options: AuthEntryOptions;
    onOpenSetup: () => void;
    onChangeRelay: () => void;
    onRestore: () => void;
    onCreateAccount: () => Promise<void> | void;
    onCreateAccountViaProvider: (providerId: string) => Promise<void> | void;
    onLoginWithKeylessProvider: (providerId: string) => Promise<void> | void;
    onLoginWithMtls: () => Promise<void> | void;
}>;

function wrapAsyncAction(fn: () => Promise<void> | void): () => Promise<void> {
    return async () => {
        await fn();
    };
}

export const AuthEntryView = React.memo(function AuthEntryView(props: AuthEntryViewProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isMobileShell = Platform.OS === 'android' || Platform.OS === 'ios';
    const restoreTitle = isMobileShell ? t('welcome.linkOrRestoreAccount') : t('welcome.loginWithMobileApp');

    const showAuthActions = props.options.serverAvailability === 'ready' || props.options.serverAvailability === 'legacy';
    const showProviderSignup = props.options.showProviderSignup;
    const showAnonymousSignup = props.options.showAnonymousSignup;
    const showMtlsLogin = props.options.showMtlsLogin;
    const mtlsPrimary = props.options.mtlsPrimary;
    const keylessPrimary = props.options.keylessPrimary;
    const providerId = props.options.providerId;
    const keylessProviderId = props.options.keylessProviderId;

    const isLandscape = props.layout === 'landscape';
    const actionStackStyle = isLandscape ? styles.landscapeActionStack : styles.actionStack;
    const smallButtonSize = isLandscape ? 'small' : 'small';
    const normalButtonSize = 'normal';

    const renderServerLoading = () => (
        <View style={styles.serverLoadingBlock}>
            <ActivityIndicator color={theme.colors.text} />
            <Text testID="welcome-server-loading" style={styles.serverLoadingText}>{t('common.loading')}</Text>
        </View>
    );

    const renderServerUnavailable = () => (
        <>
            <View testID="welcome-server-unavailable" style={styles.serverUnavailableBlock}>
                <Text style={styles.serverUnavailableTitle}>
                    {props.options.serverAvailability === 'incompatible' ? t('welcome.serverIncompatibleTitle') : t('welcome.serverUnavailableTitle')}
                </Text>
                <Text style={styles.serverUnavailableBody}>
                    {props.options.serverAvailability === 'incompatible'
                        ? t('welcome.serverIncompatibleBody', { serverUrl: props.options.serverUrlForCopy })
                        : t('welcome.serverUnavailableBody', { serverUrl: props.options.serverUrlForCopy })}
                </Text>
            </View>
            <View style={actionStackStyle}>
                <View style={styles.actionRow}>
                    <RoundButton
                        testID="welcome-configure-server"
                        size={normalButtonSize}
                        title={t('setupOnboarding.changeRelayAction')}
                        onPress={props.onChangeRelay}
                    />
                </View>
            </View>
        </>
    );

    const renderReadyActions = () => (
        <>
            <View style={actionStackStyle}>
                {props.isDesktopShell && (
                    <View style={styles.actionRow}>
                        <RoundButton
                            testID="welcome-open-setup"
                            size={normalButtonSize}
                            title={t('setupOnboarding.openSetupAction')}
                            onPress={props.onOpenSetup}
                            display="inverted"
                        />
                    </View>
                )}
                <View style={styles.actionRow}>
                    <RoundButton
                        testID="welcome-restore"
                        size={normalButtonSize}
                        title={restoreTitle}
                        onPress={props.onRestore}
                    />
                </View>
                {showProviderSignup && (
                    <View style={styles.actionRow}>
                        <RoundButton
                            testID="welcome-signup-provider"
                            size={normalButtonSize}
                            title={props.options.providerSignupTitle}
                            action={wrapAsyncAction(() => props.onCreateAccountViaProvider(providerId!))}
                        />
                    </View>
                )}
                {showMtlsLogin && !mtlsPrimary && (
                    <View style={styles.actionRow}>
                        <RoundButton
                            testID="welcome-mtls-login"
                            size={normalButtonSize}
                            title={props.options.mtlsTitle}
                            action={wrapAsyncAction(props.onLoginWithMtls)}
                        />
                    </View>
                )}
                {showAnonymousSignup && (
                    <View style={styles.actionRow}>
                        <RoundButton
                            testID="welcome-create-account"
                            size={smallButtonSize}
                            title={props.options.anonymousSignupTitle}
                            action={wrapAsyncAction(props.onCreateAccount)}
                            display="inverted"
                        />
                    </View>
                )}
                {!showProviderSignup && !showAnonymousSignup && (
                    <View style={styles.actionRow}>
                        <RoundButton
                            testID="welcome-create-account"
                            size={smallButtonSize}
                            title={props.options.primarySignupTitle}
                            action={
                                mtlsPrimary
                                    ? wrapAsyncAction(props.onLoginWithMtls)
                                    : keylessPrimary && keylessProviderId
                                        ? wrapAsyncAction(() => props.onLoginWithKeylessProvider(keylessProviderId))
                                        : showProviderSignup && providerId
                                            ? wrapAsyncAction(() => props.onCreateAccountViaProvider(providerId))
                                            : wrapAsyncAction(props.onCreateAccount)
                            }
                            display="inverted"
                        />
                    </View>
                )}
            </View>
        </>
    );

    const renderMobileActions = () => (
        <>
            <View style={actionStackStyle}>
                {props.isDesktopShell && (
                    <View style={styles.actionRow}>
                        <RoundButton
                            testID="welcome-open-setup"
                            size={normalButtonSize}
                            title={t('setupOnboarding.openSetupAction')}
                            onPress={props.onOpenSetup}
                            display="inverted"
                        />
                    </View>
                )}
                <View style={styles.actionRow}>
                    <RoundButton
                        testID={showProviderSignup ? 'welcome-signup-provider' : 'welcome-create-account'}
                        size={normalButtonSize}
                        title={props.options.primarySignupTitle}
                        action={
                            mtlsPrimary
                                ? wrapAsyncAction(props.onLoginWithMtls)
                                : keylessPrimary && keylessProviderId
                                    ? wrapAsyncAction(() => props.onLoginWithKeylessProvider(keylessProviderId))
                                    : showProviderSignup && providerId
                                        ? wrapAsyncAction(() => props.onCreateAccountViaProvider(providerId))
                                        : wrapAsyncAction(props.onCreateAccount)
                        }
                    />
                </View>
                {showMtlsLogin && !mtlsPrimary && (
                    <View style={styles.actionRow}>
                        <RoundButton
                            testID="welcome-mtls-login"
                            size={smallButtonSize}
                            title={props.options.mtlsTitle}
                            action={wrapAsyncAction(props.onLoginWithMtls)}
                            display="inverted"
                        />
                    </View>
                )}
                {showProviderSignup && showAnonymousSignup && (
                    <View style={styles.actionRow}>
                        <RoundButton
                            testID="welcome-create-account"
                            size={smallButtonSize}
                            title={props.options.anonymousSignupTitle}
                            action={wrapAsyncAction(props.onCreateAccount)}
                            display="inverted"
                        />
                    </View>
                )}
                <View style={styles.actionRow}>
                    <RoundButton
                        testID="welcome-restore"
                        size={smallButtonSize}
                        title={t('welcome.linkOrRestoreAccount')}
                        onPress={props.onRestore}
                        display="inverted"
                    />
                </View>
            </View>
        </>
    );

    if (props.options.serverAvailability === 'loading') {
        return renderServerLoading();
    }

    if (props.options.serverAvailability === 'unavailable' || props.options.serverAvailability === 'incompatible') {
        return renderServerUnavailable();
    }

    if (!showAuthActions) {
        return null;
    }

    return (
        <>
            {isMobileShell ? renderMobileActions() : renderReadyActions()}
        </>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    serverUnavailableBlock: {
        width: '100%',
        maxWidth: 560,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 10,
    },
    serverUnavailableTitle: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: theme.colors.text,
    },
    serverUnavailableBody: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginTop: 6,
        lineHeight: 20,
    },
    serverLoadingBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingVertical: 18,
    },
    serverLoadingText: {
        ...Typography.default(),
        fontSize: 15,
        color: theme.colors.textSecondary,
    },
    actionStack: {
        width: '100%',
        maxWidth: 360,
        gap: 10,
    },
    actionRow: {
        width: '100%',
    },
    landscapeActionStack: {
        width: '100%',
        maxWidth: 360,
        alignSelf: 'center',
        gap: 10,
    },
}));
