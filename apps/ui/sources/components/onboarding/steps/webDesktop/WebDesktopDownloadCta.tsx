import * as React from 'react';
import { Linking, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { HANDOFF_TEXT_MAX_WIDTH } from '@/components/onboarding/ui/handoffLayout';

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
        alignItems: 'flex-start',
        borderWidth: 1,
        borderColor: theme.colors.border.modal,
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        // Tightened (F-W13-2): the setup columns must fit their content at
        // 1440×900 without scrolling for the primary action.
        padding: 16,
    },
    heading: {
        width: '100%',
        gap: 4,
        alignItems: 'flex-start',
    },
    button: {
        width: '100%',
        maxWidth: HANDOFF_TEXT_MAX_WIDTH,
        alignSelf: 'center',
    },
    title: {
        textAlign: 'left',
        color: theme.colors.text.primary,
        fontSize: 16,
        lineHeight: 22,
    },
    subtitle: {
        textAlign: 'left',
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
        maxWidth: HANDOFF_TEXT_MAX_WIDTH,
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
            <View style={styles.heading}>
                <Text style={styles.title}>{props.title ?? t('setupOnboarding.webDesktopOnlyDesktopAppTitle')}</Text>
                {showSubtitle ? (
                    <Text style={styles.subtitle}>{props.subtitle ?? t('setupOnboarding.webDesktopOnlyDesktopAppSubtitle')}</Text>
                ) : null}
            </View>
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
