import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type {
    HomeAccountRowV1,
    HomeGovernanceProjectionV1,
    HomeMailDeliveryReadinessV1,
    HomeReachabilityV1,
    HomeSettingsProjectionV1,
} from '@happier-dev/protocol/home/governance';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';
import { useUnistyles } from 'react-native-unistyles';

import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { useHomeAccountRoster } from '@/hooks/home/useHomeAccountRoster';
import { Modal } from '@/modal';
import { useHomeSettingsWithCompanion, type HomeSettingsWithCompanion } from '@/hooks/home/useHomeSettingsWithCompanion';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import {
    getHomeMailDelivery,
    getHomeReachability,
    type HomeGovernanceQueryOutcome,
} from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';

import { HomePendingRestartAttentionRow, useHomeServerRelease } from '../runtime/HomeRuntimeSections';
import { useHomeRuntimeExecutor } from '../runtime/homeRuntimeExecutor';
import { HomeAdministrationSection } from './HomeAdministrationSection';
import { HomeConsoleBackScope, useHomeConsoleNavigation } from './HomeConsoleNavigation';
import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import { HomeInvitePeopleButton } from './HomeInvitePeopleDialog';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import {
    homeAdministrationEmailPath,
    homeAdministrationHomesPath,
    homeAdministrationPeoplePath,
    homeAdministrationPoliciesPath,
    homeAdministrationReachPath,
    homeAdministrationRuntimePath,
    homeAdministrationServerSettingsPath,
} from './homeAdministrationRoutes';
import { resolveHomeConsoleDestinations } from './homeConsoleDestinations';
import { homeRoleLabel } from './homeGovernanceLabels';
import { homeAdmitsStrangers, publicAddressCaption, reachAddressHost } from './homeReachPresentation';
import { homeServerSettingTitle, homeSettingIgnoredReasonLabel } from './homeServerSettingLabels';
import { homeSettingTitle } from './homeServerSettingsRows';
import { homePendingRestartSummary } from './HomeSettingRowState';
import { HOME_OVERVIEW_SETTINGS, HOME_NAME_SETTING_KEY } from './homeOverviewSettings';
import { useHomeSettingsWrite } from './useHomeSettingsWrite';
import {
    homeSignInPlatformForKeys,
    homeSignInPlatformHref,
    homeSignInPlatformIcon,
    selectHomeSignInPlatforms,
    type HomeSignInPlatformId,
    type HomeSignInPlatformNeed,
} from '../signInProviders/homeSignInPlatforms';

/** The two reads only their server owners can answer, each kept with its own outcome. */
type OverviewCompanion = Readonly<{
    mail: HomeGovernanceQueryOutcome<HomeMailDeliveryReadinessV1>;
    reach: HomeGovernanceQueryOutcome<HomeReachabilityV1>;
}>;

/**
 * Mail readiness and reachability ride along with `home.settings.get` (the pending/ignored/fixed
 * facts). Each keeps its own outcome, so a Home that answers one and not the other still shows the
 * one it answered and says which it could not read.
 */
async function readOverviewCompanion(scope: ServerAccountScope): Promise<HomeGovernanceQueryOutcome<OverviewCompanion>> {
    const [mail, reach] = await Promise.all([getHomeMailDelivery({ scope }), getHomeReachability({ scope })]);
    return { kind: 'succeeded', value: { mail, reach } };
}

const PUBLIC_ADDRESS_KEY = SERVER_CONFIG.HAPPIER_PUBLIC_SERVER_URL.key;

type AttentionTone = 'danger' | 'warning' | 'neutral';

/** One thing that needs the owner, with where it is fixed. Healthy facts produce none. */
type AttentionItem = Readonly<{
    id: string;
    icon: IconName;
    tone: AttentionTone;
    title: string;
    body: string;
    /** A button for a thing to do; absent, the whole row opens `path`. */
    actionLabel?: string;
    path: string;
}>;

/**
 * What needs the owner right now (lab `hcOverview-A`/`-I`), from the owners' own answers: the
 * startup snapshot (ignored and pending restart values, deployment locks), mail readiness and the
 * effective public address. Each reads `null` until its owner has answered.
 */
