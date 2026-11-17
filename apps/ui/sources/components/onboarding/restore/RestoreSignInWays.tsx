import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PairingLinkEntryForm } from '@/components/account/restore/PairingLinkEntryForm';
import { SecretKeyLoginForm } from '@/components/account/restore/SecretKeyLoginForm';
import { StepOrDivider } from '@/components/onboarding/unauthShell/StepFormParts';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { useLoginLeadsWithLink } from './loginWays';

/**
 * Login's one screen (Welcome "Login — I already use Happier": scan a QR code, or enter your secret
 * key). Every way in is open here, each saying what it is: the recovery key (its field and Sign in,
 * the screen's one primary action) and a pairing link from a device that is already signed in (pasted,
 * through this device's camera, or that device scanning a QR shown here). The order follows the
 * device (`useLoginLeadsWithLink`, which the Welcome door's promise reads too). Each way is
 * its existing owner: the shared link form hands a link to the scanner that classifies and enrolls it,
 * and the recovery key is `SecretKeyLoginForm`.
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
    const linkFirst = useLoginLeadsWithLink() || !props.offerSecretKey;
    const pairingLink = (
        <View key="link" style={styles.way}>
            <PairingLinkEntryForm
                embedded
                description={t('connect.signInPairingLinkHelp')}
                onSubmit={props.onSubmitLink}
                autoFocus={linkFirst}
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
    );
    const recoveryKey = props.offerSecretKey
        ? <SecretKeyLoginForm key="key" embedded autoFocus={!linkFirst} />
        : null;
    const or = recoveryKey ? <StepOrDivider key="or" label={t('common.or')} /> : null;
    // Keyed, so a window crossing the phone size reorders the ways without clearing what was typed.
    return (
        <View style={styles.root} testID="restore-sign-in-ways">
            {linkFirst ? [pairingLink, or, recoveryKey] : [recoveryKey, or, pairingLink]}
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
}));
