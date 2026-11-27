import * as React from 'react';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
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
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SCHEMA_FIELD_INPUT_STYLE } from '@/components/settings/schemaFields/SchemaFieldRow';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { useHomeAccountRoster } from '@/hooks/home/useHomeAccountRoster';
import { useHomeSettings } from '@/hooks/home/useHomeSettings';
import { useHomeAdministrationRead } from '@/hooks/home/useHomeAdministrationRead';
import { homeMailDeliveryRead, homeReachabilityRead } from '@/sync/engine/home/governance/homeAdministrationReads';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';

import { HomePendingRestartAttentionRow, useHomeServerRelease } from '../runtime/HomeRuntimeSections';
import { useHomeRuntimeExecutor } from '../runtime/homeRuntimeExecutor';
import { HomeAdministrationSection } from './HomeAdministrationSection';
import { HomeConsoleBackScope, useHomeConsoleNavigation } from './HomeConsoleNavigation';
import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import { homeInvitePeopleAction } from './HomeInvitePeopleDialog';
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
import { HomePagedReadFailure } from './HomePagedReadFailure';
import { homeAdmitsStrangers, publicAddressCaption, reachAddressHost } from './homeReachPresentation';
import { homeServerSettingTitle, homeSettingIgnoredReasonLabel } from './homeServerSettingLabels';
import { homeSettingTitle } from './homeServerSettingsRows';
import { homePendingRestartSummary } from './HomeSettingRowState';
import { HOME_OVERVIEW_SETTINGS, HOME_NAME_SETTING_KEY } from './homeOverviewSettings';
import { useHomeSettingsWrite } from './useHomeSettingsWrite';
import {
    homeSignInPlatformForKeys,
    homeSignInPlatformHref,
    homeSignInPlatformMark,
    selectHomeSignInPlatforms,
    type HomeSignInPlatformId,
    type HomeSignInPlatformNeed,
} from '../signInProviders/homeSignInPlatforms';

const PUBLIC_ADDRESS_KEY = SERVER_CONFIG.HAPPIER_PUBLIC_SERVER_URL.key;

type AttentionTone = 'danger' | 'warning' | 'neutral';

/** One thing that needs the owner, with where it is fixed. Healthy facts produce none. */
type AttentionItem = Readonly<{
    id: string;
    icon: IconName | React.ReactElement;
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
            icon: homeSignInPlatformMark(platform.id),
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
            primaryAction={homeInvitePeopleAction(context, 'home-overview-invite')}
            meta={showsRole ? [{
                key: 'role',
                testID: 'home-admin-viewer-role',
                text: `${t('homeGovernance.yourRole')}: ${homeRoleLabel(context.projection.viewer.homeRole)}`,
            }] : []}
        />
    );
});

type OverviewReads = ReturnType<typeof useHomeSettings> & Readonly<{
    mail: ReturnType<typeof useHomeAdministrationRead<HomeMailDeliveryReadinessV1>>['snapshot'];
    reach: ReturnType<typeof useHomeAdministrationRead<HomeReachabilityV1>>['snapshot'];
}>;

const HomeOverview = React.memo(function HomeOverview(props: Readonly<{ context: HomeAdministrationContext }>) {
    const { context } = props;
    const navigation = useHomeConsoleNavigation();
    // One read of each owner for the whole page; attention and facts both render from it.
    const enabled = context.projection.capabilities.viewAdministration;
    const settings = useHomeSettings(context.scope, enabled);
    const { snapshot: mail, refresh: refreshMail } = useHomeAdministrationRead(homeMailDeliveryRead, enabled ? context.scope : null);
    const { snapshot: reach, refresh: refreshReach } = useHomeAdministrationRead(homeReachabilityRead, enabled ? context.scope : null);
    const reload = React.useCallback(async (reason?: Parameters<typeof settings.reload>[0]) => {
        refreshMail();
        refreshReach();
        await settings.reload(reason);
    }, [refreshMail, refreshReach, settings.reload]);
    const reads = React.useMemo(() => ({ ...settings, mail, reach, reload }), [settings, mail, reach, reload]);
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

    const mail = reads.mail?.failure ? null : reads.mail?.data ?? null;
    const reach = reads.reach?.failure ? null : reads.reach?.data ?? null;
    const items = resolveHomeOverviewAttention({ serverId, settings: reads.settings, mail, reach });
    const homeServerIds = [serverId];
    const failures = [
        reads.failure && !reads.settings ? { id: 'settings', reason: t('homeGovernance.overviewPage.settingsFailed') } : null,
        reads.mail?.failure ? { id: 'email', reason: t('homeGovernance.overviewPage.emailFailed') } : null,
        reads.reach?.failure ? { id: 'reach', reason: t('homeGovernance.overviewPage.reachFailed') } : null,
    ].filter((failure): failure is { id: string; reason: string } => failure !== null);
    // Until every owner has answered once, the section keeps its place with quiet placeholders.
    const loading = (reads.loading && !reads.settings && !reads.failure) || (!mail && !reads.mail?.failure) || (!reach && !reads.reach?.failure);
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
                    icon={typeof item.icon === 'string' ? <Icon name={item.icon} color={toneColor(item.tone)} /> : item.icon}
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
    if (!context.projection.capabilities.manageAccounts) return null;
    const { activeOwners, totalAccountCount, totalAdminCount } = context.projection;
    return activeOwners && totalAccountCount !== undefined ? (
        <ItemGroup title={t('homeGovernance.overviewPage.ownership')}>
            <HomeOverviewOwnershipRows context={context} owners={activeOwners} people={totalAccountCount}
                more={false} admins={totalAdminCount ?? null} />
        </ItemGroup>
    ) : <LegacyHomeOverviewOwnership context={context} />;
});

