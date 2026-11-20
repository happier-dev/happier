import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SecretKeyLoginForm } from '@/components/account/restore/SecretKeyLoginForm';
import { t } from '@/text';

/** The welcome's recovery-key step: the key, Sign in, and "Lost your key?" when the step offers that way. */
export const SecretKeyLoginEmbedded = React.memo(function SecretKeyLoginEmbedded(props: Readonly<{ onLostKey?: () => void }>) {
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <SecretKeyLoginForm
                embedded
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