export function resolveHomeOverviewAttention(input: Readonly<{
    serverId: string;
    settings: HomeSettingsProjectionV1 | null;
    mail: HomeMailDeliveryReadinessV1 | null;
    reach: HomeReachabilityV1 | null;
}>): AttentionItem[] {
    const { serverId, settings, mail, reach } = input;
    const items: AttentionItem[] = [];
    const ignored = settings?.entries.filter((entry) => entry.applied?.ignoredReason) ?? [];
    const firstIgnored = ignored[0];
    if (firstIgnored?.applied?.ignoredReason) {
        items.push({
            id: 'ignored',
            icon: 'warning',
            tone: 'danger',
            title: ignored.length === 1
                ? t('homeSettings.banner.ignoredTitle')
                : t('homeSettings.banner.ignoredTitleMany', { count: ignored.length }),
            body: t('homeSettings.banner.ignoredBody', {
                setting: homeSettingTitle(firstIgnored),
                reason: homeSettingIgnoredReasonLabel(firstIgnored.applied.ignoredReason),
            }),
            actionLabel: t('homeGovernance.overviewPage.review'),
            // A sign-in platform key is fixed on its own row, not on Server settings (AM-12).
            path: platformPath(serverId, firstIgnored.key) ?? homeAdministrationServerSettingsPath(serverId),
        });
    }
    // Saved values waiting for a restart come next: one action applies them all (lab `hcOverview-R`).
    // The row itself restarts where this device can, and leads to Runtime elsewhere. Values the
    // deployment fixes are healthy facts each row states, never attention (DR-14).
    const pending = settings?.entries.filter((entry) => entry.applied?.pending === true) ?? [];
    if (pending.length > 0) {
        items.push({
            id: 'pending',
            icon: 'arrow-clockwise',
            tone: 'warning',
            title: t('homeGovernance.runtime.pendingRestart', { count: pending.length }),
            body: homePendingRestartSummary(pending),
            actionLabel: t('homeGovernance.overviewPage.review'),
            path: homeAdministrationRuntimePath(serverId),
        });
    }
    // A sign-in platform half set up is trouble: the row it leads to opens with the missing field.
    for (const platform of settings ? selectHomeSignInPlatforms(settings) : []) {
        if (platform.state.kind !== 'partly_set') continue;
        items.push({
            id: `platform:${platform.id}`,
            icon: homeSignInPlatformIcon(platform.id),
            tone: 'warning',
            title: platform.id === 'github'
                ? t('homeGovernance.overviewPage.githubPartlySetUp')
                : t('homeGovernance.overviewPage.workosPartlySetUp'),
            body: platformNeedBody(platform.id, platform.state.need),
            actionLabel: t('homeGovernance.overviewPage.finish'),
            path: homeSignInPlatformHref(serverId, platform.id),
        });
    }
    if (mail && !mail.ready) {
        const copy = mail.passwordUnreadable
            ? { title: t('homeGovernance.overviewPage.emailPasswordTitle'), body: t('homeGovernance.overviewPage.emailPasswordBody'), action: t('homeGovernance.overviewPage.openEmail') }
            : mail.transportConfigured
                ? { title: t('homeGovernance.overviewPage.emailNoLinkTitle'), body: t('homeGovernance.overviewPage.emailNoLinkBody'), action: t('homeGovernance.overviewPage.openEmail') }
                : { title: t('homeGovernance.overviewPage.emailNotSetUpTitle'), body: t('homeGovernance.overviewPage.emailNotSetUpBody'), action: t('homeGovernance.overviewPage.setUpEmail') };
        items.push({
            id: 'email',
            icon: 'envelope',
            tone: 'warning',
            title: copy.title,
            body: copy.body,
            actionLabel: copy.action,
            path: homeAdministrationEmailPath(serverId),
        });
    }
    if (reach && reach.publicAddress.source === 'none') {
        items.push({
            id: 'address',
            icon: 'globe',
            tone: 'warning',
            title: t('homeGovernance.overviewPage.noAddressTitle'),
            body: t('homeGovernance.overviewPage.noAddressBody'),
            actionLabel: t('homeGovernance.overviewPage.setUpReach'),
            path: homeAdministrationReachPath(serverId),
        });
    }
    return items;
}

/** What a half-set platform needs, and what that blocks (lab `hcOverview-R`). */
function platformNeedBody(id: HomeSignInPlatformId, need: HomeSignInPlatformNeed): string {
    if (id === 'workos') {
        return need === 'apiKey'
            ? t('homeGovernance.overviewPage.workosNeedsApiKeyBody')
            : t('homeGovernance.overviewPage.workosNeedsClientIdBody');
    }
    return need === 'clientSecret'
        ? t('homeGovernance.overviewPage.githubNeedsClientSecretBody')
        : t('homeGovernance.overviewPage.githubNeedsClientIdBody');
}

