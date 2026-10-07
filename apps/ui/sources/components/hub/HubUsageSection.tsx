import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import type { HubSectionProps } from './hubSectionProps';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { openConnectedServiceSetupModal } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { useConnectedServiceQuotaSummaries } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';

import { HubUsageCardGrid, type HubUsageCardFacts } from './usage/HubUsageCardGrid';
import { useUsageSummary, type UsageSummaryEntry } from './usage/useUsageSummary';

/**
 * What is left in each connected account's usage windows, from the usage summary owner: what this
 * launch read, else the last value this device saved, with its time ("As of"). The section is absent
 * when nothing is known. It reads the server once per launch (a server GET, never a machine call).
 */
export const HubUsageSection = React.memo(function HubUsageSection(props: HubSectionProps) {
    const usage = useUsageSummary({ load: 'once' });
    // The facts beside usage (who a pool uses now, resets, signed-out accounts) come from the same
    // summaries owner the usage summary reads; they are this launch's, never saved.
    const quota = useConnectedServiceQuotaSummaries({ fetchPolicy: 'cache_only' });
    const recoveryCreditsByKey = React.useMemo(
        () => Object.fromEntries(quota.summaries.map((summary) => [summary.key, summary.recoveryCredits])),
        [quota.summaries],
    );
    const facts = React.useMemo((): HubUsageCardFacts => ({
        inUseAccountKeys: quota.inUseAccountKeys,
        recoveryCreditsByKey,
        accountsNeedingSignIn: quota.accountsNeedingSignIn,
        onSignInAgain: (account) => openConnectedServiceSetupModal({
            kind: 'reconnect',
            serviceKey: buildQualifiedPluginContributionKey(account.ref.service),
            accountId: account.ref.accountId,
        }),
    }), [quota.accountsNeedingSignIn, quota.inUseAccountKeys, recoveryCreditsByKey]);
    if ((usage.source === 'none' || usage.entries.length === 0) && quota.accountsNeedingSignIn.length === 0) return null;
    return <HubUsageSectionView entries={usage.entries} facts={facts} asOf={usage.asOf} menu={props.menu} />;
});

/** The section as drawn: Usage, "As of", ⋯, and one card per account (the `/dev/home` fixture draws it too). */
export function HubUsageSectionView(props: Readonly<{
    entries: readonly UsageSummaryEntry[];
    facts?: HubUsageCardFacts;
    asOf: number | null;
    menu?: React.ReactNode;
}>) {
    return (
        <ItemGroup
            title={t('settingsOverview.usageTitle')}
            surface="none"
            action={props.asOf !== null || props.menu ? (
                <View style={stylesheet.headerActions}>
                    {props.asOf !== null ? <SurfaceAsOfLabel at={props.asOf} /> : null}
                    {props.menu}
                </View>
            ) : undefined}
        >
            <HubUsageCardGrid entries={props.entries} facts={props.facts} />
        </ItemGroup>
    );
}

const stylesheet = StyleSheet.create(() => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
}));
