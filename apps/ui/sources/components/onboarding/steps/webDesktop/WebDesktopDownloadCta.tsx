import * as React from 'react';

import { WelcomeActionCard } from '@/components/onboarding/preAuth/WelcomeActionCard';
import { HAPPIER_DESKTOP_DOWNLOAD_URL } from '@/constants/downloadUrls';
import { t } from '@/text';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

export type WebDesktopDownloadCtaProps = Readonly<{
    testIDPrefix: string;
    label?: string;
}>;

/**
 * The desktop app as the other way to do a step a browser cannot (lab direction A "Create it on the machine itself"):
 * one quiet pill under the centred "or", opening the download page.
 */
export function WebDesktopDownloadCta(props: WebDesktopDownloadCtaProps) {
    return (
        <WelcomeActionCard
            testID={`${props.testIDPrefix}-download-desktop`}
            presentation="pill"
            iconName="download"
            title={props.label ?? t('setupOnboarding.webDesktopOnlyDesktopAppButton')}
            escape
            onPress={() => { void requestOpenExternalUrl(HAPPIER_DESKTOP_DOWNLOAD_URL); }}
        />
    );
}