function platformPath(serverId: string, key: string): string | null {
    const platform = homeSignInPlatformForKeys([key]);
    return platform ? homeSignInPlatformHref(serverId, platform) : null;
}

/** The Home's name heads the page, with Invite people as its action (lab `hcOverview-A`). */
const HomeOverviewHeader = React.memo(function HomeOverviewHeader(props: Readonly<{ context: HomeAdministrationContext }>) {
    const { context } = props;
    // The console sidebar beside the page already says who the viewer is; elsewhere the header does.
    const showsRole = useHomeConsoleNavigation() !== 'sidebar';
    return (
        <PageHeader
            testID="home-admin-header"
            alwaysShowTitle
            title={context.homeName || t('homeGovernance.title')}
            description={t('homeGovernance.overviewPage.description')}
            actions={<HomeInvitePeopleButton context={context} testID="home-overview-invite" />}
            meta={showsRole ? [{
                key: 'role',
                testID: 'home-admin-viewer-role',
                text: `${t('homeGovernance.yourRole')}: ${homeRoleLabel(context.projection.viewer.homeRole)}`,
            }] : []}
        />
    );
});

type OverviewReads = HomeSettingsWithCompanion<OverviewCompanion>;

const HomeOverview = React.memo(function HomeOverview(props: Readonly<{ context: HomeAdministrationContext }>) {
    const { context } = props;
    const navigation = useHomeConsoleNavigation();
    // One read of each owner for the whole page; attention and facts both render from it.
    const reads = useHomeSettingsWithCompanion(context.scope, context.projection.capabilities.viewAdministration, readOverviewCompanion);
    return (
        <>
            <HomeOverviewAttention context={context} reads={reads} />
            {/* On a phone the console has no sidebar or menu: Overview lists its pages (lab `hcOverview-P`). */}
            {navigation === 'index' ? <HomeConsoleIndex serverId={context.scope.serverId} projection={context.projection} /> : null}
            <HomeOverviewOwnership context={context} />
            <HomeOverviewFacts context={context} reads={reads} />
        </>
    );
});

const HomeOverviewAttention = React.memo(function HomeOverviewAttention(props: Readonly<{
    context: HomeAdministrationContext;
    reads: OverviewReads;
}>) {
    const { context, reads } = props;
    const { theme } = useUnistyles();
    const router = useRouter();
    const serverId = context.scope.serverId;
    if (!context.projection.capabilities.viewAdministration) return null;

    const mail = reads.companion?.mail.kind === 'succeeded' ? reads.companion.mail.value : null;
    const reach = reads.companion?.reach.kind === 'succeeded' ? reads.companion.reach.value : null;
    const items = resolveHomeOverviewAttention({ serverId, settings: reads.settings, mail, reach });
    const homeServerIds = [serverId];
    const failures = [
        reads.failure && !reads.settings ? { id: 'settings', reason: t('homeGovernance.overviewPage.settingsFailed') } : null,
        reads.companion?.mail.kind === 'failed' ? { id: 'email', reason: t('homeGovernance.overviewPage.emailFailed') } : null,
        reads.companion?.reach.kind === 'failed' ? { id: 'reach', reason: t('homeGovernance.overviewPage.reachFailed') } : null,
    ].filter((failure): failure is { id: string; reason: string } => failure !== null);
    // Until every owner has answered once, the section keeps its place with quiet placeholders.
    const loading = (reads.loading && !reads.settings && !reads.failure) || reads.companion === null;
    if (!loading && items.length === 0 && failures.length === 0) return null;

    const toneColor = (tone: AttentionTone) => tone === 'danger'
        ? theme.colors.state.danger.foreground
        : tone === 'warning' ? theme.colors.state.warning.foreground : theme.colors.text.secondary;
    return (
        <ItemGroup title={t('homeGovernance.overviewPage.attention')}>
            {items.map((item) => item.id === 'pending' ? (
                <HomeOverviewPendingRestart
                    key={item.id}
                    context={context}
                    reads={reads}
                    summary={item.body}
                    onReview={() => router.push(item.path as never)}
                />
            ) : (
                <Item
                    key={item.id}
                    testID={`home-overview-attention:${item.id}`}
                    icon={<Icon name={item.icon} color={toneColor(item.tone)} />}
                    title={item.title}
                    titleLines={0}
                    subtitle={item.body}
                    subtitleLines={0}
                    onPress={item.actionLabel ? undefined : () => router.push(item.path as never)}
                    rightElement={item.actionLabel ? (
                        <RoundButton
                            testID={`home-overview-attention:${item.id}.action`}
                            size="small"
                            display="secondary"
                            title={item.actionLabel}
                            onPress={() => router.push(item.path as never)}
                        />
                    ) : undefined}
                />
            ))}
            {failures.map((failure) => (
                <ItemLoadStateRows
                    key={failure.id}
                    testID={`home-overview-attention-failed:${failure.id}`}
                    state={{ kind: 'failed', reason: failure.reason, onRetry: reads.reload, homeServerIds }}
                />
            ))}
            {loading ? (
                <ItemLoadStateRows
                    testID="home-overview-attention-loading"
                    state={{ kind: 'loading' }}
                    rows={2}
                    accessibilityLabel={t('homeGovernance.overviewPage.attention')}
                />
            ) : null}
        </ItemGroup>
    );
});

