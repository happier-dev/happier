import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Typography } from '@/constants/Typography';

import { ConnectedServiceMark, formatAgentNames } from '../ConnectedServiceMark';
import { presentConnectedAccountAccessMode } from '../model/presentConnectedAccountAccessMode';
import { resolveConnectedAccountAccessMode } from '../model/resolveConnectedAccountAccessMode';
import { AccountUsageResetsLine } from '../usage/AccountUsageFacts';
import {
    ConnectedAccountIndexActions,
    ConnectedAccountSignInAction,
    ConnectedAccountSignInRecovery,
    ConnectedAccountIndexRoles,
    ConnectedAccountIndexStatusLines,
    ConnectedAccountIndexUsageBlock,
    resolveConnectedAccountUsageRefresh,
    type ConnectedAccountIndexEntry,
    type ConnectedAccountIndexFacts,
} from './ConnectedAccountIndexRow';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { ConnectedAccountIdentityText } from '../ConnectedAccountIdentityText';
import { Text } from '@/components/ui/text/Text';

/**
 * One account as a card (lab csvc C2, owner 11-01): as tall as what it holds. The header is the account and
 * its quiet actions; the body is its status (a sign-in to repair) or its limits table, the resets it can use
 * and how fresh the numbers are; the foot names the agents that use it, then the pools it is in.
 */
export const ConnectedAccountCardView = React.memo(function ConnectedAccountCardView(props: ConnectedAccountIndexEntry & Readonly<{
    facts: ConnectedAccountIndexFacts;
    legacyServiceMarkId: string | null;
    agentIds: readonly string[];
    now: number;
    /**
     * A phone's two-per-row card (R7, lab phone-system `p4-creds`): the mark, the account, its kind, then the
     * agents that use it. Its limits, resets and default live one press away on the account.
     */
    compact?: Readonly<{ usedBy: readonly string[] }>;
}>) {
    const { facts } = props;
    if (props.compact) return <ConnectedAccountCompactCard {...props} compact={props.compact} />;
    const identity = [props.identityLabel, facts.planLabel].filter(Boolean).join(' · ');
    return (
        <WidgetFrame
            testID={props.testID}
            accessibilityLabel={props.title}
            onOpen={props.onOpen}
            frameStyle="card"
            // Cards in one grid row share its height (CardGrid): the shorter card fills its cell.
            fill
            placement="home"
            bodyHeight="content"
            // An account card is as tall as its content: it reserves no Home widget rows (owner 11-01).
            rows={0}
            // The bare mark, so its ink stands on the card's content edge with the body and the foot beneath it.
            mark={<ConnectedServiceMark service={props.service} legacyServiceId={props.legacyServiceMarkId} pluginId={props.pluginId} size="column" />}
            title={<ConnectedAccountIdentityText value={props.title} style={styles.title} numberOfLines={1} />}
            source={identity ? <ConnectedAccountIdentityText value={identity} style={styles.subtitle} numberOfLines={1} /> : undefined}
            sourcePlacement="below"
            menu={<ConnectedAccountIndexActions
                    testID={props.testID}
                    star={props.star}
                    refresh={resolveConnectedAccountUsageRefresh(facts, props.signedOut)}
                    refreshing={facts.refreshing}
                />}
            body={{ kind: 'content', children: <View pointerEvents="box-none" style={styles.body}>
            {/* Plan renewal and how fresh the numbers are: a quiet caption with air before the table. */}
            <ConnectedAccountIndexStatusLines testID={props.testID} facts={facts} now={props.now} />
            {props.signedOut ? (
                <ConnectedAccountSignInRecovery testID={props.testID} signedOut={props.signedOut}
                    onOpen={props.onOpen} compact prominence={props.fixProminence} />
            ) : facts.usage.kind === 'none' ? null : (
                <View pointerEvents={facts.usage.kind === 'error' ? 'box-none' : 'none'}>
                    <ConnectedAccountIndexUsageBlock testID={props.testID} usage={facts.usage} size="card" />
                </View>
            )}
            {props.signedOut ? null : (
                <AccountUsageResetsLine
                    testID={`${props.testID}:resets`}
                    recoveryCredits={facts.recoveryCredits}
                    legacyServiceId={props.legacyServiceId}
                    accountId={props.accountId}
                    snapshotFetchedAtMs={facts.fetchedAt}
                    now={props.now}
                    onApplied={() => facts.refresh?.()}
                />
            )}
            </View> }}
            // The agents that use it lead the foot, the pools it is in follow on the same line (owner 11-01).
            facts={props.agentIds.length > 0 || props.roles.length > 0 ? <View pointerEvents="none" style={styles.facts}>
                {props.agentIds.length > 0 ? (
                    <View style={styles.agents}>
                        {props.agentIds.map((agentId) => <AgentIcon key={agentId} agentId={agentId} size={14} />)}
                    </View>
                ) : null}
                <ConnectedAccountIndexRoles testID={props.testID} roles={props.roles} />
            </View> : undefined}
        />
    );
});

