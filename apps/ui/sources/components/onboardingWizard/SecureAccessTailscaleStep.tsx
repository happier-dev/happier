import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { LocalTailscaleSecureAccessSection } from '@/components/settings/server/localControl/LocalTailscaleSecureAccessSection';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 12,
    },
    hint: {
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

export function SecureAccessTailscaleStep() {
    const styles = stylesheet;
    const snapshot = getActiveServerSnapshot();
    const upstreamUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim().replace(/\/+$/, '') : null;

    return (
        <View style={styles.root}>
            <Text style={styles.hint}>{t('settings.localTailscale.footer')}</Text>
            <LocalTailscaleSecureAccessSection upstreamUrl={upstreamUrl} />
        </View>
    );
}
