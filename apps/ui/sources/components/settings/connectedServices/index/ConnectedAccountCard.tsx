import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { ConnectedServiceMark } from '../ConnectedServiceMark';
import { AccountUsageResetsLine } from '../usage/AccountUsageFacts';
import {
    ConnectedAccountIndexActions,
    ConnectedAccountIndexRoles,
    ConnectedAccountIndexStatusLines,
    ConnectedAccountIndexUsageBlock,
    type ConnectedAccountIndexEntry,
    type ConnectedAccountIndexFacts,
} from './ConnectedAccountIndexRow';
import { OpenableSurface } from './OpenableSurface';
import { ConnectedAccountIdentityText } from '../ConnectedAccountIdentityText';

/**
 * An account as a grid card (lab `csvc` C2): mark, name, email · plan and ★ ↻ on top; the subscription and
 * staleness; every limit; usage resets; and a footer with its pool chips and the marks of the agents that
 * use it. The card is as tall as what it holds (no stretch). A signed-out card carries its fix.
 */
export const ConnectedAccountCardView = React.memo(function ConnectedAccountCardView(props: ConnectedAccountIndexEntry & Readonly<{
    facts: ConnectedAccountIndexFacts;
    legacyServiceMarkId: string | null;
    agentIds: readonly string[];
    now: number;
}>) {
    const { theme } = useUnistyles();
    const { facts } = props;
    const identity = [props.identityLabel, facts.planLabel].filter(Boolean).join(' · ');
    return (
        <OpenableSurface
            testID={props.testID}
            accessibilityLabel={props.title}
            onPress={props.onOpen}
            style={[styles.card, props.signedOut ? styles.cardAttention : null]}
            hoveredStyle={styles.hovered}
        >
            <View pointerEvents="box-none" style={styles.top}>
                <ConnectedServiceMark legacyServiceId={props.legacyServiceMarkId} size="card" />
                <View pointerEvents="none" style={styles.topText}>
                    <ConnectedAccountIdentityText value={props.title} style={styles.title} numberOfLines={1} />
                    {identity ? <ConnectedAccountIdentityText value={identity} style={styles.subtitle} numberOfLines={1} /> : null}
                </View>
                <ConnectedAccountIndexActions
                    testID={props.testID}
                    star={props.star}
                    refresh={props.signedOut || facts.usage.kind === 'noLimits' ? null : facts.refresh}
                    refreshing={facts.refreshing}
                />
            </View>
            <View pointerEvents="none">
                <ConnectedAccountIndexStatusLines testID={props.testID} signedOutReason={null} facts={facts} now={props.now} />
            </View>
            {props.signedOut ? (
                <View pointerEvents="box-none" style={styles.fix}>
                    <Icon name="warning" size={14} color={theme.colors.state.warning.foreground} />
                    <Text style={styles.fixText} numberOfLines={2}>{props.signedOut.reason}</Text>
                    <RoundButton
                        testID={`${props.testID}:sign-in-again`}
                        size="small"
                        display="secondary"
                        title={t('connectedServicesSettings.signInAgain')}
                        disabled={!props.signedOut.onSignInAgain}
                        onPress={props.signedOut.onSignInAgain ?? undefined}
                    />
                </View>
            ) : (
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
            <View pointerEvents="none" style={styles.footer}>
                <View style={styles.footerRoles}>
                    <ConnectedAccountIndexRoles testID={props.testID} roles={props.roles} />
                </View>
                <View style={styles.agents}>
                    {props.agentIds.map((agentId) => <AgentIcon key={agentId} agentId={agentId} size={14} />)}
                </View>
            </View>
        </OpenableSurface>
    );
});

const styles = StyleSheet.create((theme) => ({
    // As tall as what it holds: cards in a row do not stretch to the tallest (lab C2).
    card: {
        minWidth: 0,
        gap: 10,
        paddingTop: 13,
        paddingBottom: 12,
        paddingHorizontal: 14,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        // The page's sheet: its tint and hairline, so cards read as the list's sheets do.
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.sectionTint,
    },
    cardAttention: {
        borderColor: theme.colors.state.warning.border,
    },
    hovered: {
        borderColor: theme.colors.border.strong,
    },
    top: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    topText: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 13.5,
        lineHeight: 18,
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    fix: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    fixText: {
        ...Typography.default(),
        flex: 1,
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 20,
        paddingTop: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
    footerRoles: {
        flex: 1,
        minWidth: 0,
        marginTop: -8,
    },
    agents: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
}));