/** The pending-restart row with this device's executor for the Home, resolved only while it shows. */
const HomeOverviewPendingRestart = React.memo(function HomeOverviewPendingRestart(props: Readonly<{
    context: HomeAdministrationContext;
    reads: OverviewReads;
    summary: string;
    onReview: () => void;
}>) {
    const { context, reads } = props;
    const serverId = context.scope.serverId;
    const release = useHomeServerRelease(serverId, context.projection.capabilities.viewAdministration);
    const executor = useHomeRuntimeExecutor(serverId, release.flavor);
    return (
        <HomePendingRestartAttentionRow
            testID="home-overview-attention:pending"
            context={context}
            executor={executor}
            pendingCount={reads.settings?.entries.filter((entry) => entry.applied?.pending === true).length ?? 0}
            pendingSummary={props.summary}
            onRestarted={reads.reload}
            onReview={props.onReview}
        />
    );
});

function isActiveOwner(row: HomeAccountRowV1): boolean {
    return row.homeRole === 'owner' && row.status === 'active';
}

/** Who owns the Home, and how many people it has (lab `hcOverview-A` Ownership). */
const HomeOverviewOwnership = React.memo(function HomeOverviewOwnership(props: Readonly<{ context: HomeAdministrationContext }>) {
    const { context } = props;
    const router = useRouter();
    const canList = context.projection.capabilities.manageAccounts;
    const roster = useHomeAccountRoster(context.scope, canList);
    const owners = roster.rows.filter(isActiveOwner);
    // The roster pages by age, and owners need not be the oldest Accounts: read on (through the
    // roster's own pages) until every active owner the Home counts is listed.
    const ownersMissing = owners.length < context.projection.activeOwnerCount;
    const { hasMore, loadMore, status } = roster;
    React.useEffect(() => {
        if (canList && ownersMissing && hasMore && status === 'ready') loadMore();
    }, [canList, hasMore, loadMore, ownersMissing, status]);
    if (!canList) return null;

    const settled = roster.status === 'ready' || roster.rows.length > 0;
    return (
        <ItemGroup title={t('homeGovernance.overviewPage.ownership')}>
            {!settled && roster.error ? (
                <ItemLoadStateRows
                    testID="home-overview-ownership-failed"
                    state={{
                        kind: 'failed',
                        reason: t('homeGovernance.overviewPage.peopleFailed'),
                        onRetry: roster.reload,
                        homeServerIds: [context.scope.serverId],
                    }}
                />
            ) : !settled ? (
                <ItemLoadStateRows
                    testID="home-overview-ownership-loading"
                    state={{ kind: 'loading' }}
                    rows={Math.max(2, context.projection.activeOwnerCount + 1)}
                    accessibilityLabel={t('homeGovernance.overviewPage.ownership')}
                />
            ) : (
                <>
                    {owners.map((row) => {
                        const person = resolveAccountDisplayName({
                            profile: row.profile,
                            accountId: row.accountId,
                            signInEmail: row.authentication.signInEmail,
                            viewerAccountId: context.scope.accountId,
                        });
                        return (
                            <Item
                                key={row.accountId}
                                testID={`home-overview-owner:${row.accountId}`}
                                title={person.name}
                                subtitle={person.viewer && person.named
                                    ? t('homeGovernance.overviewPage.ownerYou')
                                    : homeRoleLabel('owner')}
                                leftElement={<Avatar id={row.accountId} size={28} imageUrl={row.profile.avatarUrl ?? null} />}
                                mode="info"
                                showChevron={false}
                            />
                        );
                    })}
                    <Item
                        testID="home-overview-people"
                        title={t('homeGovernance.people')}
                        subtitle={t('homeGovernance.overviewPage.peopleSummary', {
                            people: roster.rows.length,
                            more: roster.hasMore,
                            owners: context.projection.activeOwnerCount,
                            // Only a complete roster can count its admins.
                            admins: roster.hasMore ? null : roster.rows.filter((row) => row.homeRole === 'admin').length,
                        })}
                        onPress={() => router.push(homeAdministrationPeoplePath(context.scope.serverId) as never)}
                    />
                </>
            )}
        </ItemGroup>
    );
});

