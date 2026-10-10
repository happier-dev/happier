import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { ConnectedServiceQuotaRecoveryCreditsV1 } from '@happier-dev/protocol';

import { CardGrid } from '@/components/ui/cardGrid/CardGrid';
import { ConnectedAccountIdentityText } from '@/components/settings/connectedServices/ConnectedAccountIdentityText';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';
import { AccountUsageResetsLine } from '@/components/settings/connectedServices/usage/AccountUsageFacts';
import { UsageMeterRow, UsageMeterStack } from '@/components/settings/connectedServices/usage/UsageMeterRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ConnectedServiceAccountNeedingSignIn } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import {
    presentConnectedAccountNames,
    type ConnectedAccountNamePresentation,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { t } from '@/text';

import type { UsageSummaryEntry } from './useUsageSummary';

/** What this launch knows beside the saved values: who a pool uses now, the resets, the accounts that need a sign-in. */
export type HubUsageCardFacts = Readonly<{
    inUseAccountKeys: ReadonlySet<string>;
    recoveryCreditsByKey: Readonly<Record<string, ConnectedServiceQuotaRecoveryCreditsV1 | null | undefined>>;
    accountsNeedingSignIn: readonly ConnectedServiceAccountNeedingSignIn[];
    onSignInAgain?: (account: ConnectedServiceAccountNeedingSignIn) => void;
}>;

const NO_FACTS: HubUsageCardFacts = {
    inUseAccountKeys: new Set(),
    recoveryCreditsByKey: {},
    accountsNeedingSignIn: [],
};

/**
 * Connected accounts' usage as Home's card grid (lab `csvc` H2b on the `hindex` tile rhythm): one card per
 * account — its bare mark, "Service · Name", "email · plan" through the one identity presenter, "In use"
 * when a pool uses it now, each window on the one meter, and its usage resets — then a card per account that
 * needs a new sign-in, with the fix. It renders what it is given (`useUsageSummary`).
 */
export const HubUsageCardGrid = React.memo(function HubUsageCardGrid(props: Readonly<{
    entries: readonly UsageSummaryEntry[];
    facts?: HubUsageCardFacts;
    testID?: string;
}>) {
    const { present } = useConnectedAccountIdentityPrivacy();
    const facts = props.facts ?? NO_FACTS;
    // The cards shown together are named at once, so accounts that read as their service's account are
    // told apart by the one naming owner.
    const names = React.useMemo(() => presentConnectedAccountNames([...props.entries, ...facts.accountsNeedingSignIn].map((input) => ({
        key: input.key,
        serviceTitle: input.serviceLabel,
        displayName: input.accountLabel ?? ('profileLabel' in input ? input.profileLabel : null) ?? null,
        email: input.accountEmail ?? null,
        accountId: input.accountId ?? null,
        presentIdentity: present,
    }))), [facts.accountsNeedingSignIn, present, props.entries]);
    return (
        <CardGrid testID={props.testID ?? 'hub-usage.grid'} columns={2}>
            {props.entries.map((entry) => (
                <HubUsageCard
                    key={entry.key}
                    entry={entry}
                    name={names.get(entry.key)!}
                    inUse={facts.inUseAccountKeys.has(entry.key)}
                    recoveryCredits={facts.recoveryCreditsByKey[entry.key] ?? null}
                />
            ))}
            {facts.accountsNeedingSignIn.map((account) => (
                <HubSignedOutCard key={account.key} account={account} name={names.get(account.key)!} onSignInAgain={facts.onSignInAgain} />
            ))}
        </CardGrid>
    );
});

/** "Service · Name" and, under it, the identity hint and plan. A name that is the email is said once. */
function identityOf(
    name: ConnectedAccountNamePresentation,
    input: Readonly<{ serviceLabel: string; planLabel?: string | null }>,
): Readonly<{ title: string; qualifier: string }> {
    return {
        title: name.serviceFallback ? name.primaryLabel : `${input.serviceLabel} · ${name.primaryLabel}`,
        qualifier: [name.identityLabel, input.planLabel].filter(Boolean).join(' · '),
    };
}

