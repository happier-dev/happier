import * as React from 'react';
import { Linking, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type WebDesktopDownloadCtaProps = Readonly<{
    testIDPrefix: string;
    showSubtitle?: boolean;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 10,
        alignItems: 'center',
    },
    button: {
        width: '100%',
        maxWidth: 220,
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
    const showSubtitle = props.showSubtitle ?? true;
    const openDownload = React.useCallback(() => {
        void Linking.openURL(downloadUrl).catch(() => {});
    }, [downloadUrl]);

    return (
        <View testID={`${props.testIDPrefix}-download-cta`} style={styles.root}>
            <Text style={styles.title}>{props.title ?? t('setupOnboarding.webDesktopOnlyDesktopAppTitle')}</Text>
            {showSubtitle ? (
                <Text style={styles.subtitle}>{props.subtitle ?? t('setupOnboarding.webDesktopOnlyDesktopAppSubtitle')}</Text>
            ) : null}
            <RoundButton
                title={t('setupOnboarding.webDesktopOnlyDesktopAppButton')}
                size="small"
                display="inverted"
                style={styles.button}
                onPress={openDownload}
                testID={`${props.testIDPrefix}-download-desktop`}
            />
        </View>
    );
}