/** The login methods this Home offers now, by name, and who may create an account. */
function signInSummary(projection: HomeGovernanceProjectionV1): string {
    const methods = projection.authenticationOptions.methods
        .filter((method) => method.actions.some((action) => action.id === 'login' && action.enabled))
        .map((method) => method.displayName ?? method.id);
    if (methods.length === 0) return t('homeGovernance.overviewPage.signInNone');
    const admission = homeAdmitsStrangers(projection)
        ? t('homeGovernance.overviewPage.signInOpen')
        : t('homeGovernance.overviewPage.signInInvited');
    return `${methods.join(', ')} · ${admission}`;
}

/**
 * The Home's own name, edited where it is shown (DR-08, lab `hcOverview-R`): the same registry key
 * and `home.settings.set` as every other setting. A name the deployment fixes says so instead.
 */
const HomeOverviewNameRow = React.memo(function HomeOverviewNameRow(props: Readonly<{
    context: HomeAdministrationContext;
    reads: OverviewReads;
}>) {
    const { context, reads } = props;
    const entry = reads.settings?.entries.find((candidate) => candidate.key === HOME_NAME_SETTING_KEY);
    // The prompt has closed by the time the Home refuses a name, so the refusal is said in a dialog.
    const onFieldError = React.useCallback((_key: string, message: string | null) => {
        if (message) void Modal.alertAsync(t('server.renameServer'), message);
    }, []);
    const { writing, write } = useHomeSettingsWrite({ context, home: reads, onFieldError });
    const current = typeof entry?.value === 'string' && entry.value.trim() ? entry.value : context.homeName;
    const rename = React.useCallback(async () => {
        const next = await Modal.prompt(t('server.renameServer'), t('server.renameServerPrompt'), {
            defaultValue: current,
            confirmText: t('common.save'),
        });
        const trimmed = next?.trim();
        if (!trimmed || trimmed === current) return;
        if (await write({ key: HOME_NAME_SETTING_KEY, values: { [HOME_NAME_SETTING_KEY]: trimmed } })) context.refresh();
    }, [context, current, write]);
    if (!entry) return null;
    const canRename = context.projection.capabilities.manageHomeSettings && !entry.fixed && entry.editable === 'home';
    return (
        <SettingAnchor setting={HOME_OVERVIEW_SETTINGS.settings.homeName}>
            <Item
                testID="home-overview-name"
                title={homeServerSettingTitle(HOME_NAME_SETTING_KEY)}
                subtitle={entry.fixed ? undefined : t('homeGovernance.overviewPage.nameDescription')}
                subtitleAccessory={entry.fixed ? <HomeDeploymentFixedNote keys={[entry.key]} testID="home-overview-name" /> : undefined}
                detail={current}
                mode="info"
                showChevron={false}
                rightElement={canRename ? (
                    <RoundButton
                        testID="home-overview-name.rename"
                        size="small"
                        display="inverted"
                        title={t('common.rename')}
                        loading={writing}
                        disabled={!context.mutationsAvailable}
                        onPress={() => { void rename(); }}
                    />
                ) : undefined}
            />
        </SettingAnchor>
    );
});

