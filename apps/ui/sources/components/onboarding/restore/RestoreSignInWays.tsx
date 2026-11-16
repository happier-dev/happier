import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PairingLinkEntryForm } from '@/components/account/restore/PairingLinkEntryForm';
import { SecretKeyLoginForm } from '@/components/account/restore/SecretKeyLoginForm';
import { StepFieldGroup, StepFieldHelp, StepFieldLabel, StepOrDivider } from '@/components/onboarding/unauthShell/StepFormParts';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/**
 * Login's one screen (Welcome "Login — I already use Happier": scan a QR code, or enter your secret
 * key). Every way in sits here, each saying what it is: a pairing link from a device that is already
 * signed in (or that device's QR code, through this device's camera or shown here for it to scan), and
 * the recovery key, which opens in place. Each way is its existing owner: the shared link form hands a
 * link to the scanner that classifies and enrolls it, and the secret key is `SecretKeyLoginForm`.
 */
export function RestoreSignInWays(props: Readonly<{
    onSubmitLink: (link: string) => Promise<boolean>;
    /** This device's camera, when it has one. */
    onOpenScanner?: () => void;
    /** A QR code shown here for a signed-in device to scan, when this device knows its Home. */
    onShowQr?: () => void;
    /** Signing in with an Account's recovery key; absent when the step adds a Home instead. */
    offerSecretKey: boolean;
}>) {
    const { theme } = useUnistyles();
    const [secretKeyOpen, setSecretKeyOpen] = React.useState(false);
    return (
        <View style={styles.root} testID="restore-sign-in-ways">
            <View style={styles.way}>
                <PairingLinkEntryForm
                    embedded
                    description={t('connect.signInPairingLinkHelp')}
                    onSubmit={props.onSubmitLink}
                    autoFocus={!secretKeyOpen}
                    emptyAction={props.onOpenScanner ? (
                        <RoundButton
                            testID="restore-sign-in-use-camera"
                            size="normal"
                            display="secondary"
                            title={t('homesJourneys.useCamera')}
                            leading={<Icon name="camera" size={14} color={theme.colors.text.secondary} />}
                            onPress={props.onOpenScanner}
                        />
                    ) : undefined}
                />
                {props.onShowQr ? (
                    <View style={styles.quietAction}>
                        <TextLinkButton testID="restore-sign-in-show-qr" label={t('connect.signInShowQr')} onPress={props.onShowQr} />
                    </View>
                ) : null}
            </View>
            {props.offerSecretKey ? (
                <>
                    <StepOrDivider label={t('common.or')} />
                    {secretKeyOpen ? (
                        <SecretKeyLoginForm embedded />
                    ) : (
                        <StepFieldGroup>
                            <StepFieldLabel>{t('connect.secretKeyInputLabel')}</StepFieldLabel>
                            <View style={styles.row}>
                                <View style={styles.rowCopy}>
                                    <StepFieldHelp>{t('connect.signInSecretKeyHelp')}</StepFieldHelp>
                                </View>
                                <RoundButton
                                    testID="restore-sign-in-secret-key"
                                    size="normal"
                                    display="secondary"
                                    title={t('connect.signInSecretKeyAction')}
                                    leading={<Icon name="key" size={14} color={theme.colors.text.secondary} />}
                                    onPress={() => setSecretKeyOpen(true)}
                                />
                            </View>
                        </StepFieldGroup>
                    )}
                </>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: theme.space.s24,
    },
    way: {
        width: '100%',
        gap: theme.space.s8,
    },
    quietAction: {
        alignItems: 'flex-start',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    rowCopy: {
        flex: 1,
        minWidth: 0,
    },
}));
