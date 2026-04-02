import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SecretKeyLoginForm } from '@/components/account/restore/SecretKeyLoginForm';
import { t } from '@/text';

export const SecretKeyLoginEmbedded = React.memo(function SecretKeyLoginEmbedded() {
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <SecretKeyLoginForm embedded submitTitle={t('common.login')} />
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        backgroundColor: 'transparent',
    },
}));
