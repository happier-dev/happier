import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
    ConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaRecoveryCreditsV1,
    ProviderAccountSubscriptionV1,
    QualifiedConnectedAccountGroupV4,
    QualifiedConnectedAccountProfileV4,
    QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';

import { ConnectedServicesRailView, RailAccountMeta, type ConnectedServicesRailAccountMeta } from '@/components/settings/connectedServices/collection/ConnectedServicesRail';
import { AgentDefaultMenuButton } from '@/components/settings/connectedServices/defaults/AgentDefaultMenuButton';
import {
    AccountDetailResetsSectionView,
    AccountDetailFactsSectionsView,
    AccountDetailUsedBySectionView,
    AccountDetailWorksOnSectionView,
} from '@/components/settings/connectedServices/account/AccountDetailSections';
import { QualifiedAccountDetailView } from '@/components/settings/connectedServices/account/QualifiedAccountDetailView';
import { projectIndexMeters, type ConnectedAccountIndexFacts } from '@/components/settings/connectedServices/index/ConnectedAccountIndexRow';
import { ConnectedServicePoolIndexItemView } from '@/components/settings/connectedServices/index/ConnectedServicePoolIndexItem';
import { ConnectedServicesIndexView, type ConnectedServicesIndexPresentation } from '@/components/settings/connectedServices/index/ConnectedServicesIndexView';
import { buildConnectedServicesIndexModel, type ConnectedServicesIndexSheet } from '@/components/settings/connectedServices/model/buildConnectedServicesIndexModel';
import { derivePoolUsage } from '@/components/settings/connectedServices/pools/derivePoolUsage';
import { ConnectedAccountSettledView } from '@/components/settings/connectedServices/setup/ConnectedAccountSettled';
import { selectConnectedAccountSettleOffer } from '@/components/settings/connectedServices/setup/selectConnectedAccountSettleOffer';
import { presentConnectedServicesIndexAccount } from '@/components/settings/connectedServices/model/presentConnectedServicesIndexAccount';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ConnectedServicesConnectMore } from '@/components/settings/connectedServices/setup/ConnectedServicesConnectMore';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { UsageMeterRow, UsageMeterStack } from '@/components/settings/connectedServices/usage/UsageMeterRow';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { presentConnectedAccountIdentity } from '@/sync/domains/connectedServices/maskAccountEmail';
import type { ConnectedAccountIdentityPresenter } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import type { QualifiedConnectedAccountUiGroup } from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

import { ANTHROPIC, CHATGPT, CLAUDE, DAY, ENTRIES, GEMINI, GITHUB, HOUR, MIN, OPENAI, account } from './connectedServicesFixtures';

/**
 * Dev-only `/dev/connected-services` frames of the collection slice (lab `csvc` C1, C2, C1v, D1, D2, MT and
 * their phone twins): the real rail, index and account detail fed by the lab's cast through their views.
 * Nothing reads or writes a real account. Null for a frame it does not own.
 */
export function renderCollectionFrame(frame: string): React.ReactNode | null {
    switch (frame) {
        case 'C1': case 'C1p': return <CollectionFrame presentation="list" />;
        case 'C2': case 'C2p': return <CollectionFrame presentation="grid" />;
        case 'C1v': case 'C1vp': return <CollectionFrame presentation="list" hidden />;
        case 'A5': case 'A5p': return <CollectionFrame presentation="list" settled />;
        case 'D1': case 'D1p': return <DetailFrame accountKey="chatgpt:personal" />;
        case 'D2': case 'D2p': return <DetailFrame accountKey="chatgpt:team" />;
        case 'MT': return <MeterBoard />;
        default: return null;
    }
}

const noop = () => {};
const NOW = Date.now();

