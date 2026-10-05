import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type {
    ConnectedServiceId,
    PluginConnectedAccountAuthenticationModeV2,
    QualifiedConnectedAccountProfileV4,
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { QualifiedAccountDetail } from './QualifiedAccountDetail';
import { SharedWithTeamsForSource } from '@/components/settings/teams/credentials/SharedWithTeamsSourceAdministration';
import {
    presentQualifiedConnectedAccountTarget,
    type QualifiedConnectedAccountTargetPresentation,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { QualifiedPoolDetail } from '../pools/QualifiedPoolDetail';
import { QualifiedPoolDraft } from '../pools/QualifiedPoolDraftView';
import type { QualifiedPoolDetailMutations } from '../pools/QualifiedPoolDetailView';
import type {
    UseQualifiedConnectedAccountGroupsResult,
} from '@/hooks/server/connectedServices/useQualifiedConnectedAccountGroups';
import { Modal } from '@/modal';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { deriveConnectedServiceAuthGroupIdFromName } from '@/sync/domains/connectedServices/deriveConnectedServiceAuthGroupIdFromName';
import {
    isConnectedAccountConfigurationBlocked,
    isConnectedAccountServiceConfigurationBlocked,
    type ConnectedAccountServiceConfigurationStatusByModeId,
} from '@/sync/domains/connectedServices/configurationReadiness';
import {
    buildConnectedAccountSettingsRoute,
    type ConnectedAccountSettingsRouteFocus,
} from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { getPreferredLanguage, t } from '@/text';
import { resolveConnectedAccountModeTitle } from '../model/resolveConnectedAccountModeTitle';
import {
    isConnectedServiceRuntimeCooldownError,
    resolveConnectedServiceRuntimeCooldownOverrideBody,
} from '../connectedServiceSettingsErrors';
import { resolveProjectedLocalizedText } from '@/components/plugins/surfaces/resolvePluginDisplayString';
import { teamsDirectoryShareCredentialPath } from '@/components/settings/teams/teamsRoutes';

export type ConnectedAccountServiceProfile = QualifiedConnectedAccountProfileV4;

/** Stable empty fallback so an absent `accountLabels` prop does not churn memos. */
const EMPTY_ACCOUNT_LABELS: Readonly<Record<string, string>> = Object.freeze({});

const EMPTY_GROUPS: UseQualifiedConnectedAccountGroupsResult = {
    status: 'unsupported',
    source: null,
    groups: [],
    error: null,
    mutating: false,
    refresh: async () => {},
    create: async () => null,
    patch: async () => null,
    delete: async () => false,
    addMember: async () => null,
    patchMember: async () => null,
    removeMember: async () => null,
    setActiveAccount: async () => null,
};

/** Single-row screen for a focus that no longer resolves to a live entity. */
function FocusedScreenNotice(props: Readonly<{
    testID: string;
    /** The service the missing or loading account or pool belongs to: the page's one title. */
    pageTitle: string;
    title: string;
    subtitle?: string;
}>) {
    return (
        <ItemList testID={props.testID}>
            <SettingsPageHeader title={props.pageTitle} alwaysShowTitle />
            <ItemGroup>
                <Item
                    testID={`${props.testID}:row`}
                    title={props.title}
                    {...(props.subtitle ? { subtitle: props.subtitle } : {})}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
}

/**
 * The focused screens the single `connected-services/account` route renders,
 * selected by its route focus:
 *
 * - `account`: that account's own detail screen;
 * - `group`: that pool's own detail screen;
 * - `newPool`: a pool draft.
 *
 * Drilling in NAVIGATES (a real stack entry with back), so selection lives in
 * the URL rather than in local state. Each focused screen owns its own list.
 */
export const ConnectedAccountServiceContent = React.memo(function ConnectedAccountServiceContent(props: Readonly<{
    serverId?: string;
    teamCredentialResourcesEnabled?: boolean;
    localize?: (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => string;
    title: string;
    quotaResetSupported?: boolean;
    service: QualifiedConnectedAccountRef['service'];
    legacyServiceId?: ConnectedServiceId | null;
    focus?: ConnectedAccountSettingsRouteFocus | null;
    modes: readonly PluginConnectedAccountAuthenticationModeV2[];
    accounts: readonly ConnectedAccountServiceProfile[];
    serviceConfigurationStatusByModeId?: ConnectedAccountServiceConfigurationStatusByModeId;
    accountLabels?: Readonly<Record<string, string | undefined>>;
    groups?: UseQualifiedConnectedAccountGroupsResult;
    busy: boolean;
    /** The account detail's in-place rename (lab D2). */
    onRenameAccount?(account: QualifiedConnectedAccountRef, label: string): void;
    onConfigureAccount?(account: QualifiedConnectedAccountRef): void;
    onConfigureService?(modeId: string): void;
    canReconnectAccount?(account: ConnectedAccountServiceProfile): boolean;
    onBeginReconnect?(account: QualifiedConnectedAccountRef): void;
    /**
     * Disconnect for the account detail screen, which owns (and has already
     * shown) the confirmation. Resolves to whether the account was revoked.
     */
    onDisconnectAccount?(account: QualifiedConnectedAccountRef): Promise<boolean>;
}>) {
    const locale = getPreferredLanguage();
    const router = useRouter();
    const groups = props.groups ?? EMPTY_GROUPS;
    const accountLabels = props.accountLabels ?? EMPTY_ACCOUNT_LABELS;
    const service = props.service;
    const focus = props.focus ?? null;
    const accounts = React.useMemo(
        () => props.accounts.filter((account) => (
            account.ref.service.pluginId === props.service.pluginId
            && account.ref.service.localId === props.service.localId
        )),
        [
            props.accounts,
            props.service.localId,
            props.service.pluginId,
        ],
    );
    // Pools are an optional server capability: a live transport is not permission
    // to show them. The server bit decides here exactly as it does on every other
    // connected-services surface, and every pool affordance below reads this flag.
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
    const poolsAvailable = accountGroupsEnabled && groups.source !== null;
    // Automatic fallback is its OWN server capability, gated independently of
    // pools: a server can serve pools and still refuse to run fallback. The gate
    // is registered fail-closed, so a missing or malformed bit disables the
    // controls rather than offering a switch the server will not honor.
    const accountFallbackEnabled = useFeatureEnabled('connectedServices.accountFallback');
    const autoQuotaResetEnabled = useFeatureEnabled('connectedServices.autoQuotaReset');
    const autoDisablePlanInvalidEnabled = useFeatureEnabled('connectedServices.autoDisablePlanInvalid');
    const quotaLimitSelectionEnabled = useFeatureEnabled('connectedServices.poolQuotaLimitSelection');
    const focusedGroup = focus?.kind === 'group'
        ? groups.groups.find((candidate) => candidate.ref.groupId === focus.groupId) ?? null
        : null;
    /** Drill into an account or a pool as a real stack entry. */
    const openFocus = React.useCallback((next: ConnectedAccountSettingsRouteFocus) => {
        router.push(buildConnectedAccountSettingsRoute(service, next));
    }, [router, service]);

    /**
     * Leave a focused screen whose entity no longer exists (deleted pool,
     * disconnected account). A deep link may have no stack entry to pop, so the
     * service detail is the deterministic fallback destination.
     */
    const leaveFocusedScreen = React.useCallback(() => {
        if (router.canGoBack()) {
            router.back();
            return;
        }
        router.replace(buildConnectedAccountSettingsRoute(service));
    }, [router, service]);

    const [creatingPool, setCreatingPool] = React.useState(false);
    /** Creates the drafted pool with its members (threading each returned group), then opens it. */
    const createPoolFromDraft = React.useCallback(async (draft: Readonly<{ displayName: string; accountIds: readonly string[] }>) => {
        const groupId = deriveConnectedServiceAuthGroupIdFromName({
            name: draft.displayName,
            existingGroupIds: groups.groups.map((group) => group.ref.groupId),
        });
        if (!groupId) {
            await Modal.alert(
                t('connectedServices.detail.groupActions.invalidGroupIdTitle'),
                t('connectedServices.detail.groupActions.invalidGroupIdBody'),
            );
            return;
        }
        setCreatingPool(true);
        try {
            let current = await groups.create({ groupId, displayName: draft.displayName });
            if (!current) return;
            for (const accountId of draft.accountIds) {
                const account = accounts.find((candidate) => candidate.ref.accountId === accountId);
                if (!account) continue;
                const next = await groups.addMember({ group: current, account: account.ref });
                if (!next) break;
                current = next;
            }
            router.replace(buildConnectedAccountSettingsRoute(service, { kind: 'group', groupId: current.ref.groupId }));
        } finally {
            setCreatingPool(false);
        }
    }, [accounts, groups, router, service]);

    /**
     * The pool detail's mutation surface. Two decisions stay with this owner
     * rather than the presentational view: the runtime-cooldown override prompt
     * (`setActiveAccount` rethrows so exactly ONE caller decides whether to
     * retry) and leaving a pool screen whose pool was just deleted.
     */
    const poolMutations = React.useMemo<QualifiedPoolDetailMutations>(() => ({
        mutating: groups.mutating,
        patch: groups.patch,
        patchMember: groups.patchMember,
        addMember: groups.addMember,
        removeMember: groups.removeMember,
        setActiveAccount: async (input) => {
            try {
                return await groups.setActiveAccount(input);
            } catch (error) {
                // A non-cooldown failure already surfaced through the groups
                // error state; null tells the view the mutation did not apply.
                if (!isConnectedServiceRuntimeCooldownError(error)) return null;
                const confirmed = await Modal.confirm(
                    t('connectedServices.errors.runtimeCooldownOverrideTitle'),
                    resolveConnectedServiceRuntimeCooldownOverrideBody(error),
                    {
                        confirmText:
                            t('connectedServices.errors.runtimeCooldownOverrideConfirm'),
                        cancelText: t('common.cancel'),
                    },
                );
                if (!confirmed) return null;
                return await groups.setActiveAccount({
                    ...input,
                    overrideRuntimeCooldown: true,
                }).catch(() => null);
            }
        },
        delete: async (group) => {
            const deleted = await groups.delete(group);
            if (deleted) leaveFocusedScreen();
            return deleted;
        },
    }), [groups, leaveFocusedScreen, locale]);

    /**
     * Human identity for an account, through the canonical qualified-target
     * presenter shared with pool, Provider and Voice surfaces.
     */
    const resolveAccountIdentity = (
        account: ConnectedAccountServiceProfile,
    ): QualifiedConnectedAccountTargetPresentation => presentQualifiedConnectedAccountTarget({
        target: {
            kind: 'account',
            account: account.ref,
        },
        accounts,
        groups: groups.groups,
        labelsByKey: EMPTY_ACCOUNT_LABELS,
        accountLabel: accountLabels[account.ref.accountId] ?? null,
        legacyServiceId: props.legacyServiceId ?? null,
        serviceTitle: props.title,
    });

    /**
     * Reconnect is unreachable for an account whose public authentication mode
     * is gone (nothing left to re-run) or when the peer cannot accept it.
     */
    const canReconnect = (account: ConnectedAccountServiceProfile): boolean => Boolean(
        props.onBeginReconnect
        && account.revisionSemantics === 'revisioned'
        && !(account.status === 'needs_reauth' && account.authenticationModeId === null)
        && (
            !props.canReconnectAccount
            || props.canReconnectAccount(account)
        ),
    );

    if (focus?.kind === 'newPool') {
        if (!poolsAvailable) {
            // Pools are a server capability; a draft that could never be created is not offered.
            return (
                <FocusedScreenNotice
                    pageTitle={props.title}
                    testID="connected-services-pool-draft:unavailable"
                    title={groups.status === 'loading' ? t('common.loading') : t('common.unavailable')}
                />
            );
        }
        return (
            <QualifiedPoolDraft
                serviceLabel={props.title}
                accounts={accounts}
                accountLabels={accountLabels}
                creating={creatingPool}
                onCreate={(draft) => { void createPoolFromDraft(draft); }}
                onDiscard={leaveFocusedScreen}
            />
        );
    }

    if (focus?.kind === 'group') {
        const shareServerId = props.serverId;
        const group = focusedGroup;
        if (!group) {
            return groups.status === 'loading' ? (
                <FocusedScreenNotice
                    pageTitle={props.title}
                    testID="connected-services-pool-detail:loading"
                    title={t('common.loading')}
                />
            ) : (
                <FocusedScreenNotice
                    pageTitle={props.title}
                    testID="connected-services-pool-detail:missing"
                    title={t('connectedServices.detail.groupDetail.missingTitle')}
                    subtitle={t('connectedServices.detail.groupDetail.missingBody', {
                        service: props.title,
                        groupId: focus.groupId,
                    })}
                />
            );
        }
        return (
            <QualifiedPoolDetail
                group={group}
                accounts={accounts}
                accountLabels={accountLabels}
                serviceLabel={props.title}
                mutations={poolMutations}
                fallbackControlsEnabled={accountFallbackEnabled}
                autoQuotaResetEnabled={autoQuotaResetEnabled && props.quotaResetSupported === true}
                autoDisablePlanInvalidEnabled={autoDisablePlanInvalidEnabled}
                quotaLimitSelectionEnabled={quotaLimitSelectionEnabled}
                fallbackDisabledSubtitle={
                    t('connectedServices.detail.groupActions.accountFallbackDisabled')
                }
                // Mutations here report failure by returning null and setting this;
                // without it a rejected change just reconciles away silently.
                error={groups.error}
                {...(shareServerId && props.teamCredentialResourcesEnabled === true ? {
                    sharedWithTeamsAdministration: <SharedWithTeamsForSource
                        serverId={shareServerId}
                        source={{ v: 1, kind: 'connected_pool', target: { kind: 'group', service: group.ref.service, groupId: group.ref.groupId } }}
                    />,
                    onShareWithTeam: () => router.push(teamsDirectoryShareCredentialPath({
                        kind: 'connected_pool',
                        serverId: shareServerId,
                        service: group.ref.service,
                        groupId: group.ref.groupId,
                    })),
                } : {})}
            />
        );
    }

    if (focus?.kind === 'account') {
        const shareServerId = props.serverId;
        const account = accounts.find(
            (candidate) => candidate.ref.accountId === focus.accountId,
        ) ?? null;
        if (!account) {
            return (
                <FocusedScreenNotice
                    pageTitle={props.title}
                    testID="qualified-account-detail:missing"
                    title={t('connectedServices.detail.alerts.unknownProfileTitle')}
                    subtitle={t('connectedServices.detail.alerts.unknownProfileBody', {
                        profileId: focus.accountId,
                        service: props.title,
                    })}
                />
            );
        }
        const accountIsRevisioned =
            account.revisionSemantics === 'revisioned';
        const authenticationMode = props.modes.find((mode) => mode.id === account.authenticationModeId) ?? null;
        return (
            <QualifiedAccountDetail
                account={account.ref}
                serviceLabel={props.title}
                legacyServiceId={props.legacyServiceId ?? null}
                presentation={resolveAccountIdentity(account)}
                providerEmail={account.providerIdentity?.email ?? null}
                providerAccountId={account.providerIdentity?.accountId ?? null}
                // RAW status: the view owns the recognized-status gate.
                status={account.status}
                authenticationModeTitle={(() => {
                    const mode = props.modes.find((candidate) => candidate.id === account.authenticationModeId);
                    if (!mode) return null;
                    return mode.kind === 'oauthDeviceCode'
                        ? t('connectedServicesSettings.detailSignedInWithCode')
                        : mode.kind === 'manual'
                            ? t('connectedServicesSettings.detailAddedWithKey')
                            : t('connectedServicesSettings.detailSignedInWithBrowser');
                })()}
                lastUsedAt={account.lastUsedAt ?? null}
                configurationDisabled={props.busy}
                {...(accountIsRevisioned && authenticationMode?.configuration?.scope === 'account' && props.onConfigureAccount ? {
                    onConfigureAccount: () => props.onConfigureAccount?.(account.ref),
                    accountConfigurationBlocked: isConnectedAccountConfigurationBlocked({
                        account,
                        authenticationMode,
                        serviceConfigurationStatusByModeId: props.serviceConfigurationStatusByModeId,
                    }),
                } : {})}
                serviceConfigurations={props.onConfigureService ? props.modes.filter((mode) => mode.configuration?.scope === 'service').map((mode) => ({
                    modeId: mode.id,
                    title: resolveConnectedAccountModeTitle(mode, props.localize),
                    blocked: isConnectedAccountServiceConfigurationBlocked(props.serviceConfigurationStatusByModeId, mode.id),
                    onConfigure: () => props.onConfigureService?.(mode.id),
                })) : undefined}
                // Pools apply only when this service has a pool source at all;
                // an empty array still renders the section with its empty state.
                {...(poolsAvailable ? {
                    groups: groups.groups,
                    onOpenPool: (groupId: string) => openFocus({ kind: 'group', groupId }),
                } : {})}
                {...(accountIsRevisioned && props.onRenameAccount ? {
                    rename: {
                        currentLabel: accountLabels[account.ref.accountId] ?? '',
                        onRename: (label: string) => props.onRenameAccount?.(account.ref, label),
                    },
                } : {})}
                {...(shareServerId && props.teamCredentialResourcesEnabled === true ? {
                    sharedWithTeamsAdministration: <SharedWithTeamsForSource
                        serverId={shareServerId}
                        source={{ v: 1, kind: 'connected_account', target: { kind: 'account', account: account.ref } }}
                    />,
                    onShareWithTeam: () => router.push(teamsDirectoryShareCredentialPath({
                        kind: 'connected_account',
                        serverId: shareServerId,
                        account: account.ref,
                    })),
                } : {})}
                {...(canReconnect(account) ? {
                    onReconnect: () => props.onBeginReconnect?.(account.ref),
                } : {})}
                {...(accountIsRevisioned && props.onDisconnectAccount ? {
                    onDisconnect: async () => {
                        // The account is gone once revoked; its detail screen is not.
                        if (await props.onDisconnectAccount?.(account.ref)) {
                            leaveFocusedScreen();
                        }
                    },
                } : {})}
            />
        );
    }

    // Service-only ingress is translated to the Collection before this controller mounts.
    return null;
});
