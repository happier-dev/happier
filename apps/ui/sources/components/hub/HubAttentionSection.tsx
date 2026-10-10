import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SvgXml } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { createAgentSettingsRoute } from '@/agents/catalog/agentSettingsRoutes';
import { resolveConnectedServiceBrandIconXml } from '@/agents/registry/resolveConnectedServiceBrandIconXml';
import {
    useProjectedConnectedServicesRegistry,
    useProjectedPluginLocalizedTextResolver,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useAgentCollection } from '@/components/settings/agents/collection/AgentCollectionList';
import { useAgentAdministrationCatalog } from '@/components/settings/agents/collection/useAgentAdministrationCatalog';
import { usePluginAdministrationSummary } from '@/components/settings/plugins/model/pluginAdministrationSummary';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { resolveConnectedServiceRegistryEntryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { buildConnectedAccountSettingsRoute } from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { listConnectedAccountsNeedingSignIn } from '@/sync/domains/connectedServices/connectedAccountsNeedingSignIn';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { useProfile } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { describeUpdatesSettingsSubtitle } from '@/components/updates/describeUpdatesSummary';
import { UPDATES_ROUTE } from '@/components/updates/updatesRoute';
import { useSharedUpdatesSummary } from '@/updates/useUpdatesSummary';

import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { useSessionGettingStartedGuidanceBaseModel } from '@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { refreshOrdinarySessionList } from '@/sync/domains/session/listing/sessionListQueryRuntime';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { HubSectionProps } from './hubSectionProps';
import { useActivityOverviewSummary } from '@/activity/source/useActivityOverview';

const MARK_SIZE = 18;

export type AttentionItem = Readonly<{
    key: string;
    mark: React.ReactNode;
    title: string;
    actionLabel: string;
    onAction: () => void;
}>;

/** The same pending-Session census as Home's status line and Inbox badge; never reclassified here. */
function useSessionsNeedingAttention(): AttentionItem[] {
    const { needsYouCount } = useActivityOverviewSummary();
    const router = useRouter();
    const { theme } = useUnistyles();
    return React.useMemo(() => needsYouCount > 0 ? [{
        key: 'sessions',
        mark: <Icon name="chat-circle" size={MARK_SIZE} color={theme.colors.text.secondary} />,
        title: t('homeIndex.sessionsAwaitingResponse', { count: needsYouCount }),
        actionLabel: t('settingsOverview.review'),
        onAction: () => router.push('/inbox'),
    }] : [], [needsYouCount, router, theme.colors.text.secondary]);
}

/**
 * Agents on the Agents machine whose CLI reports it is signed out. It reads the last detection the
 * Agents pages made and never probes the machine itself: a sign-in probe can start the agent's CLI.
 */
function useAgentsNeedingSignIn(): AttentionItem[] {
    const router = useRouter();
    const { theme } = useUnistyles();
    const catalog = useAgentAdministrationCatalog({ loadProjection: false });
    const { collection } = useAgentCollection(catalog, '', { detect: false });
    const machine = catalog.executionTarget?.machine ?? null;
    const serverId = catalog.executionTarget?.serverId ?? null;
    return React.useMemo(() => collection.onMachine
        .filter((row) => row.trouble)
        .map((row) => ({
            key: `agent:${row.entry.agentId}`,
            mark: (
                <AgentCatalogIdentityIcon
                    entry={row.entry}
                    machineId={machine?.id ?? null}
                    serverId={serverId}
                    current={catalog.projectionCurrent}
                    color={theme.colors.text.secondary}
                    size={MARK_SIZE}
                />
            ),
            title: catalog.machineLabel
                ? t('settingsOverview.agentNeedsSignIn', { agent: row.entry.title, machine: catalog.machineLabel })
                : t('settingsOverview.agentNeedsSignInNoMachine', { agent: row.entry.title }),
            actionLabel: t('settingsOverview.signIn'),
            onAction: () => router.push(createAgentSettingsRoute(row.entry) as never),
        })), [catalog.machineLabel, catalog.projectionCurrent, collection.onMachine, machine?.id, router, serverId, theme.colors.text.secondary]);
}

/** Connected accounts whose sign-in expired, from the Account profile the app already holds. */
function useConnectedAccountsNeedingSignIn(): AttentionItem[] {
    const router = useRouter();
    const { theme } = useUnistyles();
    const profile = useProfile();
    const accountTransport = resolveConnectedAccountUiNegotiation(useServerFeaturesRuntimeSnapshot());
    const registry = useProjectedConnectedServicesRegistry();
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    return React.useMemo(() => listConnectedAccountsNeedingSignIn({
        profile,
        accountTransport,
        entries: registry.entries,
    }).map((account) => {
        const brandXml = resolveConnectedServiceBrandIconXml(account.entry.legacyServiceId, theme);
        return {
            key: `service:${account.key}`,
            mark: brandXml
                ? <SvgXml xml={brandXml} width={MARK_SIZE} height={MARK_SIZE} />
                : <Icon name="key" size={MARK_SIZE} color={theme.colors.text.secondary} />,
            title: t('settingsOverview.serviceSignInExpired', {
                service: resolveConnectedServiceRegistryEntryDisplayName(account.entry, t, localizePluginText),
            }),
            actionLabel: t('settingsOverview.signInAgain'),
            onAction: () => router.push(buildConnectedAccountSettingsRoute(
                account.service,
                account.accountId ? { kind: 'account', accountId: account.accountId } : null,
                { add: !account.accountId },
            ) as never),
        };
    }), [accountTransport, localizePluginText, profile, registry.entries, router, theme]);
}

/**
 * Updates that wait on the person (an update to take, one that did not finish, a restart), from the
 * shared Updates summary the app shell already computes — never a fetch of its own.
 */
function useUpdatesNeedingAttention(): AttentionItem[] {
    const router = useRouter();
    const { theme } = useUnistyles();
    const summary = useSharedUpdatesSummary();
    const needsPerson = summary.phase === 'available' || summary.phase === 'failed' || summary.phase === 'required' || summary.phase === 'ready';
    const title = needsPerson ? describeUpdatesSettingsSubtitle(summary) : null;
    return React.useMemo(() => (title ? [{
        key: 'updates',
        mark: <Icon name="download" size={MARK_SIZE} color={theme.colors.text.secondary} />,
        title,
        actionLabel: t('updates.action.openUpdates'),
        onAction: () => router.push(UPDATES_ROUTE),
    }] : []), [router, theme.colors.text.secondary, title]);
}

/** Plugin changes the Plugins machine last reported as waiting for a decision (cache only). */
function usePluginChangesAwaitingReview(): AttentionItem[] {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { awaitingDecision } = usePluginAdministrationSummary();
    return React.useMemo(() => (awaitingDecision > 0 ? [{
        key: 'plugins:awaitingReview',
        mark: <Icon name="shield-check" size={MARK_SIZE} color={theme.colors.text.secondary} />,
        title: t('settingsOverview.pluginChangesAwaitingReview', { count: awaitingDecision }),
        actionLabel: t('settingsOverview.review'),
        onAction: () => router.push(SETTINGS_ROUTES.plugins as never),
    }] : []), [awaitingDecision, router, theme.colors.text.secondary]);
}

/**
 * Selected Homes that are not answering, from the getting-started model (the same per-Home
 * reachability fact the Homes status reads). The home never waits on them; it says so here.
 */
function useHomesNotAnswering(): AttentionItem[] {
    const { theme } = useUnistyles();
    const { unavailableServerIds } = useSessionGettingStartedGuidanceBaseModel();
    return React.useMemo(() => unavailableServerIds.map((serverId) => ({
        key: `home:${serverId}`,
        mark: <Icon name="cloud-slash" size={MARK_SIZE} color={theme.colors.text.secondary} />,
        title: t('sidebarFooter.homeUnreachableLine', {
            home: resolveHomeDisplayLabel(getServerProfileById(serverId), t('settingsAccount.thisHome')),
        }),
        actionLabel: t('common.retry'),
        onAction: () => fireAndForget(refreshOrdinarySessionList(serverId), { tag: 'HubAttentionSection.retryHome' }),
    })), [theme.colors.text.secondary, unavailableServerIds]);
}

/**
 * Only what needs the person now, each with the action that resolves it. The section is absent
 * when nothing does: a healthy setup is quiet.
 */
export const HubAttentionSection = React.memo(function HubAttentionSection(props: HubSectionProps) {
    const sessions = useSessionsNeedingAttention();
    const agents = useAgentsNeedingSignIn();
    const services = useConnectedAccountsNeedingSignIn();
    const updates = useUpdatesNeedingAttention();
    const plugins = usePluginChangesAwaitingReview();
    const homes = useHomesNotAnswering();
    const items = [...sessions, ...homes, ...updates, ...agents, ...services, ...plugins];
    return <HubAttentionList items={items} menu={props.menu} />;
});


/** The needs-you rows as drawn, each with its action (the `/dev/home` fixture draws it too). Absent when empty. */
export function HubAttentionList(props: Readonly<{ items: readonly AttentionItem[]; menu?: React.ReactNode }>) {
    const { items } = props;
    if (items.length === 0) return null;
    return (
        <ItemGroup title={t('settingsOverview.attentionTitle')} action={props.menu}>
            {items.map((item) => (
                <Item
                    key={item.key}
                    testID={`settings-overview-attention.${item.key}`}
                    title={item.title}
                    // The mark shares the section's leading column (brand marks are identity; the
                    // glyph marks are the same size), so it is a leading element, not a wrapped icon.
                    leftElement={item.mark}
                    showChevron={false}
                    rightElement={(
                        <RoundButton
                            testID={`settings-overview-attention.${item.key}.action`}
                            size="small"
                            display="secondary"
                            title={item.actionLabel}
                            onPress={item.onAction}
                        />
                    )}
                />
            ))}
        </ItemGroup>
    );
}