/** The lab's cast: Claude Work/Personal/Lab, ChatGPT Personal/Team/Bot, an Anthropic key and GitHub. */
const CAST: readonly QualifiedConnectedAccountProfileV4[] = [
    account(CLAUDE, 'work', 'leeroy@company.com'),
    account(CLAUDE, 'personal', 'leeroy.b@gmail.com'),
    account(CLAUDE, 'lab', 'lab@happier.dev'),
    account(CHATGPT, 'personal', 'leeroy.b@gmail.com', { providerIdentity: { email: 'leeroy.b@gmail.com', accountId: 'user-4fQk8TzW1c' } }),
    account(CHATGPT, 'team', 'leeroy@company.com', { status: 'needs_reauth', providerIdentity: { email: 'leeroy@company.com', accountId: 'user-1Vb6Nn3Jd9' } }),
    account(CHATGPT, 'bot', 'bot@happier.dev'),
    account(ANTHROPIC, 'build', 'sk-ant-…4f2a', { kind: 'token', authenticationModeId: 'api-key', providerIdentity: undefined }),
    account(GITHUB, 'gh', 'leeroybrun', { kind: 'token', authenticationModeId: 'fine-grained-pat', providerIdentity: undefined }),
];

function pool(service: typeof CLAUDE, groupId: string, displayName: string, strategy: string, active: string, members: readonly string[]): QualifiedConnectedAccountGroupV4 {
    return {
        ref: { service, groupId },
        displayName,
        activeConnectedAccountId: active,
        policy: { strategy, autoSwitch: true },
        state: { activeSince: { accountId: active, atMs: NOW - 88 * MIN } },
        members: members.map((connectedAccountId, priority) => ({ v: 1, connectedAccountId, priority, enabled: true })),
    } as unknown as QualifiedConnectedAccountGroupV4;
}

const POOLS: readonly QualifiedConnectedAccountGroupV4[] = [
    pool(CLAUDE, 'work-pool', 'Work pool', 'least_limited', 'work', ['work', 'personal', 'lab']),
    pool(CHATGPT, 'codex-pool', 'Codex pool', 'priority', 'personal', ['personal', 'bot']),
];

const LABELS: Readonly<Record<string, string>> = {
    'happier.agent.claude%2Fclaude-subscription/work': 'Work',
    'happier.agent.claude%2Fclaude-subscription/personal': 'Personal',
    'happier.agent.claude%2Fclaude-subscription/lab': 'Lab',
    'happier.agent.codex%2Fopenai-codex/personal': 'Personal',
    'happier.agent.codex%2Fopenai-codex/team': 'Team',
    'happier.agent.codex%2Fopenai-codex/bot': 'Bot',
    'happier.agent.claude%2Fanthropic/build': 'Build server',
    'happier.scm.forge.github%2Fgithub-account/gh': '@leeroybrun',
};

const PERSONAL_CHATGPT = { kind: 'account' as const, account: { service: CHATGPT, accountId: 'personal' } };
const AGENT_USES = [
    { agentId: 'claude', title: 'Claude Code', services: [CLAUDE, ANTHROPIC], defaults: [{ kind: 'group' as const, service: CLAUDE, groupId: 'work-pool' }] },
    { agentId: 'codex', title: 'Codex', services: [CHATGPT], defaults: [{ kind: 'group' as const, service: CHATGPT, groupId: 'codex-pool' }] },
    { agentId: 'opencode', title: 'OpenCode', services: [CLAUDE, CHATGPT, ANTHROPIC, OPENAI], defaults: [PERSONAL_CHATGPT] },
    { agentId: 'pi', title: 'Pi', services: [CLAUDE, OPENAI], defaults: [] },
    { agentId: 'gemini', title: 'Gemini CLI', services: [GEMINI], defaults: [] },
];

type Window = readonly [meterId: string, label: string, left: number, resetsInMs: number | null];

function quotaMeter([meterId, label, left, resetsInMs]: Window): ConnectedServiceQuotaMeterV1 {
    return {
        meterId, label, used: null, limit: null, remainingPct: left, unit: 'unknown', utilizationPct: 100 - left,
        resetsAt: resetsInMs === null ? null : NOW + resetsInMs, status: 'ok', details: {},
    } as ConnectedServiceQuotaMeterV1;
}

function credits(expiresInDays: readonly number[]): ConnectedServiceQuotaRecoveryCreditsV1 {
    return {
        availableCount: expiresInDays.length,
        credits: expiresInDays.map((days, index) => ({ id: `credit-${index}`, kind: 'usage_reset', status: 'available', expiresAtMs: NOW + days * DAY })),
    } as unknown as ConnectedServiceQuotaRecoveryCreditsV1;
}

