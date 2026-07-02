import { Platform, Linking } from 'react-native';
import * as React from 'react';

import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { trackWhatsNewClicked } from '@/track';
import { requestReview } from '@/utils/system/requestReview';

type SettingsAboutSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'appVersion'
    | 'handleGitHub'
    | 'handleReportIssue'
    | 'handleVersionClick'
    | 'router'
    | 'showChangelog'
    | 'showRateUs'
    | 'theme'
>>;

export const SettingsAboutSection = React.memo(function SettingsAboutSection({
    appVersion,
    handleGitHub,
    handleReportIssue,
    handleVersionClick,
    router,
    showChangelog,
    showRateUs,
    theme,
}: SettingsAboutSectionProps) {
    return (
        <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
            {showChangelog ? (
                <Item
                    title={t('settings.whatsNew')}
                    subtitle={t('settings.whatsNewSubtitle')}
                    icon={<SafeIonicons name="sparkles-outline" size={29} color={theme.colors.accent.orange} />}
                    onPress={() => {
                        trackWhatsNewClicked();
                        router.push('/(app)/changelog');
                    }}
                />
            ) : null}
            {showRateUs ? (
                <Item
                    title={t('settings.rateUs')}
                    subtitle={t('settings.rateUsSubtitle')}
                    icon={<SafeIonicons name="star-outline" size={29} color={theme.colors.accent.orange} />}
                    onPress={() => {
                        void requestReview();
                    }}
                />
            ) : null}
            <Item
                title={t('settings.github')}
                icon={<SafeIonicons name="logo-github" size={29} color={theme.colors.text.primary} />}
                subtitle="happier-dev/happier"
                onPress={handleGitHub}
            />
            <Item
                title={t('settings.reportIssue')}
                icon={<SafeIonicons name="bug-outline" size={29} color={theme.colors.state.danger.foreground} />}
                onPress={handleReportIssue}
            />
            <Item
                title={t('settings.privacyPolicy')}
                icon={<SafeIonicons name="shield-checkmark-outline" size={29} color={theme.colors.accent.blue} />}
                onPress={async () => {
                    const url = 'https://docs.happier.dev/legal/privacy';
                    const supported = await Linking.canOpenURL(url);
                    if (supported) {
                        await Linking.openURL(url);
                    }
                }}
            />
            <Item
                title={t('settings.termsOfService')}
                icon={<SafeIonicons name="document-text-outline" size={29} color={theme.colors.accent.blue} />}
                onPress={async () => {
                    const url = 'https://docs.happier.dev/legal/terms';
                    const supported = await Linking.canOpenURL(url);
                    if (supported) {
                        await Linking.openURL(url);
                    }
                }}
            />
            {Platform.OS === 'ios' ? (
                <Item
                    title={t('settings.eula')}
                    icon={<SafeIonicons name="document-text-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={async () => {
                        const url = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
                        const supported = await Linking.canOpenURL(url);
                        if (supported) {
                            await Linking.openURL(url);
                        }
                    }}
                />
            ) : null}
            <Item
                title={t('common.version')}
                detail={appVersion}
                icon={<SafeIonicons name="information-circle-outline" size={29} color={theme.colors.text.secondary} />}
                onPress={handleVersionClick}
                showChevron={false}
            />
        </ItemGroup>
    );
});