/** Version, public address and sign-in: the facts that describe this Home (lab `hcOverview-A` This Home). */
const HomeOverviewFacts = React.memo(function HomeOverviewFacts(props: Readonly<{
    context: HomeAdministrationContext;
    reads: OverviewReads;
}>) {
    const { context, reads } = props;
    const router = useRouter();
    const serverId = context.scope.serverId;
    const canView = context.projection.capabilities.viewAdministration;
    const release = useHomeServerRelease(serverId, canView);
    const reach = reads.companion?.reach.kind === 'succeeded' ? reads.companion.reach.value : null;
    const flavor = release.flavor === 'full'
        ? t('homeGovernance.runtime.flavorFull')
        : release.flavor === 'light' ? t('homeGovernance.runtime.flavorLight') : null;
    const version = release.version
        ? [t('homeGovernance.runtime.versionValue', { version: release.version }), flavor].filter(Boolean).join(' · ')
        : t('homeGovernance.runtime.versionUnknown');
    return (
        <ItemGroup title={t('homeGovernance.overviewPage.thisHome')}>
            <HomeOverviewNameRow context={context} reads={reads} />
            <Item
                testID="home-overview-version"
                title={t('homeGovernance.overviewPage.version')}
                detail={version}
                mode="info"
                showChevron={false}
            />
            {canView ? (
                reach ? (
                    <Item
                        testID="home-overview-address"
                        title={t('homeGovernance.reach.publicAddress')}
                        subtitle={publicAddressCaption(reach)}
                        subtitleAccessory={reach.publicAddress.source === 'deployment'
                            ? <HomeDeploymentFixedNote keys={[PUBLIC_ADDRESS_KEY]} testID="home-overview-address" />
                            : undefined}
                        detail={reachAddressHost(reach.publicAddress.url) ?? undefined}
                        onPress={() => router.push(homeAdministrationReachPath(serverId) as never)}
                    />
                ) : reads.companion?.reach.kind === 'failed' ? null : (
                    <ItemLoadStateRows testID="home-overview-address-loading" state={{ kind: 'loading' }} rows={1} />
                )
            ) : null}
            <Item
                testID="home-overview-sign-in"
                title={t('homeGovernance.overviewPage.signIn')}
                subtitle={signInSummary(context.projection)}
                subtitleLines={0}
                onPress={context.projection.capabilities.manageAuthentication || context.projection.capabilities.manageTeamCreationPolicy
                    ? () => router.push(homeAdministrationPoliciesPath(serverId) as never)
                    : undefined}
                showChevron={context.projection.capabilities.manageAuthentication || context.projection.capabilities.manageTeamCreationPolicy}
            />
        </ItemGroup>
    );
});

/** The console's pages as rows that push each page (every page but Overview, which this is). */
const HomeConsoleIndex = React.memo(function HomeConsoleIndex(props: Readonly<{
    serverId: string;
    projection: HomeGovernanceProjectionV1;
}>) {
    const router = useRouter();
    const destinations = resolveHomeConsoleDestinations(props.projection)
        .flat()
        .filter((destination) => destination.id !== 'overview');
    if (destinations.length === 0) return null;
    return (
        <ItemGroup title={t('homeGovernance.console.administer')}>
            {destinations.map((destination) => (
                <Item
                    key={destination.id}
                    testID={`home-admin-${destination.id}-link`}
                    icon={<Icon name={destination.icon} />}
                    title={t(destination.titleKey)}
                    // A Home with Teams turned off still opens Teams, which says so and why.
                    subtitle={destination.id === 'teams' && !props.projection.teamsEnabled
                        ? t('homeGovernance.teamsDisabled')
                        : t(destination.subtitleKey)}
                    onPress={() => router.push(destination.path(props.serverId) as never)}
                />
            ))}
        </ItemGroup>
    );
});

/**
 * The Home console's Overview (plan §3.10, lab `hcOverview-A`): what needs the owner, who owns the
 * Home, and the facts that describe it — each from its canonical owner, each section with its own
 * loading and failure. The console's pages are its sidebar or menu beside it; only on a phone, where
 * neither exists, does Overview list them too (lab `hcOverview-P`). Invite people is the page action.
 */
export const HomeAdministrationOverviewScreen = React.memo(function HomeAdministrationOverviewScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        // Overview is the console's first page: its way back to all Homes is in the console's rail or menu.
        <HomeConsoleBackScope parentPathname={homeAdministrationHomesPath()} shownBy="consoleNavigation">
            <HomeAdministrationSection
                serverId={props.serverId}
                title={t('homeGovernance.title')}
                description={t('homeGovernance.overviewPage.description')}
                renderHeader={(context) => <HomeOverviewHeader context={context} />}
            >
                {(context) => <HomeOverview context={context} />}
            </HomeAdministrationSection>
        </HomeConsoleBackScope>
    );
});