function subscription(renewal: 'on' | 'off', endsInDays: number, checkedAgoMs = 2 * MIN): ProviderAccountSubscriptionV1 {
    return { status: 'subscribed', renewal, observedAtMs: NOW - checkedAgoMs, staleAfterMs: DAY, currentPeriodEndAtMs: NOW + endsInDays * DAY };
}

type CastUsage = Readonly<{
    plan: string | null;
    windows: readonly Window[];
    readAgoMs?: number;
    subscription?: ProviderAccountSubscriptionV1;
    resets?: ConnectedServiceQuotaRecoveryCreditsV1;
    noLimits?: boolean;
}>;

const USAGE: Readonly<Record<string, CastUsage>> = {
    'claude:work': { plan: 'Max', windows: [['5h', '5-hour', 42, 2 * HOUR + 15 * MIN], ['wk', 'Weekly', 64, 4 * DAY + 6 * HOUR], ['opus', 'Weekly · Opus', 88, 4 * DAY + 6 * HOUR], ['sonnet', 'Weekly · Sonnet', 91, 4 * DAY + 6 * HOUR], ['extra', 'Extra usage', 76, null]] },
    'claude:personal': { plan: 'Pro', windows: [['5h', '5-hour', 6, 23 * MIN], ['wk', 'Weekly', 71, 3 * DAY + 2 * HOUR]] },
    'claude:lab': { plan: 'Max', readAgoMs: 3 * DAY, windows: [['5h', '5-hour', 96, 3 * HOUR + 58 * MIN], ['wk', 'Weekly', 73, 6 * DAY + 3 * HOUR], ['opus', 'Weekly · Opus', 100, 6 * DAY + 3 * HOUR]] },
    'chatgpt:personal': { plan: 'Pro', subscription: subscription('on', 17), resets: credits([6, 23, 30]), windows: [['5h', '5-hour', 71, 3 * HOUR + 58 * MIN], ['wk', 'Weekly', 22, 2 * DAY + 21 * HOUR]] },
    'chatgpt:team': { plan: 'Team', subscription: subscription('off', 5, 90 * MIN), readAgoMs: 88 * MIN, windows: [['5h', '5-hour', 64, 4 * HOUR + 25 * MIN], ['wk', 'Weekly', 38, 2 * DAY]] },
    'chatgpt:bot': { plan: 'Plus', subscription: subscription('on', 12), resets: credits([23]), windows: [['5h', '5-hour', 100, 5 * HOUR], ['wk', 'Weekly', 96, 6 * DAY + 23 * HOUR]] },
    'anthropic:build': { plan: null, windows: [], noLimits: true },
};

function shortKey(sheet: ConnectedServicesIndexSheet, accountId: string): string {
    const service = sheet.service.localId === 'claude-subscription' ? 'claude'
        : sheet.service.localId === 'openai-codex' ? 'chatgpt'
            : sheet.service.localId === 'anthropic' ? 'anthropic' : 'other';
    return `${service}:${accountId}`;
}

function factsFor(key: string): ConnectedAccountIndexFacts {
    const usage = USAGE[key];
    if (!usage) return { usage: { kind: 'none' }, planLabel: null, subscription: null, recoveryCredits: null, fetchedAt: null, staleSince: null, refreshing: false, refresh: null };
    const fetchedAt = NOW - (usage.readAgoMs ?? 2 * MIN);
    return {
        usage: usage.noLimits ? { kind: 'noLimits' } : { kind: 'meters', meters: projectIndexMeters(usage.windows.map(quotaMeter)) },
        planLabel: usage.plan,
        subscription: usage.subscription ?? null,
        recoveryCredits: usage.resets ?? null,
        fetchedAt,
        staleSince: usage.readAgoMs && usage.readAgoMs > DAY ? fetchedAt : null,
        refreshing: false,
        refresh: usage.noLimits ? null : noop,
    };
}

function presenter(hidden: boolean): ConnectedAccountIdentityPresenter {
    return (input) => presentConnectedAccountIdentity({ hidden, label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null });
}

