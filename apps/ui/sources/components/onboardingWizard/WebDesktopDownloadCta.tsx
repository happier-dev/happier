import * as React from 'react';
import { Linking, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type WebDesktopDownloadCtaProps = Readonly<{
    testIDPrefix: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 10,
        alignItems: 'center',
    },
    button: {
        width: '100%',
        maxWidth: 360,
    },
    title: {
        textAlign: 'center',
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 22,
    },
    subtitle: {
        textAlign: 'center',
        color: theme.colors.textSecondary,
        fontSize: 13,
        lineHeight: 18,
    },
}));

export function WebDesktopDownloadCta(props: WebDesktopDownloadCtaProps) {
    useUnistyles();
    const styles = stylesheet;
    const downloadUrl = 'https://happier.dev/download';
    const openDownload = React.useCallback(() => {
        void Linking.openURL(downloadUrl).catch(() => {});
    }, [downloadUrl]);

    return (
        <View testID={`${props.testIDPrefix}-download-cta`} style={styles.root}>
            <Text style={styles.title}>{t('setupOnboarding.webDesktopOnlyDesktopAppTitle')}</Text>
            <Text style={styles.subtitle}>{t('setupOnboarding.webDesktopOnlyDesktopAppSubtitle')}</Text>
            <RoundButton
                title={t('setupOnboarding.webDesktopOnlyDesktopAppButton')}
                size="normal"
                style={styles.button}
                onPress={openDownload}
                testID={`${props.testIDPrefix}-download-desktop`}
            />
        </View>
    );
}