function LegacyHomeOverviewOwnership({ context }: Readonly<{ context: HomeAdministrationContext }>) {
    const roster = useHomeAccountRoster(context.scope, true);
    const owners = roster.rows.filter(isActiveOwner);
    // The roster pages by age, and owners need not be the oldest Accounts: read on (through the
    // roster's own pages) until every active owner the Home counts is listed.
    const ownersMissing = owners.length < context.projection.activeOwnerCount;
    const { hasMore, loadMore, status } = roster;
    React.useEffect(() => {
        if (ownersMissing && hasMore && status === 'ready') loadMore();
    }, [hasMore, loadMore, ownersMissing, status]);

    const settled = roster.status === 'ready' || roster.rows.length > 0;
    return (
        <ItemGroup title={t('homeGovernance.overviewPage.ownership')}>
            {roster.error && (!settled || ownersMissing) ? (
                <HomePagedReadFailure
                    testID="home-overview-ownership-failed"
                    failure={roster.error}
                    fallback={t('homeGovernance.overviewPage.peopleFailed')}
                    reload={roster.reload}
                    serverId={context.scope.serverId}
                />
            ) : null}
            {!settled && !roster.error ? (
                <ItemLoadStateRows
                    testID="home-overview-ownership-loading"
                    state={{ kind: 'loading' }}
                    rows={Math.max(2, context.projection.activeOwnerCount + 1)}
                    accessibilityLabel={t('homeGovernance.overviewPage.ownership')}
                />
            ) : settled ? (
                <HomeOverviewOwnershipRows context={context}
                    owners={owners}
                    people={roster.total ?? roster.rows.length} more={roster.total === null && roster.hasMore}
                    admins={roster.hasMore && !roster.rows.some(row => row.homeRole === 'member')
                        ? null : roster.rows.filter(row => row.homeRole === 'admin').length} />
            ) : null}
        </ItemGroup>
    );
}