/** A5: the Bot account has just connected, so it is not in the Codex pool yet. */
const POOLS_BEFORE_BOT: readonly QualifiedConnectedAccountGroupV4[] = [
    POOLS[0]!,
    pool(CHATGPT, 'codex-pool', 'Codex pool', 'priority', 'personal', ['personal']),
];

function useCastModel(justConnected = false) {
    return React.useMemo(() => buildConnectedServicesIndexModel({
        transport: 'advertised-v4',
        entries: ENTRIES,
        qualifiedAccounts: CAST,
        qualifiedGroups: justConnected ? POOLS_BEFORE_BOT : POOLS,
        legacyServices: [],
        defaultAccountByServiceKey: {},
        resolveLabel: (candidate) => String(candidate?.projectedTitle ?? ''),
        resolveFallbackEntry: () => null,
        presentDiagnostics: () => ({ primary: null, supportDetails: null }),
        loadingLabel: t('common.loading'),
        agentUses: AGENT_USES,
    }), [justConnected]);
}

function isDefaultTarget(target: QualifiedConnectedAccountPurposeBindingTargetV1): readonly string[] {
    return AGENT_USES.filter((agent) => agent.defaults.some((candidate) => JSON.stringify(candidate) === JSON.stringify(target))).map((agent) => agent.agentId);
}

function renderStar(target: QualifiedConnectedAccountPurposeBindingTargetV1, testID: string) {
    const service = target.kind === 'group' ? target.service : target.account.service;
    const defaults = isDefaultTarget(target);
    const choices = AGENT_USES
        .filter((agent) => agent.services.some((candidate) => candidate === service))
        .map((agent) => ({ agentId: agent.agentId, title: agent.title, isDefault: defaults.includes(agent.agentId) }));
    return <AgentDefaultMenuButton testID={testID} presentation="icon" choices={choices} onChange={noop} />;
}

function railMeta(sheet: ConnectedServicesIndexSheet, accountId: string): ConnectedServicesRailAccountMeta {
    const key = shortKey(sheet, accountId);
    if (key === 'chatgpt:team') return { kind: 'signedOut' };
    const usage = USAGE[key];
    if (!usage) return { kind: 'none' };
    if (usage.noLimits) return { kind: 'key' };
    return { kind: 'usage', tightestPct: Math.min(...usage.windows.map((window) => window[2])), stale: (usage.readAgoMs ?? 0) > DAY };
}

