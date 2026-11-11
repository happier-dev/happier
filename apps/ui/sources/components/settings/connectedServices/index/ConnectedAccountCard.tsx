import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Typography } from '@/constants/Typography';

import { ConnectedServiceMark } from '../ConnectedServiceMark';
import { AccountUsageResetsLine } from '../usage/AccountUsageFacts';
import {
    ConnectedAccountIndexActions,
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
}>) {
    const { facts } = props;
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
                    <ConnectedAccountIndexUsageBlock testID={props.testID} usage={facts.usage} now={props.now} size="card" />
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

const styles = StyleSheet.create((theme) => ({
    title: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
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