function HomeOverviewOwnershipRows({ context, owners, people, more, admins }: Readonly<{
    context: HomeAdministrationContext;
    owners: NonNullable<HomeGovernanceProjectionV1['activeOwners']>;
    people: number;
    more: boolean;
    admins: number | null;
}>) {
    const router = useRouter();
    return (
        <>
            {owners.map((row) => {
                const person = resolveAccountDisplayName({
                    profile: row.profile,
                    accountId: row.accountId,
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
                        leftElement={<Avatar id={row.accountId} size={PAGE_LIST_METRICS.rowIdentityMarkPx} imageUrl={row.profile.avatarUrl ?? null} monogram={person.named ? person.name : null} />}
                        mode="info"
                        showChevron={false}
                    />
                );
            })}
            <Item
                testID="home-overview-people"
                title={t('homeGovernance.people')}
                // A navigation row carries its glyph; the page column keeps its title on the owners' edge.
                icon={<Icon name="user-circle" />}
                subtitle={t('homeGovernance.overviewPage.peopleSummary', {
                    people,
                    more,
                    owners: context.projection.activeOwnerCount,
                    admins,
                })}
                onPress={() => router.push(homeAdministrationPeoplePath(context.scope.serverId) as never)}
            />
        </>
    );
}

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
    const [draft, setDraft] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const onFieldError = React.useCallback((_key: string, message: string | null) => {
        setError(message);
    }, []);
    const { writing, write } = useHomeSettingsWrite({ context, home: reads, onFieldError, onFailure: setError });
    const current = typeof entry?.value === 'string' && entry.value.trim() ? entry.value : context.homeName;
    const rename = React.useCallback(async () => {
        const trimmed = draft?.trim();
        if (!trimmed || trimmed === current || writing) return;
        if (await write({ key: HOME_NAME_SETTING_KEY, values: { [HOME_NAME_SETTING_KEY]: trimmed } })) {
            setDraft(null);
            setError(null);
            context.refresh();
        }
    }, [context, current, draft, write, writing]);
    if (!entry) return null;
    const canRename = context.projection.capabilities.manageHomeSettings && !entry.fixed && entry.editable === 'home';
    return (
        <SettingAnchor setting={HOME_OVERVIEW_SETTINGS.settings.homeName}>
            <Item
                testID="home-overview-name"
                title={homeServerSettingTitle(HOME_NAME_SETTING_KEY)}
                subtitle={entry.fixed ? undefined : t('homeGovernance.overviewPage.nameDescription')}
                subtitleAccessory={entry.fixed ? <HomeDeploymentFixedNote keys={[entry.key]} testID="home-overview-name" /> : undefined}
                // The page header is the Home's name; the row says where it shows and offers Rename.
                // A name the Home cannot rename keeps its value here, beside the deployment note.
                detail={draft === null && !canRename ? current : undefined}
                accessoryLayout={draft === null ? undefined : 'adaptive'}
                mode="info"
                showChevron={false}
                rightElement={canRename && draft !== null ? (
                    <SectionButtonRow>
                        <FieldTextInput
                            testID="home-overview-name.input"
                            accessibilityLabel={homeServerSettingTitle(HOME_NAME_SETTING_KEY)}
                            value={draft}
                            onChangeText={(value) => { setDraft(value); setError(null); }}
                            editable={context.mutationsAvailable && !writing}
                            autoFocus
                            error={error}
                            style={SCHEMA_FIELD_INPUT_STYLE}
                        />
                        <RoundButton testID="home-overview-name.cancel" size="small" display="inverted" title={t('common.cancel')} disabled={writing} onPress={() => { setDraft(null); setError(null); }} />
                        <RoundButton testID="home-overview-name.save" size="small" title={t('common.save')} loading={writing} disabled={!context.mutationsAvailable || !draft.trim() || draft.trim() === current} onPress={() => void rename()} />
                    </SectionButtonRow>
                ) : canRename ? (
                    <RoundButton
                        testID="home-overview-name.rename"
                        size="small"
                        display="inverted"
                        title={t('common.rename')}
                        loading={writing}
                        disabled={!context.mutationsAvailable}
                        onPress={() => { setDraft(current); setError(null); }}
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
    const reach = reads.reach?.failure ? null : reads.reach?.data ?? null;
    const flavor = release.flavor === 'full'
        ? t('homeGovernance.runtime.flavorFull')
        : release.flavor === 'light' ? t('homeGovernance.runtime.flavorLight') : null;
    const version = release.version
        ? t('homeGovernance.runtime.versionValue', { version: release.version })
        : t('homeGovernance.runtime.versionUnknown');
    return (
        <ItemGroup title={t('homeGovernance.overviewPage.thisHome')}>
            <HomeOverviewNameRow context={context} reads={reads} />
            <Item
                testID="home-overview-version"
                title={t('homeGovernance.overviewPage.version')}
                subtitle={release.version ? flavor ?? undefined : undefined}
                detail={version}
                mode="info"
                showChevron={false}
            />
            {canView ? (
                reach ? (
                    <Item
                        testID="home-overview-address"
                        title={t('homeGovernance.reach.publicAddress')}
                        subtitle={[reachAddressHost(reach.publicAddress.url), publicAddressCaption(reach)]
                            .filter((part): part is string => Boolean(part)).join(' · ') || undefined}
                        subtitleLines={0}
                        subtitleAccessory={reach.publicAddress.source === 'deployment'
                            ? <HomeDeploymentFixedNote keys={[PUBLIC_ADDRESS_KEY]} testID="home-overview-address" />
                            : undefined}
                        onPress={() => router.push(homeAdministrationReachPath(serverId) as never)}
                    />
                ) : reads.reach?.failure ? null : (
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
                    // One line per page, as the sidebar it stands in for; a Home with Teams turned
                    // off still opens Teams, and only that row says why.
                    subtitle={destination.id === 'teams' && !props.projection.teamsEnabled
                        ? t('homeGovernance.teamsDisabled')
                        : undefined}
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
