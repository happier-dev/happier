import * as React from 'react';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import type { SettingsBelowFoldSectionsProps } from '@/components/settings/settingsBelowFoldSectionTypes';
import { OVERVIEW_SETTINGS } from '@/components/settings/overview/overviewSettings';
import { SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';
import { HAPPIER_PRIVACY_POLICY_URL } from '@/constants/legalUrls';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { trackWhatsNewClicked } from '@/track';
import { useReleaseNotesLauncher } from '@/changelog/releaseNotes';
import { requestReview } from '@/utils/system/requestReview';

type SettingsAboutSectionProps = Readonly<Pick<SettingsBelowFoldSectionsProps,
    | 'appVersion'
    | 'handleGitHub'
    | 'handleVersionClick'
    | 'router'
    | 'showChangelog'
    | 'showRateUs'
    | 'supportUs'
>>;

const ABOUT = OVERVIEW_SETTINGS.settings;

export const SettingsAboutSection = React.memo(function SettingsAboutSection({
    appVersion,
    handleGitHub,
    handleVersionClick,
    showChangelog,
    showRateUs,
    supportUs,
}: SettingsAboutSectionProps) {
    const { openWhatsNew } = useReleaseNotesLauncher();
    // What's new, Rate us and Support us are page state (build, store, developer mode): the section answers.
    return (
        <SettingSection section={OVERVIEW_SETTINGS.sectionRefs.about}>
        <ItemGroup title={t('settings.about')} description={t('settingsOverview.aboutDescription')}>
            {showChangelog ? (
                <SettingRow
                    setting={ABOUT.whatsNew}
                    icon={<Icon name="sparkle" />}
                    onPress={() => {
                        trackWhatsNewClicked();
                        openWhatsNew();
                    }}
                />
            ) : null}
            {showRateUs ? (
                <SettingRow
                    setting={ABOUT.rateUs}
                    icon={<Icon name="star" />}
                    onPress={() => {
                        void requestReview();
                    }}
                />
            ) : null}
            {supportUs ? (
                <SettingRow
                    setting={ABOUT.supportUs}
                    subtitle={supportUs.subtitle}
                    showChevron={false}
                    onPress={supportUs.onPress}
                />
            ) : null}
            <SettingRow
                setting={ABOUT.github}
                icon={<Icon name="github-logo" />}
                subtitle="happier-dev/happier"
                onPress={handleGitHub}
            />
            <SettingRow
                setting={ABOUT.privacyPolicy}
                icon={<Icon name="shield-check" />}
                onPress={() => openExternalUrl(HAPPIER_PRIVACY_POLICY_URL)}
            />
            <SettingRow
                setting={ABOUT.termsOfService}
                icon={<Icon name="file-text" />}
                onPress={() => openExternalUrl('https://docs.happier.dev/legal/terms')}
            />
            {settingRendersOnHost(ABOUT.eula) ? (
                <SettingRow
                    setting={ABOUT.eula}
                    icon={<Icon name="file-text" />}
                    onPress={() => openExternalUrl('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')}
                />
            ) : null}
            <SettingRow
                setting={ABOUT.version}
                detail={appVersion}
                onPress={handleVersionClick}
                showChevron={false}
            />
        </ItemGroup>
        </SettingSection>
    );
});
