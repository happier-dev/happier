import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    QualifiedPoolDetailView,
    type PoolMemberQuota,
    type QualifiedPoolDetailAccount,
    type QualifiedPoolDetailMutations,
} from '@/components/settings/connectedServices/pools/QualifiedPoolDetailView';
import { Text } from '@/components/ui/text/Text';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { getQualifiedConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { QualifiedConnectedAccountUiGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import {
    ConnectedServiceAuthGroupPolicyV1Schema,
    type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import { ACCOUNTS, CLAUDE, CLAUDE_LAB, DAY, HOUR, LABELS, MIN } from './connectedServicesFixtures';

/**
 * Dev-only `/dev/connected-services` frames of the pool slice (lab `csvc` PL, PLp, PLa, PLap, PLS): the
 * real pool page fed by fixtures (the lab's Work pool: Work, Personal, Lab) with no-op mutations, so
 * nothing touches a real account. Null for a frame this slice does not own.
 */
export function renderPoolFrame(frame: string): React.ReactNode | null {
    switch (frame) {
        case 'PL':
        case 'PLp':
            return <PoolFrame />;
        case 'PLa':
            return <PoolFrame advanced manage />;
        case 'PLap':
            return <PoolFrame advanced />;
        case 'PLS':
            return <PoolStatesBoard />;
        default:
            return null;
    }
}

const noop = async () => null;
const MUTATIONS: QualifiedPoolDetailMutations = {
    mutating: false,
    patch: noop,
    patchMember: noop,
    addMember: noop,
    removeMember: noop,
    setActiveAccount: noop,
    delete: async () => false,
};

const POOL_ACCOUNTS: ReadonlyArray<QualifiedPoolDetailAccount> = [
    ...ACCOUNTS.filter((account) => account.ref.service === CLAUDE),
    CLAUDE_LAB,
];

const POOL_LABELS: Readonly<Record<string, string>> = {
    work: LABELS['happier.agent.claude%2Fclaude-subscription/work']!,
    personal: LABELS['happier.agent.claude%2Fclaude-subscription/personal']!,
    lab: 'Lab',
};

type Member = QualifiedConnectedAccountUiGroup['members'][number];

function member(accountId: string, priority: number, enabled: boolean, state: Member['state'] = {}): Member {
    return { ref: { service: CLAUDE, accountId }, priority, enabled, state };
}

function workPool(now: number, overrides: Partial<QualifiedConnectedAccountUiGroup> = {}): QualifiedConnectedAccountUiGroup {
    return {
        ref: { service: CLAUDE, groupId: 'work-pool' },
        displayName: 'Work pool',
        policy: {
            ...ConnectedServiceAuthGroupPolicyV1Schema.parse({}),
            strategy: 'least_limited',
            autoSwitch: true,
            autoDisablePlanInvalidAccounts: true,
            autoUseQuotaResetsWhenExhausted: false,
        },
        activeAccountId: 'work',
        activeSince: { accountId: 'work', atMs: now - 88 * MIN },
        revision: { protocol: 'v4', incarnation: 'fixture', generation: 1, runtimeStateRevision: 1 },
        state: { status: 'ready' },
        members: [
            member('work', 100, true),
            member('personal', 200, false, { autoDisabledReason: 'model_not_entitled' }),
            member('lab', 300, true),
        ],
        ...overrides,
    } as QualifiedConnectedAccountUiGroup;
}

type Window = readonly [id: string, label: string, left: number, resetsInMs: number];

function snapshot(now: number, accountId: string, plan: string, windows: readonly Window[], readAgoMs = 2 * MIN): ConnectedServiceQuotaSnapshotV1 {
    return {
        v: 1,
        serviceId: 'claude-subscription',
        profileId: accountId,
        fetchedAt: now - readAgoMs,
        staleAfterMs: 15 * MIN,
        planLabel: plan,
        accountLabel: null,
        meters: windows.map(([meterId, label, left, resetsInMs]) => ({
            meterId,
            label,
            used: null,
            limit: null,
            remainingPct: left,
            unit: 'percent',
            utilizationPct: 100 - left,
            resetsAt: now + resetsInMs,
            status: 'ok',
            details: {},
        })),
    } as unknown as ConnectedServiceQuotaSnapshotV1;
}

function labQuota(now: number): Record<string, PoolMemberQuota> {
    return {
        work: { loading: false, snapshot: snapshot(now, 'work', 'Max', [['5h', '5-hour', 42, 2 * HOUR + 15 * MIN], ['wk', 'Weekly', 64, 4 * DAY + 6 * HOUR]]) },
        personal: { loading: false, snapshot: snapshot(now, 'personal', 'Pro', [['5h', '5-hour', 6, 23 * MIN], ['wk', 'Weekly', 71, 3 * DAY + 2 * HOUR]]) },
        lab: { loading: false, snapshot: snapshot(now, 'lab', 'Max', [['5h', '5-hour', 96, 3 * HOUR + 58 * MIN], ['wk', 'Weekly', 73, 6 * DAY + 3 * HOUR]], 3 * DAY) },
    };
}

const AGENT_DEFAULTS = {
    choices: [
        { agentId: 'claude', title: 'Claude Code', isDefault: true },
        { agentId: 'opencode', title: 'OpenCode', isDefault: false },
        { agentId: 'pi', title: 'Pi', isDefault: false },
    ],
    setDefault: () => {},
};

function PoolFrame(props: Readonly<{ advanced?: boolean; manage?: boolean }>) {
    const { present } = useConnectedAccountIdentityPrivacy();
    const now = React.useMemo(() => Date.now(), []);
    const group = React.useMemo(() => workPool(now), [now]);
    const quota = React.useMemo(() => labQuota(now), [now]);
    return (
        <QualifiedPoolDetailView
            group={group}
            accounts={POOL_ACCOUNTS}
            accountLabels={POOL_LABELS}
            serviceLabel="Claude"
            legacyServiceId={getQualifiedConnectedServiceRegistryEntry(group.ref.service)?.legacyServiceId ?? null}
            onConnectAccount={() => {}}
            mutations={MUTATIONS}
            autoDisablePlanInvalidEnabled
            quotaLimitSelectionEnabled
            memberQuotaByAccountId={quota}
            presentIdentity={present}
            agentDefaults={AGENT_DEFAULTS}
            onOpenAccount={() => {}}
            now={now}
            initialAdvancedExpanded={props.advanced}
            initialManageMembersOpen={props.manage}
        />
    );
}

function PoolStatesBoard() {
    const { present } = useConnectedAccountIdentityPrivacy();
    const now = React.useMemo(() => Date.now(), []);
    const cells = React.useMemo(() => {
        const quota = labQuota(now);
        return [
            { key: 'empty', title: 'New pool, no members', group: workPool(now, { members: [], activeAccountId: null, activeSince: null }), quota: {} },
            {
                key: 'one-on',
                title: 'One member on',
                group: workPool(now, { members: [member('work', 100, true), member('lab', 300, false)] }),
                quota,
            },
            {
                key: 'waiting',
                title: 'Every member waiting',
                group: workPool(now, { members: [member('work', 100, true), member('lab', 300, true)] }),
                quota: {
                    work: { loading: false, snapshot: snapshot(now, 'work', 'Max', [['5h', '5-hour', 0, 2 * HOUR + 15 * MIN], ['wk', 'Weekly', 64, 4 * DAY]]) },
                    lab: { loading: false, snapshot: snapshot(now, 'lab', 'Max', [['5h', '5-hour', 80, 3 * HOUR], ['wk', 'Weekly', 0, 6 * DAY]]) },
                },
            },
            {
                key: 'stale',
                title: 'Usage loading · stale',
                group: workPool(now, { members: [member('work', 100, true), member('lab', 300, true)] }),
                quota: {
                    work: { loading: false, snapshot: snapshot(now, 'work', 'Max', [['5h', '5-hour', 42, 2 * HOUR], ['wk', 'Weekly', 64, 4 * DAY]], HOUR) },
                    lab: { loading: true, snapshot: null },
                },
            },
        ];
    }, [now]);
    return (
        <View style={styles.board}>
            {cells.map((cell) => (
                <View key={cell.key} style={styles.cell}>
                    <Text style={styles.caption}>{cell.title}</Text>
                    <View style={styles.clip}>
                        <QualifiedPoolDetailView
                            group={cell.group}
                            accounts={POOL_ACCOUNTS}
                            accountLabels={POOL_LABELS}
                            serviceLabel="Claude"
                            legacyServiceId={getQualifiedConnectedServiceRegistryEntry(cell.group.ref.service)?.legacyServiceId ?? null}
                            onConnectAccount={() => {}}
                            mutations={MUTATIONS}
                            memberQuotaByAccountId={cell.quota}
                            presentIdentity={present}
                            agentDefaults={AGENT_DEFAULTS}
                            now={now}
                        />
                    </View>
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    board: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 16,
        padding: 16,
    },
    cell: {
        width: 640,
        maxWidth: '100%',
        gap: 6,
    },
    caption: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    clip: {
        height: 600,
        overflow: 'hidden',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.surface,
    },
}));