const HubUsageCard = React.memo(function HubUsageCard(props: Readonly<{
    entry: UsageSummaryEntry;
    name: ConnectedAccountNamePresentation;
    inUse: boolean;
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
}>) {
    const { theme } = useUnistyles();
    const { entry } = props;
    const identity = identityOf(props.name, entry);
    const now = Date.now();
    return (
        <SurfaceCard testID={`hub-usage.${entry.key}`} padding="sm" fill>
            <View style={stylesheet.identity}>
                <ConnectedServiceMark legacyServiceId={entry.legacyServiceId ?? null} size="card" />
                <View style={stylesheet.identityText}>
                    <ConnectedAccountIdentityText value={identity.title} style={stylesheet.service} numberOfLines={1} />
                    {identity.qualifier ? <ConnectedAccountIdentityText value={identity.qualifier} style={stylesheet.qualifier} numberOfLines={1} /> : null}
                </View>
                {props.inUse ? (
                    <View testID={`hub-usage.${entry.key}:in-use`} style={stylesheet.inUse}>
                        <Icon name="stack" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                        <Text style={stylesheet.inUseText}>{t('connectedServicesCollection.inUse')}</Text>
                    </View>
                ) : null}
            </View>
            <View style={stylesheet.meters}>
                <UsageMeterStack>
                    {entry.meters.map((meter) => (
                        <UsageMeterRow
                            key={meter.meterId}
                            size="card"
                            layout="stacked"
                            label={meter.label}
                            remainingPct={meter.remainingPct}
                            resetsAt={meter.resetsAt}
                            tone={resolveQuotaTone(meter.remainingPct)}
                            now={now}
                        />
                    ))}
                </UsageMeterStack>
                <AccountUsageResetsLine
                    testID={`hub-usage.${entry.key}:resets`}
                    recoveryCredits={props.recoveryCredits}
                    legacyServiceId={entry.legacyServiceId ?? null}
                    accountId={entry.accountId ?? null}
                    snapshotFetchedAtMs={entry.fetchedAt ?? null}
                    now={now}
                    onApplied={noop}
                />
            </View>
        </SurfaceCard>
    );
});

/** An account that needs a new sign-in: its identity, why it stopped, and Sign in again (the set-up flow). */
const HubSignedOutCard = React.memo(function HubSignedOutCard(props: Readonly<{
    account: ConnectedServiceAccountNeedingSignIn;
    name: ConnectedAccountNamePresentation;
    onSignInAgain?: (account: ConnectedServiceAccountNeedingSignIn) => void;
}>) {
    const { theme } = useUnistyles();
    const { account } = props;
    const identity = identityOf(props.name, account);
    return (
        <SurfaceCard testID={`hub-usage.${account.key}:signed-out`} padding="sm" fill>
            <View style={stylesheet.identity}>
                <ConnectedServiceMark legacyServiceId={account.legacyServiceId ?? null} size="card" />
                <View style={stylesheet.identityText}>
                    <ConnectedAccountIdentityText value={identity.title} style={stylesheet.service} numberOfLines={1} />
                    {identity.qualifier ? <ConnectedAccountIdentityText value={identity.qualifier} style={stylesheet.qualifier} numberOfLines={1} /> : null}
                </View>
            </View>
            <View style={stylesheet.signedOutLine}>
                <Icon name="warning" size={ICON_SIZE.xs} color={theme.colors.state.warning.foreground} />
                <Text style={stylesheet.signedOutText} numberOfLines={2}>
                    {t('connectedServicesSettings.signedOutBy', { service: account.serviceLabel })}
                </Text>
            </View>
            {props.onSignInAgain ? (
                <View style={stylesheet.signedOutAction}>
                    <RoundButton
                        testID={`hub-usage.${account.key}:sign-in-again`}
                        size="small"
                        display="default"
                        title={t('connectedServicesSettings.signInAgain')}
                        onPress={() => props.onSignInAgain?.(account)}
                    />
                </View>
            ) : null}
        </SurfaceCard>
    );
});

const noop = () => {};

const stylesheet = StyleSheet.create((theme) => ({
    identity: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    identityText: {
        flex: 1,
        minWidth: 0,
    },
    service: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        ...happierPageTextMetrics('rowTitle'),
    },
    qualifier: {
        color: theme.colors.text.secondary,
        ...happierPageTextMetrics('meta'),
    },
    inUse: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingTop: 2,
    },
    inUseText: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
    },
    meters: {
        marginTop: 12,
        gap: 9,
    },
    signedOutLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 12,
    },
    signedOutText: {
        ...Typography.default(),
        flex: 1,
        ...happierPageTextMetrics('meta'),
        color: theme.colors.state.warning.foreground,
    },
    signedOutAction: {
        flexDirection: 'row',
        marginTop: 10,
    },
}));
