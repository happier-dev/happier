import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SecretKeyLoginForm } from '@/components/account/restore/SecretKeyLoginForm';

export const SecretKeyLoginEmbedded = React.memo(function SecretKeyLoginEmbedded() {
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <SecretKeyLoginForm embedded />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: 'transparent',
    },
}));
