import * as React from 'react';
import type { AccountApiTokenSummaryV1 } from '@happier-dev/protocol';
import { Redirect, useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { actionIdFamilyTitleKey } from '@/components/settings/actions/actionSettingsFamily';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useAllMachines, useAllSessions, useAutomations } from '@/sync/store/hooks';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { getMachineDisplayName, getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import { buildApiTokenRowPresentation } from './apiTokenSettingsPresentation';
import { API_TOKENS_COLLECTION_ROOT, apiTokenEmbedDetailPath } from './collection/apiTokensCollection';
import { useApiTokenSettingsScopeController } from './collection/ApiTokenSettingsScope';
import { apiTokenGrantModelKey, apiTokenGrantOffersAutomations } from './grant/apiTokenGrantDraft';
import { useApiTokenGrantActionGroups, useApiTokenGrantModelGroups } from './grant/useApiTokenGrantCatalogs';
import { resolveApiTokenGrantActionTitle } from './grant/apiTokenGrantCatalog';
import { summarizeApiTokenGrantPermissionModes, useApiTokenGrantModeAgentType } from './grant/apiTokenGrantPermissionModes';
import { useApiTokenOperations } from './useApiTokenOperations';
import { useApiTokenSettingsClock } from './useApiTokenSettingsClock';
import { useApiTokenSettingsControllerState } from './useApiTokenSettingsControllerState';

type RouteParam = string | string[] | undefined;

function formatInstant(at: string): string {
    return formatWithCachedDateTimeFormatter(new Date(at), undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * `/settings/account/api-tokens/[tokenId]`: what one token can do, where, with which models, whether
 * it approves, from which websites, and its content access (plan 01 §6.2). A read view: Edit access
 * opens the grant editor, and Revoke closes the page. An embed-backed token opens Embeds instead.
 */
export const ApiTokenDetailScreen = React.memo(function ApiTokenDetailScreen() {
    const params = useLocalSearchParams<{ tokenId?: RouteParam }>();
    const tokenId = String(Array.isArray(params.tokenId) ? params.tokenId[0] ?? '' : params.tokenId ?? '');
    const controller = useApiTokenSettingsScopeController();
    const state = useApiTokenSettingsControllerState(controller);
    const token = state.tokens.find((candidate) => candidate.tokenId === tokenId) ?? null;
    const router = useRouter();

    if (token?.embedConfig) return <Redirect href={apiTokenEmbedDetailPath(token.tokenId) as never} />;
    if (!token) {
        if ((state.phase === 'idle' || state.phase === 'loading') && state.tokens.length === 0) {
            return (
                <ItemList>
                    <SettingsPageHeader />
                    <ItemGroup>
                        <ItemLoadStateRows testID="settings-api-token-detail-loading" state={{ kind: 'loading' }} rows={4} lines={2}
                            accessibilityLabel={t('settingsApiTokens.title')} />
                    </ItemGroup>
                </ItemList>
            );
        }
        return (
            <SurfaceStateCard
                testID="settings-api-token-detail-missing"
                kind="unavailable"
                title={t('settingsApiTokens.detail.missingTitle')}
                reason={t('settingsApiTokens.detail.missingBody')}
                action={{
                    label: t('settingsApiTokens.detail.backToTokens'),
                    onPress: () => {
                        const result = runGuardedNavigation(() => router.replace(API_TOKENS_COLLECTION_ROOT as never));
                        if (result !== true) fireAndForget(result, { tag: 'ApiTokenDetailScreen.back' });
                    },
                }}
            />
        );
    }
    return <ApiTokenDetail token={token} />;
});

const ApiTokenDetail = React.memo(function ApiTokenDetail(props: Readonly<{ token: AccountApiTokenSummaryV1 }>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const controller = useApiTokenSettingsScopeController();
    const state = useApiTokenSettingsControllerState(controller);
    const operations = useApiTokenOperations(controller);
    const token = props.token;
    const grant = token.grant;
    const nowMs = useApiTokenSettingsClock([token], useHostActivelyViewed());
    const presentation = buildApiTokenRowPresentation({ token, nowMs });
    const busy = state.operation !== null || state.createPending || state.accessEdit?.pending === true;

    const revoke = React.useCallback(async () => {
        if (!(await operations.revoke(token))) return;
        const result = runGuardedNavigation(() => router.replace(API_TOKENS_COLLECTION_ROOT as never));
        if (result !== true) fireAndForget(result, { tag: 'ApiTokenDetail.revoked' });
    }, [operations, router, token]);

    const meta = [
        { key: 'prefix', text: presentation.displayPrefix },
        { key: 'created', text: t('settingsApiTokens.detail.created', { date: formatInstant(token.createdAt) }) },
        {
            key: 'used',
            text: token.lastUsedAt
                ? t('settingsApiTokens.detail.lastUsed', { date: formatInstant(token.lastUsedAt) })
                : t('settingsApiTokens.neverUsed'),
        },
        {
            key: 'expires',
            text: token.expiresAt === null
                ? t('settingsApiTokens.summary.noExpiry')
                : presentation.status === 'expired'
                    ? t('settingsApiTokens.summary.expired', { date: formatInstant(token.expiresAt) })
                    : t('settingsApiTokens.summary.expires', { date: formatInstant(token.expiresAt) }),
        },
    ];

    return (
        <ItemList testID="settings-api-token-detail">
            <SettingsPageHeader
                title={token.label}
                alwaysShowTitle
                meta={meta}
                actions={(
                    <RoundButton
                        testID="settings-api-token-edit-access"
                        display="secondary"
                        title={t('settingsApiTokens.detail.editAccess')}
                        disabled={busy}
                        onPress={() => operations.editAccess(token)}
                    />
                )}
            />

            <ApiTokenActionsFacts token={token} />
            {apiTokenGrantOffersAutomations(token.grant) ? <ApiTokenAutomationFacts automationIds={token.grant.automationIds ?? null} /> : null}
            <ApiTokenTargetFacts token={token} />
            <ApiTokenModelFacts token={token} />
            <ApiTokenSessionFacts token={token} />

            <ItemGroup title={t('settingsApiTokens.detail.approvals')}>
                <Item
                    testID="settings-api-token-detail-approve"
                    title={grant.approve ? t('settingsApiTokens.detail.approvesOn') : t('settingsApiTokens.detail.approvesOff')}
                    subtitle={grant.approve ? t('settingsApiTokens.grant.approve.on') : t('settingsApiTokens.grant.approve.off')}
                    subtitleLines={0}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={t('settingsApiTokens.grant.websites.title')} description={t('settingsApiTokens.detail.websitesDescription')}>
                {grant.origins.length === 0 ? (
                    <Item title={t('settingsApiTokens.detail.noWebsites')} mode="info" showChevron={false} />
                ) : grant.origins.map((origin) => (
                    <Item
                        key={origin}
                        title={origin}
                        icon={<Icon name="globe" size={18} color={theme.colors.text.secondary} />}
                        mode="info"
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            <ItemGroup title={t('settingsApiTokens.detail.content')}>
                <Item
                    title={token.hasEncryptionAccess ? t('settingsApiTokens.encryption.enabled') : t('settingsApiTokens.encryption.bearerOnly')}
                    subtitle={token.hasEncryptionAccess ? t('settingsApiTokens.detail.contentOn') : t('settingsApiTokens.detail.contentOff')}
                    mode="info"
                    showChevron={false}
                />
                {token.hasUnattendedTeamAccess ? (
                    <Item title={t('settingsApiTokens.unattended.authorized')} mode="info" showChevron={false} />
                ) : null}
            </ItemGroup>

            {token.activeChildCount > 0 ? (
                <ItemGroup title={t('settingsApiTokens.detail.children')} description={t('settingsApiTokens.detail.childrenDescription')}>
                    <Item
                        testID="settings-api-token-detail-children"
                        title={t('settingsApiTokens.detail.childrenCount', { count: token.activeChildCount })}
                        subtitle={t('settingsApiTokens.detail.childrenConsequence')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup surface="none">
                <SectionButtonRow testID="settings-api-token-detail-closing" footnote={t('settingsApiTokens.detail.revokeFootnote')}>
                    <RoundButton
                        testID="settings-api-token-revoke"
                        size="small"
                        display="destructive"
                        title={t('settingsApiTokens.revoke.confirm')}
                        disabled={busy}
                        loading={state.operation === 'revoke' && state.operationTokenId === token.tokenId}
                        onPress={() => void revoke()}
                    />
                </SectionButtonRow>
            </ItemGroup>
        </ItemList>
    );
});

function ApiTokenActionsFacts(props: Readonly<{ token: AccountApiTokenSummaryV1 }>) {
    const groups = useApiTokenGrantActionGroups();
    const actions = props.token.grant.actions;
    return (
        <ItemGroup title={t('settingsApiTokens.detail.whatItCanDo')} description={t('settingsApiTokens.detail.whatItCanDoDescription')}>
            {actions === null ? (
                <Item title={t('settingsApiTokens.detail.everyAction')} mode="info" showChevron={false} />
            ) : (
                <>
                    {actions.families.map((family) => (
                        <Item key={`family:${family}`} title={t(actionIdFamilyTitleKey(family))} subtitle={t('settingsApiTokens.detail.wholeGroup')} mode="info" showChevron={false} />
                    ))}
                    {actions.ids.map((id) => (
                        <Item key={`action:${id}`} title={resolveApiTokenGrantActionTitle(id, groups) ?? id} mode="info" showChevron={false} />
                    ))}
                </>
            )}
        </ItemGroup>
    );
}

/**
 * The session limits a grant may carry (sessions it starts, permission modes), shown whenever they
 * are set so a restricted token never reads as unrestricted. Neither is shown when absent.
 */
function ApiTokenSessionFacts(props: Readonly<{ token: AccountApiTokenSummaryV1 }>) {
    const { create, permissionModes } = props.token.grant;
    const agentType = useApiTokenGrantModeAgentType(create?.agentTargetKey ?? null);
    if (create === null && permissionModes === null) return null;
    return (
        <ItemGroup title={t('settingsApiTokens.detail.sessionLimits')} description={t('settingsApiTokens.detail.sessionLimitsDescription')}>
            {create ? <ApiTokenCreateFact machineId={create.machineId} /> : null}
            {permissionModes ? (
                <Item
                    testID="settings-api-token-detail-permission-modes"
                    title={t('settingsEmbeds.capabilities.permissionModes')}
                    detail={summarizeApiTokenGrantPermissionModes(permissionModes, agentType)}
                    mode="info"
                    showChevron={false}
                />
            ) : null}
        </ItemGroup>
    );
}

/** Mounted only for a creation grant, so other tokens' pages never subscribe to machines. */
function ApiTokenCreateFact(props: Readonly<{ machineId: string }>) {
    const machine = useAllMachines().find((candidate) => candidate.id === props.machineId);
    return (
        <Item
            testID="settings-api-token-detail-create"
            title={t('settingsApiTokens.detail.createsSessions')}
            subtitle={t('settingsApiTokens.detail.createsSessionsOn', {
                computer: machine ? getMachineSentenceName(machine) : t('settingsApiTokens.detail.unknownComputer'),
            })}
            subtitleLines={0}
            mode="info"
            showChevron={false}
        />
    );
}

function ApiTokenTargetFacts(props: Readonly<{ token: AccountApiTokenSummaryV1 }>) {
    const { theme } = useUnistyles();
    const targets = props.token.grant.targets;
    return (
        <ItemGroup title={t('settingsApiTokens.detail.where')} description={t('settingsApiTokens.detail.whereDescription')}>
            {targets === null ? (
                <Item title={t('settingsApiTokens.grant.targets.all')} mode="info" showChevron={false} />
            ) : <ApiTokenTargetRows sessions={targets.sessions} machines={targets.machines} iconColor={theme.colors.text.secondary} />}
        </ItemGroup>
    );
}

/** Mounted only for a restricted grant, so an unrestricted token's page never subscribes to every session. */
function ApiTokenTargetRows(props: Readonly<{ sessions: readonly string[]; machines: readonly string[]; iconColor: string }>) {
    const allMachines = useAllMachines();
    const allSessions = useAllSessions();
    const machineById = new Map(allMachines.map((machine) => [machine.id, machine]));
    const sessionById = new Map(allSessions.map((session) => [session.id, session]));
    return (
        <>
            {props.machines.map((machineId) => (
                <Item
                    key={`machine:${machineId}`}
                    title={getMachineDisplayName(machineById.get(machineId)) ?? t('settingsApiTokens.detail.unknownComputer')}
                    subtitle={t('settingsApiTokens.detail.computerCovers')}
                    icon={<Icon name="desktop" size={20} color={props.iconColor} />}
                    mode="info"
                    showChevron={false}
                />
            ))}
            {props.sessions.map((sessionId) => {
                const session = sessionById.get(sessionId);
                const machineId = session?.metadata?.machineId;
                return (
                    <Item
                        key={`session:${sessionId}`}
                        title={session ? getSessionName(session) : t('settingsApiTokens.detail.unknownSession')}
                        subtitle={machineId ? getMachineDisplayName(machineById.get(machineId)) ?? undefined : undefined}
                        mode="info"
                        showChevron={false}
                    />
                );
            })}
        </>
    );
}

/** Mounted only while the token can run an Automation now, so other tokens' pages never read Automations. */
function ApiTokenAutomationFacts(props: Readonly<{ automationIds: readonly string[] | null }>) {
    const automations = useAutomations();
    const byId = new Map(automations.map((automation) => [automation.id, automation]));
    return (
        <ItemGroup
            testID="settings-api-token-detail-automations"
            title={t('settingsApiTokens.grant.automations.title')}
            description={props.automationIds === null ? undefined : t('settingsApiTokens.grant.automations.pickerDescription')}
        >
            {props.automationIds === null ? (
                <Item title={t('settingsApiTokens.grant.automations.any')} mode="info" showChevron={false} />
            ) : props.automationIds.map((automationId) => {
                const automation = byId.get(automationId);
                return (
                    <Item
                        key={automationId}
                        title={automation ? automation.name || t('settingsApiTokens.grant.automations.unnamed') : t('settingsApiTokens.grant.automations.unknown')}
                        subtitle={automation && !automation.enabled ? t('settingsApiTokens.grant.automations.off') : undefined}
                        mode="info"
                        showChevron={false}
                    />
                );
            })}
        </ItemGroup>
    );
}

function ApiTokenModelFacts(props: Readonly<{ token: AccountApiTokenSummaryV1 }>) {
    const { theme } = useUnistyles();
    const models = props.token.grant.models;
    const groups = useApiTokenGrantModelGroups(models);
    const byKey = new Map(groups.flatMap((group) => group.models.map((model) => [model.key, { model, group }] as const)));
    return (
        <ItemGroup title={t('settingsApiTokens.grant.models.title')} description={t('settingsApiTokens.detail.modelsDescription')}>
            {models === null ? (
                <Item title={t('settingsApiTokens.grant.models.any')} mode="info" showChevron={false} />
            ) : models.map((ref) => {
                const entry = byKey.get(apiTokenGrantModelKey(ref));
                return (
                    <Item
                        key={apiTokenGrantModelKey(ref)}
                        title={entry?.model.name ?? ref.modelId}
                        subtitle={entry?.group.title}
                        icon={entry?.group.entry ? (
                            <AgentCatalogIdentityIcon
                                entry={entry.group.entry.agentCatalogEntry}
                                machineId={null}
                                serverId={null}
                                current={false}
                                size={18}
                                color={theme.colors.text.secondary}
                            />
                        ) : undefined}
                        mode="info"
                        showChevron={false}
                    />
                );
            })}
        </ItemGroup>
    );
}