function CollectionFrame(props: Readonly<{ presentation: ConnectedServicesIndexPresentation; hidden?: boolean; settled?: boolean }>) {
    const model = useCastModel(props.settled === true);
    const phone = useDeviceType() === 'phone';
    const present = presenter(props.hidden === true);
    const settledSheet = model.sheets.find((sheet) => sheet.service.localId === CHATGPT.localId);
    const settleOffer = props.settled && settledSheet ? selectConnectedAccountSettleOffer({
        account: { service: CHATGPT, accountId: 'bot' },
        pools: settledSheet.pools,
        agentDefault: null,
        labelFor: (accountId) => {
            const entry = settledSheet.accounts.find((candidate) => candidate.accountId === accountId);
            return entry ? presentConnectedServicesIndexAccount(settledSheet, entry, LABELS, present).title : null;
        },
    }) : null;
    const index = (
        <ConnectedServicesIndexView
            model={model}
            labelsByKey={LABELS}
            present={present}
            now={NOW}
            presentation={props.presentation}
            onPresentationChange={noop}
            compact={phone}
            summary={{ needsYouCount: 1, asOf: NOW - 12 * MIN, onRefreshAll: noop }}
            connectMore={(
                <ConnectedServicesConnectMore
                    model={model}
                    layout="section"
                    request={null}
                    onRequestHandled={noop}
                    onConnected={noop}
                />
            )}
            fixProminence="primary"
            settled={props.settled ? {
                serviceKey: 'happier.agent.codex/openai-codex',
                accountId: 'bot',
                node: (
                    <ConnectedAccountSettledView
                        identity={present({ email: 'bot@happier.dev' }).email}
                        offer={settleOffer}
                        primaryAction={settleOffer?.kind === 'pool' ? (
                            <RoundButton
                                testID="connected-services-settle:add-to-pool"
                                size="small"
                                title={t('connectedServicesSetup.settleAddToPool', { pool: settleOffer.poolName })}
                                onPress={noop}
                            />
                        ) : null}
                        onDismiss={noop}
                    />
                ),
            } : null}
            renderAccount={({ sheet, account: indexAccount, render }) => (
                <React.Fragment key={indexAccount.accountId}>{render(factsFor(shortKey(sheet, indexAccount.accountId)))}</React.Fragment>
            )}
            renderPool={({ sheet, pool: indexPool, entry, presentation, showDivider }) => {
                const usage = derivePoolUsage({
                    members: entry.members.map((member) => ({
                        accountId: member.accountId,
                        enabled: member.enabled,
                        meters: (USAGE[shortKey(sheet, member.accountId)]?.windows ?? []).slice(0, 2).map(quotaMeter),
                    })),
                    now: NOW,
                });
                return (
                    <ConnectedServicePoolIndexItemView
                        key={indexPool.ref.groupId}
                        {...entry}
                        usage={usage}
                        presentation={presentation}
                        compact={phone}
                        now={NOW}
                        showDivider={showDivider}
                    />
                );
            }}
            renderStar={renderStar}
            onAddAccount={noop}
            onSignInAgain={noop}
            onOpenAccount={noop}
            onOpenPool={noop}
            renderNewPool={(renderTrigger) => renderTrigger(noop)}
        />
    );
    if (phone) return index;
    return (
        <View style={styles.split}>
            <View style={styles.rail}>
                <ConnectedServicesRailView
                    model={model}
                    labelsByKey={LABELS}
                    selection={{ kind: 'index' }}
                    present={present}
                    identitiesHidden={props.hidden === true}
                    onSetIdentitiesHidden={noop}
                    onConnect={noop}
                    onOpenIndex={noop}
                    onOpenService={noop}
                    onOpenAccount={noop}
                    onOpenPool={noop}
                    onOpenAgentSignIn={noop}
                    renderNewPool={(renderTrigger) => renderTrigger(noop)}
                    renderAccountMeta={(sheet, indexAccount) => <RailAccountMeta meta={railMeta(sheet, indexAccount.accountId)} />}
                />
            </View>
            <View style={styles.detail}>{index}</View>
        </View>
    );
}

function uiGroup(group: QualifiedConnectedAccountGroupV4): QualifiedConnectedAccountUiGroup {
    return {
        ref: group.ref,
        displayName: group.displayName,
        policy: group.policy,
        activeAccountId: group.activeConnectedAccountId,
        revision: { protocol: 'v4', incarnation: 'fixture', generation: 1, runtimeStateRevision: 1 },
        state: {},
        members: group.members.map((member) => ({
            ref: { service: group.ref.service, accountId: member.connectedAccountId },
            priority: member.priority,
            enabled: member.enabled,
            state: {},
        })),
    } as unknown as QualifiedConnectedAccountUiGroup;
}

