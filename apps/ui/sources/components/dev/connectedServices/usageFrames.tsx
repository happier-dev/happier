import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { buildUsageSummary } from '@/components/hub/usage/useUsageSummary';
import { buildUsagePopoverSession } from '@/components/navigation/shell/sidebarFooter/SessionUsagePopoverContent';
import {
    SidebarUsagePopoverView,
    USAGE_POPOVER_WIDTH_PX,
    type SidebarUsageAccountFacts,
} from '@/components/navigation/shell/sidebarFooter/SidebarUsagePopoverContent';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';

import { CHATGPT, CLAUDE, DAY, GROUPS, HOUR, MIN, type Svc } from './connectedServicesFixtures';

/**
 * Dev-only `/dev/connected-services` frames of the usage slice (lab `csvc` U1, U1p, U3, U3p): the one
 * Usage popover fed by fixtures (the lab's accounts), rail-wide and scoped to a session that signs in
 * through the Work pool. The privacy eye is the real device setting; nothing touches a real account.
 * Null for a frame this slice does not own.
 */
export function renderUsageFrame(frame: string): React.ReactNode | null {
    switch (frame) {
        case 'U1': return <UsageFrame scope="rail" phone={false} />;
        case 'U1p': return <UsageFrame scope="rail" phone />;
        case 'U3': return <UsageFrame scope="session" phone={false} />;
        case 'U3p': return <UsageFrame scope="session" phone />;
        default: return null;
    }
}

const noop = () => {};

function keyOf(service: Svc, accountId: string): string {
    return connectedServiceProfileKey({ serviceId: buildQualifiedPluginContributionKey(service), profileId: accountId });
}

type FixtureWindow = readonly [meterId: string, label: string, remainingPct: number, resetsInMs: number];

function entry(service: Svc, serviceLabel: string, legacyServiceId: string, accountId: string, name: string, email: string, plan: string, windows: readonly FixtureWindow[], now: number) {
    return {
        key: keyOf(service, accountId),
        fetchedAt: now - 12 * MIN,
        serviceLabel,
        serviceGroupKey: `${service.pluginId}/${service.localId}`,
        legacyServiceId,
        accountLabel: name,
        accountEmail: email,
        accountId,
        profileLabel: name,
        planLabel: plan,
        meters: windows.map(([meterId, label, remainingPct, resetsInMs]) => ({ meterId, label, remainingPct, resetsAt: now + resetsInMs })),
    };
}

function useFixture(scope: 'rail' | 'session') {
    const privacy = useConnectedAccountIdentityPrivacy();
    const now = React.useMemo(() => Date.now(), []);
    const usage = React.useMemo(() => buildUsageSummary({
        live: {
            v: 1,
            entries: [
                entry(CLAUDE, 'Claude', 'claude-subscription', 'work', 'Work', 'leeroy@company.com', 'Max', scope === 'session'
                    ? [['5h', '5-hour', 42, 2 * HOUR + 15 * MIN], ['wk', 'Weekly', 64, 4 * DAY + 6 * HOUR], ['wko', 'Weekly · Opus', 88, 4 * DAY + 6 * HOUR], ['wks', 'Weekly · Sonnet', 91, 4 * DAY + 6 * HOUR], ['extra', 'Extra usage', 76, DAY]]
                    : [['5h', '5-hour', 42, 2 * HOUR + 15 * MIN], ['wk', 'Weekly', 64, 4 * DAY + 6 * HOUR], ['wko', 'Weekly · Opus', 88, 4 * DAY + 6 * HOUR]], now),
                entry(CLAUDE, 'Claude', 'claude-subscription', 'personal', 'Personal', 'leeroy.b@gmail.com', 'Pro',
                    [['5h', '5-hour', 6, 23 * MIN], ['wk', 'Weekly', 71, 3 * DAY + 2 * HOUR]], now),
                entry(CHATGPT, 'ChatGPT', 'openai-codex', 'personal', 'Personal', 'leeroy.b@gmail.com', 'Pro',
                    [['5h', '5-hour', 71, 3 * HOUR + 58 * MIN], ['wk', 'Weekly', 22, 2 * DAY + 21 * HOUR]], now),
            ],
        },
        saved: null,
        accountsWithoutUsage: [],
    }), [now, scope]);
    const facts = React.useMemo((): SidebarUsageAccountFacts => ({
        accountsNeedingSignIn: [{
            key: keyOf(CHATGPT, 'work'),
            ref: { service: CHATGPT, accountId: 'work' },
            serviceLabel: 'ChatGPT',
            legacyServiceId: 'openai-codex',
            serviceGroupKey: `${CHATGPT.pluginId}/${CHATGPT.localId}`,
            accountLabel: 'Team',
            accountEmail: 'leeroy@company.com',
            accountId: 'work',
        }],
        keysWithoutLimits: 1,
        accounts: {
            [keyOf(CHATGPT, 'personal')]: {
                subscription: {
                    status: 'subscribed', renewal: 'on', currentPeriodEndAtMs: now + 17 * DAY - HOUR,
                    observedAtMs: now - 12 * MIN, staleAfterMs: DAY,
                },
                recoveryCredits: { availableCount: 3, nextExpiresAtMs: now + 5 * DAY, credits: [] },
            },
        },
    }), [now]);
    const session = React.useMemo(() => (scope === 'session' ? buildUsagePopoverSession({
        metadata: {
            connectedServices: {
                v: 2,
                bindingsByServiceId: {
                    [buildQualifiedPluginContributionKey(CLAUDE)]: { source: 'connected', selection: 'group', groupId: 'work-pool', profileId: 'work' },
                },
            },
        },
        agentId: 'claude',
        viewModel: null,
        // The Work pool picks the account with the most left and switches on its own.
        groups: GROUPS.map((group) => ({ ...group, policy: ConnectedServiceAuthGroupPolicyV1Schema.parse(group.policy) })),
        usage,
        present: privacy.present,
        resetAction: null,
    }) : null), [privacy.present, scope, usage]);
    return { usage, facts, privacy, session };
}

function UsageFrame(props: Readonly<{ scope: 'rail' | 'session'; phone: boolean }>) {
    const fixture = useFixture(props.scope);
    return (
        <View style={props.phone ? styles.sheet : styles.popover} testID={`usage-frame-${props.scope}`}>
            <SidebarUsagePopoverView
                usage={fixture.usage}
                facts={fixture.facts}
                privacy={fixture.privacy}
                session={fixture.session}
                onOpenConnectedServices={noop}
                onSignInAgain={noop}
            />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    popover: {
        width: USAGE_POPOVER_WIDTH_PX,
        margin: 24,
        paddingVertical: 4,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.surface,
        backgroundColor: theme.colors.surface.elevated,
    },
    sheet: {
        marginTop: 'auto',
        paddingTop: 8,
        paddingBottom: 28,
        paddingHorizontal: 8,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        backgroundColor: theme.colors.surface.elevated,
    },
}));