function ConnectedAccountCompactCard(props: React.ComponentProps<typeof ConnectedAccountCardView> & Readonly<{ compact: Readonly<{ usedBy: readonly string[] }> }>) {
    const { facts } = props;
    const accessMode = props.accessMode ?? resolveConnectedAccountAccessMode(null, facts.subscription);
    const kind = accessMode ? presentConnectedAccountAccessMode(accessMode, facts.planLabel) : facts.planLabel;
    return (
        <WidgetFrame
            testID={props.testID}
            accessibilityLabel={props.title}
            onOpen={props.onOpen}
            frameStyle="card"
            // The lab's card: the mark on its own row, the account under it, then its kind and use (p4-creds).
            anatomy="item"
            fill
            placement="home"
            bodyHeight="content"
            rows={0}
            mark={<ConnectedServiceMark service={props.service} legacyServiceId={props.legacyServiceMarkId} pluginId={props.pluginId} size="column" />}
            // At half a phone's width a default name ("Anthropic API key account") takes a second line rather than a cut.
            title={<ConnectedAccountIdentityText value={props.title} style={styles.title} numberOfLines={2} />}
            source={kind ? <ConnectedAccountIdentityText value={kind} style={styles.subtitle} numberOfLines={1} /> : undefined}
            facts={props.compact.usedBy.length > 0
                ? <Text style={styles.subtitle} numberOfLines={1}>{formatAgentNames(props.compact.usedBy)}</Text>
                : undefined}
        />
    );
}

/**
 * A phone's Needs-you account (R7, lab phone-system `p4-creds` `cr cwide`): one card across the row, the
 * service mark, the account with why it needs you beneath it, and its Sign in at the trailing edge.
 */
export const ConnectedAccountNeedsYouCardView = React.memo(function ConnectedAccountNeedsYouCardView(props: ConnectedAccountIndexEntry & Readonly<{
    signedOut: NonNullable<ConnectedAccountIndexEntry['signedOut']>;
    legacyServiceMarkId: string | null;
}>) {
    return (
        <WidgetFrame
            testID={props.testID}
            accessibilityLabel={props.title}
            onOpen={props.onOpen}
            frameStyle="card"
            placement="home"
            bodyHeight="content"
            rows={0}
            mark={<ConnectedServiceMark service={props.service} legacyServiceId={props.legacyServiceMarkId} pluginId={props.pluginId} size="column" />}
            // The account and why it needs you are one text column beside the mark (lab `cwide`), not a second row.
            title={<View style={styles.needsYouText}>
                <ConnectedAccountIdentityText value={props.title} style={styles.title} numberOfLines={2} />
                <Text style={[styles.subtitle, styles.attention]} numberOfLines={2}>{props.signedOut.reason}</Text>
            </View>}
            menu={<ConnectedAccountSignInAction testID={props.testID} signedOut={props.signedOut}
                onOpen={props.onOpen} prominence={props.fixProminence} />}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    title: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    needsYouText: {
        flexShrink: 1,
        minWidth: 0,
    },
    // "Needs you" words take the warning text role, as the sign-in line on the account's other surfaces.
    attention: {
        color: theme.colors.state.warning.textForeground,
    },
    body: {
        gap: theme.space.s12,
    },
    // The foot stands apart from the body behind a hairline, as the earlier card's did (lab csvc C2).
    facts: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s10,
        // The frame's foot is a row: the line spans the card's content width, not just the marks.
        flexGrow: 1,
        paddingTop: theme.space.s10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
    agents: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
}));
