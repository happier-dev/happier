import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { Text } from '@/components/ui/text/Text';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { resolveThemeSurfaceChromeStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import type { ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import {
    ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX,
    ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX,
} from '@/components/ui/lists/itemGroupSpacing';

export const ThemeProfilePreviewPane = React.memo(function ThemeProfilePreviewPane(props: Readonly<{
    profile: ThemeProfileV1;
    mode: ThemeProfileMode;
}>) {
    const previewTheme = React.useMemo(() => resolveThemeProfile({ mode: props.mode, profile: props.profile }), [props.mode, props.profile]);
    const previewCardChromeStyle = React.useMemo(() => resolveThemeSurfaceChromeStyle({
        borderColor: previewTheme.colors.border.surface,
        highlightColor: previewTheme.colors.effect.surfaceHighlight,
        shadowStyle: shadowLevelStyle(previewTheme.colors.shadowLevels[1]),
    }), [previewTheme]);
    const styles = stylesheet;
    const maxWidth = useLayoutMaxWidth();

    return (
        <View style={styles.previewWrapper}>
            <View style={[styles.previewContainer, { maxWidth }]}>
                <View testID="settings-theme-profile-preview" style={[styles.previewCanvas, { backgroundColor: previewTheme.colors.background.canvas }]}>
                    <View style={[
                        styles.previewCard,
                        {
                            backgroundColor: previewTheme.colors.surface.base,
                            ...previewCardChromeStyle,
                        },
                    ]}>
                        <Eyebrow style={{ color: previewTheme.colors.text.secondary }}>{t('settingsAppearance.themeProfiles.previewTitle')}</Eyebrow>
                        <Text style={[styles.previewSubtitle, { color: previewTheme.colors.text.secondary }]}>{t('settingsAppearance.themeProfiles.previewSubtitle')}</Text>
                        <View style={styles.previewRow}>
                            <View style={[styles.primaryButton, { backgroundColor: previewTheme.colors.button.primary.background }]}>
                                <Text style={[styles.primaryButtonText, { color: previewTheme.colors.button.primary.tint }]}>
                                    {t('settingsAppearance.themeProfiles.previewButton')}
                                </Text>
                            </View>
                            <StatusPill
                                testID="settings-theme-profile-preview-status"
                                variant="success"
                                label={t('settingsAppearance.themeProfiles.previewStatus')}
                                foregroundColor={previewTheme.colors.state.success.foreground}
                                dotColor={previewTheme.colors.state.success.foreground}
                                style={{
                                    backgroundColor: previewTheme.colors.state.success.background,
                                    borderColor: previewTheme.colors.state.success.border,
                                }}
                            />
                        </View>
                        <Text style={[styles.codeSample, { color: previewTheme.colors.syntax.keyword, backgroundColor: previewTheme.colors.surface.inset }]}>
                            {t('settingsAppearance.themeProfiles.previewCode')}
                        </Text>
                    </View>
                </View>
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    previewWrapper: {
        alignItems: 'center',
    },
    previewContainer: {
        width: '100%',
        paddingHorizontal: Platform.select(ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX),
    },
    previewCanvas: {
        marginHorizontal: Platform.select(ITEM_GROUP_CONTENT_MARGIN_HORIZONTAL_PX),
        marginVertical: 12,
        borderRadius: 18,
        padding: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    previewCard: {
        borderRadius: 14,
        padding: 14,
        gap: 10,
    },
    previewSubtitle: {
        fontSize: 13,
    },
    previewRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
    },
    primaryButton: {
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
    },
    primaryButtonText: {
        fontSize: 13,
        fontWeight: '700',
    },
    codeSample: {
        borderRadius: 10,
        padding: 10,
        fontSize: 12,
    },
}));
