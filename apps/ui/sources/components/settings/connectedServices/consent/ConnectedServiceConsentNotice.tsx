import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { resolveConnectedServicePoolConsentPolicy } from '@happier-dev/agents';
import type { ConnectedServiceId } from '@happier-dev/protocol';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useLocalSettingMutable } from '@/sync/store/hooks';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

/**
 * The one-time notice for a service whose provider declares consent-gated account reads, shown
 * where consent is given (pool creation, the agent's account-status setting) until acknowledged on
 * this device. The copy names Google: every provider declaring consent today is a Google service;
 * a non-Google declaration needs its own notice text.
 */
export const ConnectedServiceConsentNotice = React.memo(function ConnectedServiceConsentNotice(props: Readonly<{
    serviceId: ConnectedServiceId;
}>) {
    const { theme } = useUnistyles();
    const policy = resolveConnectedServicePoolConsentPolicy(props.serviceId);
    const [dismissed, setDismissed] = useLocalSettingMutable('connectedServiceConsentNoticeDismissedServiceIds');
    const learnMoreUrl = policy.learnMoreUrl;
    const testID = `connected-services-consent-notice:${props.serviceId}`;
    const onLearnMore = React.useCallback(() => {
        if (learnMoreUrl) void openExternalUrl(learnMoreUrl);
    }, [learnMoreUrl]);
    const onDismiss = React.useCallback(() => {
        if (!dismissed.includes(props.serviceId)) setDismissed([...dismissed, props.serviceId]);
    }, [dismissed, props.serviceId, setDismissed]);

    if (!policy.required || dismissed.includes(props.serviceId)) return null;
    return (
        <ItemGroup>
            <Item
                testID={testID}
                title={t('connectedServices.accountStatusConsent.noticeTitle')}
                subtitle={t('connectedServices.accountStatusConsent.noticeBody')}
                subtitleLines={0}
                icon={<Icon name="info" size={20} color={theme.colors.text.secondary} />}
                showChevron={false}
            />
            {learnMoreUrl ? (
                <Item
                    testID={`${testID}:learn-more`}
                    title={t('connectedServices.accountStatusConsent.learnMore')}
                    icon={<Icon name="arrow-square-out" size={20} color={theme.colors.accent.blue} />}
                    onPress={onLearnMore}
                />
            ) : null}
            <Item
                testID={`${testID}:dismiss`}
                title={t('connectedServices.accountStatusConsent.dismiss')}
                icon={<Icon name="check" size={20} color={theme.colors.accent.blue} />}
                showChevron={false}
                onPress={onDismiss}
            />
        </ItemGroup>
    );
});
