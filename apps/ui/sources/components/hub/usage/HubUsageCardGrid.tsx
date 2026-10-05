import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ConnectedServiceQuotaRecoveryCreditsV1 } from '@happier-dev/protocol';

import { CardGrid } from '@/components/ui/cardGrid/CardGrid';
import { ConnectedAccountIdentityText } from '@/components/settings/connectedServices/ConnectedAccountIdentityText';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';
import { AccountUsageResetsLine } from '@/components/settings/connectedServices/usage/AccountUsageFacts';
import { UsageMeterRow, UsageMeterStack } from '@/components/settings/connectedServices/usage/UsageMeterRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceCard } from '@/components/ui/cards/SurfaceCard';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ConnectedServiceAccountNeedingSignIn } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import { useConnectedAccountIdentityPrivacy, type ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
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
    return (
        <CardGrid testID={props.testID ?? 'hub-usage.grid'} columns={2}>
            {props.entries.map((entry) => (
                <HubUsageCard
                    key={entry.key}
                    entry={entry}
                    present={present}
                    inUse={facts.inUseAccountKeys.has(entry.key)}
                    recoveryCredits={facts.recoveryCreditsByKey[entry.key] ?? null}
                />
            ))}
            {facts.accountsNeedingSignIn.map((account) => (
                <HubSignedOutCard key={account.key} account={account} present={present} onSignInAgain={facts.onSignInAgain} />
            ))}
        </CardGrid>
    );
});

function identityOf(
    present: ConnectedAccountIdentityPresenter,
    input: Readonly<{ serviceLabel: string; accountLabel?: string | null; profileLabel?: string | null; accountEmail?: string | null; accountId?: string | null; planLabel?: string | null }>,
): Readonly<{ title: string; qualifier: string }> {
    const shown = present({
        label: input.accountLabel ?? input.profileLabel ?? null,
        email: input.accountEmail ?? null,
        accountId: input.accountId ?? null,
    });
    // A name that is the email already says who it is; the line under it then carries the plan alone.
    const name = shown.label ?? shown.email ?? shown.accountId;
    const email = shown.email && shown.email !== name ? shown.email : null;
    return {
        title: name ? `${input.serviceLabel} · ${name}` : input.serviceLabel,
        qualifier: [email, input.planLabel].filter(Boolean).join(' · '),
    };
}

const HubUsageCard = React.memo(function HubUsageCard(props: Readonly<{
    entry: UsageSummaryEntry;
    present: ConnectedAccountIdentityPresenter;
    inUse: boolean;
    recoveryCredits: ConnectedServiceQuotaRecoveryCreditsV1 | null;
}>) {
    const { theme } = useUnistyles();
    const { entry } = props;
    const identity = identityOf(props.present, entry);
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
                        <Icon name="stack" size={12} color={theme.colors.text.tertiary} />
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
    present: ConnectedAccountIdentityPresenter;
    onSignInAgain?: (account: ConnectedServiceAccountNeedingSignIn) => void;
}>) {
    const { theme } = useUnistyles();
    const { account } = props;
    const identity = identityOf(props.present, account);
    return (
        <SurfaceCard testID={`hub-usage.${account.key}:signed-out`} padding="sm" fill style={stylesheet.signedOutCard}>
            <View style={stylesheet.identity}>
                <ConnectedServiceMark legacyServiceId={account.legacyServiceId ?? null} size="card" />
                <View style={stylesheet.identityText}>
                    <ConnectedAccountIdentityText value={identity.title} style={stylesheet.service} numberOfLines={1} />
                    {identity.qualifier ? <ConnectedAccountIdentityText value={identity.qualifier} style={stylesheet.qualifier} numberOfLines={1} /> : null}
                </View>
            </View>
            <View style={stylesheet.signedOutLine}>
                <Icon name="warning" size={13} color={theme.colors.state.warning.foreground} />
                <Text style={stylesheet.signedOutText} numberOfLines={2}>
                    {t('connectedServicesSettings.signedOutBy', { service: account.serviceLabel })}
                </Text>
            </View>
            {props.onSignInAgain ? (
                <View style={stylesheet.signedOutAction}>
                    <RoundButton
                        testID={`hub-usage.${account.key}:sign-in-again`}
                        size="small"
                        display="secondary"
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
        fontSize: 14,
        lineHeight: 19,
    },
    qualifier: {
        color: theme.colors.text.secondary,
        fontSize: 12.5,
        lineHeight: 17,
    },
    inUse: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingTop: 2,
    },
    inUseText: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
    },
    meters: {
        marginTop: 12,
        gap: 9,
    },
    signedOutCard: {
        borderColor: theme.colors.state.warning.border,
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
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.state.warning.foreground,
    },
    signedOutAction: {
        flexDirection: 'row',
        marginTop: 10,
    },
}));