function DetailFrame(props: Readonly<{ accountKey: 'chatgpt:personal' | 'chatgpt:team' }>) {
    const model = useCastModel();
    const phone = useDeviceType() === 'phone';
    const signedOut = props.accountKey === 'chatgpt:team';
    const accountId = signedOut ? 'team' : 'personal';
    const profile = CAST.find((candidate) => candidate.ref.service === CHATGPT && candidate.ref.accountId === accountId)!;
    const usage = USAGE[props.accountKey]!;
    const facts = factsFor(props.accountKey);
    const present = presenter(false);
    const shown = present({ label: signedOut ? 'Team' : 'Personal', email: profile.providerIdentity?.email ?? null, accountId: profile.providerIdentity?.accountId ?? null });
    const detail = (
        <QualifiedAccountDetailView
            account={profile.ref}
            serviceLabel="ChatGPT"
            legacyServiceId="openai-codex"
            presentation={{ primaryLabel: shown.label ?? '', accessibilityLabel: `ChatGPT · ${shown.label}` }}
            providerEmail={shown.email}
            providerAccountId={shown.accountId}
            planLabel={usage.plan}
            status={profile.status}
            groups={[uiGroup(POOLS[1]!)]}
            agentDefaults={{
                choices: [
                    { agentId: 'codex', title: 'Codex', isDefault: false },
                    { agentId: 'opencode', title: 'OpenCode', isDefault: !signedOut },
                ],
                setDefault: noop,
            }}
            authenticationModeTitle={t('connectedServicesSettings.detailSignedInWithCode')}
            lastUsedAt={NOW - 9 * MIN}
            onOpenPool={noop}
            rename={{ currentLabel: signedOut ? 'Team' : 'Personal', onRename: noop }}
            onReconnect={noop}
            onRefresh={noop}
            onDisconnect={noop}
            usageSection={(
                    <AccountDetailFactsSectionsView
                        facts={{
                            meters: facts.usage.kind === 'meters' ? facts.usage.meters : [],
                            fetchedAt: facts.fetchedAt,
                            planLabel: usage.plan,
                            subscription: usage.subscription ?? null,
                            recoveryCredits: usage.resets ?? null,
                            loading: false,
                            error: false,
                            refreshing: false,
                            refresh: noop,
                        }}
                        signedOut={signedOut}
                        serviceLabel="ChatGPT"
                        now={NOW}
                        resetsSection={signedOut ? null : (
                        <AccountDetailResetsSectionView recoveryCredits={usage.resets ?? null} now={NOW} pending={false} onUse={noop} />
                    )} />
            )}
            usedBySection={(
                <AccountDetailUsedBySectionView
                    rows={signedOut ? [
                        { key: 'pool:Codex', agentId: 'codex', title: 'Codex', subtitle: t('connectedServicesSettings.detailUsedByPool', { pool: 'Codex pool' }), isDefault: false, onPress: noop },
                    ] : [
                        { key: 'direct:OpenCode', agentId: 'opencode', title: 'OpenCode', subtitle: t('connectedServicesCollection.usedByDefault'), isDefault: true, onPress: noop },
                        { key: 'pool:Codex', agentId: 'codex', title: 'Codex', subtitle: t('connectedServicesSettings.detailUsedByPoolInUse', { pool: 'Codex pool' }), isDefault: false, onPress: noop },
                    ]}
                />
            )}
            worksOnSection={(
                <AccountDetailWorksOnSectionView machines={[
                    { id: 'mbp', name: 'MacBook Pro', online: true },
                    { id: 'devbox', name: 'devbox', online: true },
                    { id: 'studio', name: 'Studio', online: false },
                ]} />
            )}
        />
    );
    if (phone) return detail;
    return (
        <View style={styles.split}>
            <View style={styles.rail}>
                <ConnectedServicesRailView
                    model={model}
                    labelsByKey={LABELS}
                    selection={{ kind: 'account', serviceKey: 'happier.agent.codex/openai-codex', accountId }}
                    present={present}
                    identitiesHidden={false}
                    onSetIdentitiesHidden={noop}
                    onConnect={noop}
                    onOpenIndex={noop}
                    onOpenService={noop}
                    onOpenAccount={noop}
                    onOpenPool={noop}
                    onOpenAgentSignIn={noop}
                    renderNewPool={(renderTrigger) => renderTrigger(noop)}
                    renderAccountMeta={(sheet, indexAccount) => <RailAccountMeta meta={railMeta(sheet, indexAccount.accountId)} />}
                />
            </View>
            <View style={styles.detail}>{detail}</View>
        </View>
    );
}

