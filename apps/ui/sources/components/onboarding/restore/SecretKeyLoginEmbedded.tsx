import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SecretKeyLoginForm } from '@/components/account/restore/SecretKeyLoginForm';
import { WizardAuthReturnRouteContext } from '@/components/onboarding/state/wizardResume';
import { t } from '@/text';

const leaveArrivalToRootGate = () => {};

/** The welcome's recovery-key step: the key, Sign in, and "Lost your key?" when the step offers that way. */
export const SecretKeyLoginEmbedded = React.memo(function SecretKeyLoginEmbedded(props: Readonly<{ onLostKey?: () => void }>) {
    const styles = stylesheet;
    const rootAuthReturn = React.useContext(WizardAuthReturnRouteContext);

    return (
        <View style={styles.container}>
            <SecretKeyLoginForm
                embedded
                // The auth commit wakes the root gate that owns this attempt's destination.
                onAuthenticated={rootAuthReturn ? leaveArrivalToRootGate : undefined}
                secondaryAction={props.onLostKey
                    ? { label: t('connect.lostYourKey'), onPress: props.onLostKey, testID: 'restore-open-lost-access' }
                    : undefined}
            />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: 'transparent',
    },
}));