/** MT: the one meter's anatomy, tones, units, unreported and loading rows, stale, pool, and widths. */
function MeterBoard() {
    const rows: ReadonlyArray<readonly [string, React.ReactNode]> = [
        ['Healthy', (
            <UsageMeterStack>
                <UsageMeterRow label="5-hour" remainingPct={71} resetsAt={NOW + 3 * HOUR + 58 * MIN} tone="success" now={NOW} />
                <UsageMeterRow label="Weekly" remainingPct={64} resetsAt={NOW + 4 * DAY + 6 * HOUR} tone="success" now={NOW} />
            </UsageMeterStack>
        )],
        ['Warning · danger', (
            <UsageMeterStack>
                {[22, 6, 0].map((left, index) => (
                    <UsageMeterRow key={index} label={index === 0 ? 'Weekly' : '5-hour'} remainingPct={left} resetsAt={NOW + (index === 0 ? 2 * DAY + 21 * HOUR : 23 * MIN)} tone={resolveQuotaTone(left)} now={NOW} />
                ))}
            </UsageMeterStack>
        )],
        ['Other units', (
            <UsageMeterStack>
                <UsageMeterRow label="Extra usage" remainingPct={76} resetsAt={null} tone="success" now={NOW} />
                <UsageMeterRow label="5-hour" remainingPct={58} resetsAt={NOW + 70 * MIN} tone="neutral" estimated now={NOW} />
            </UsageMeterStack>
        )],
        ['Not reported · loading', (
            <UsageMeterStack>
                <UsageMeterRow label="Weekly · Sonnet" remainingPct={null} resetsAt={null} tone="neutral" now={NOW} />
                <UsageMeterRow label="5-hour" remainingPct={null} resetsAt={null} tone="neutral" now={NOW} loading />
            </UsageMeterStack>
        )],
        ['Stale', (
            <View style={styles.stale}>
                <SurfaceFreshnessLine asOf={NOW - 3 * DAY} reason={t('connectedServicesCollection.usageCheckedMayBeOutOfDate', { time: t('connectedServicesCollection.daysAgo', { count: 3 }) })} action={{ label: t('common.refresh'), onPress: noop }} />
                <UsageMeterStack>
                    <UsageMeterRow label="5-hour" remainingPct={96} resetsAt={NOW + 3 * HOUR + 58 * MIN} tone="success" now={NOW} />
                    <UsageMeterRow label="Weekly" remainingPct={73} resetsAt={NOW + 6 * DAY + 3 * HOUR} tone="success" now={NOW} />
                </UsageMeterStack>
            </View>
        )],
        ['Pool', (
            <UsageMeterStack>
                <UsageMeterRow label="5-hour" remainingPct={48} resetsAt={NOW + 23 * MIN} tone="success" resetPrefix="next" now={NOW} />
                <UsageMeterRow label="Weekly" remainingPct={69} resetsAt={NOW + 3 * DAY + 2 * HOUR} tone="success" resetPrefix="next" now={NOW} />
            </UsageMeterStack>
        )],
        ['Every width', (
            <View style={styles.widths}>
                <View style={styles.width720}><UsageMeterRow label="5-hour" remainingPct={42} resetsAt={NOW + 2 * HOUR + 15 * MIN} tone="success" size="wide" now={NOW} /></View>
                <View style={styles.width460}><UsageMeterRow label="5-hour" remainingPct={42} resetsAt={NOW + 2 * HOUR + 15 * MIN} tone="success" now={NOW} /></View>
                <View style={styles.width340}><UsageMeterRow label="5-hour" remainingPct={42} resetsAt={NOW + 2 * HOUR + 15 * MIN} tone="success" size="card" now={NOW} /></View>
            </View>
        )],
    ];
    return (
        <View style={styles.board}>
            {rows.map(([title, content]) => (
                <View key={title} style={styles.boardRow}>
                    <Text style={styles.boardTitle}>{title}</Text>
                    <View style={styles.boardCard}>{content}</View>
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    split: {
        flex: 1,
        flexDirection: 'row',
    },
    rail: {
        width: 288,
        borderRightWidth: 1,
        borderRightColor: theme.colors.border.default,
    },
    detail: {
        flex: 1,
        minWidth: 0,
    },
    board: {
        padding: 32,
        gap: 18,
    },
    boardRow: {
        flexDirection: 'row',
        gap: 24,
        alignItems: 'flex-start',
    },
    boardTitle: {
        width: 200,
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    boardCard: {
        width: 720,
        padding: 18,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.sectionTint,
    },
    stale: {
        gap: 10,
    },
    widths: {
        gap: 10,
    },
    width720: { width: 680 },
    width460: { width: 460 },
    width340: { width: 340 },
}));
