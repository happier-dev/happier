import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import type {
    ConnectedServiceId,
    PluginConnectedAccountAuthenticationModeV2,
    QualifiedConnectedAccountProfileV4,
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import {
    compareAccountHealthSeverity,
    deriveAccountHealth,
} from '@/sync/domains/connectedServices/deriveAccountHealth';
import { AccountBlock } from './AccountBlock';
import {
    buildConnectedServiceAccountRowActions,
    type ConnectedServiceAccountKind,
} from './buildConnectedServiceAccountRowActions';
import { QualifiedAccountBlock } from './QualifiedAccountBlock';
import { QualifiedAccountDetailView } from './QualifiedAccountDetailView';
import {
    presentQualifiedConnectedAccountTarget,
    type QualifiedConnectedAccountTargetPresentation,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import {
    ConnectedServiceSegmentedShell,
    type ConnectedServiceDetailSegment,
} from '@/components/settings/connectedServices/detail/ConnectedServiceSegmentedShell';
import {
    QualifiedPoolDetailView,
    type QualifiedPoolDetailMutations,
} from '../pools/QualifiedPoolDetailView';
import { QualifiedPoolsList } from '../pools/QualifiedPoolsList';
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
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import {
    isConnectedServiceRuntimeCooldownError,
    resolveConnectedServiceRuntimeCooldownOverrideBody,
} from '../connectedServiceSettingsErrors';
import {
    isQualifiedConnectedAccountLegacyOperationSupported,
    type QualifiedConnectedAccountUiLegacyPeerClass,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import { resolveProjectedLocalizedText } from '@/components/plugins/surfaces/resolvePluginDisplayString';

export type ConnectedAccountServiceProfile = QualifiedConnectedAccountProfileV4;

/** Stable empty fallback so an absent `accountLabels` prop does not churn memos. */
const EMPTY_ACCOUNT_LABELS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Kebab actions that start or destroy a credential operation. This screen runs
 * ONE authentication/revocation attempt at a time and has no re-entrancy guard
 * of its own, so they stay disabled while one is in flight — the read-only
 * drill-in and the purely local label edit do not. The ids are the canonical
 * row-action builder's; the coupling is pinned by this screen's own test.
 */
const BUSY_GATED_ACCOUNT_ACTION_IDS: ReadonlySet<string> = new Set([
    'replace-token',
    'reconnect',
    'disconnect',
]);

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
    title: string;
    subtitle?: string;
}>) {
    return (
        <ItemList testID={props.testID}>
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
 * The three screens the single `connected-services/account` route renders,
 * selected by its route focus:
 *
 * - no focus: the service detail (Accounts | Pools segmented shell);
 * - `account`: that account's own detail screen;
 * - `group`: that pool's own detail screen.
 *
 * Drilling in NAVIGATES (a real stack entry with back), so selection lives in
 * the URL rather than in local state. The two focused screens own their own
 * `ItemList`; the unfocused service detail renders into the route's list.
 */
export const ConnectedAccountServiceContent = React.memo(function ConnectedAccountServiceContent(props: Readonly<{
    localize?: (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => string;
    title: string;
    service: QualifiedConnectedAccountRef['service'];
    legacyServiceId?: ConnectedServiceId | null;
    /**
     * Peer class of the resolved legacy transport, projected ONCE by the route
     * owner. Absent for a v4 peer (or before the peer resolves); this screen must
     * not re-derive it, because guessing one is how a legacy capability answer
     * silently becomes wrong for the other peer class.
    */
    legacyPeerClass?: QualifiedConnectedAccountUiLegacyPeerClass | null;
    focus?: ConnectedAccountSettingsRouteFocus | null;
    modes: readonly PluginConnectedAccountAuthenticationModeV2[];
    accounts: readonly ConnectedAccountServiceProfile[];
    serviceConfigurationStatusByModeId?: ConnectedAccountServiceConfigurationStatusByModeId;
    accountLabels?: Readonly<Record<string, string | undefined>>;
    defaultAccountId?: string | null;
    groups?: UseQualifiedConnectedAccountGroupsResult;
    busy: boolean;
    onEditLabel?(account: QualifiedConnectedAccountRef): void;
    onToggleDefault?(account: QualifiedConnectedAccountRef): void;
    onConfigureAccount?(account: QualifiedConnectedAccountRef): void;
    onConfigureService?(modeId: string): void;
    onBeginConnect?(input: Readonly<{
        service: QualifiedConnectedAccountRef['service'];
        modeId: string;
    }>): void;
    canReconnectAccount?(account: ConnectedAccountServiceProfile): boolean;
    onBeginReconnect?(account: QualifiedConnectedAccountRef): void;
    /** Service-list disconnect affordance; its caller owns the confirmation. */
    onRevoke?(account: QualifiedConnectedAccountRef): void;
    /**
     * Disconnect for the account detail screen, which owns (and has already
     * shown) the confirmation. Resolves to whether the account was revoked.
     */
    onDisconnectAccount?(account: QualifiedConnectedAccountRef): Promise<boolean>;
}>) {
    const { theme } = useUnistyles();
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
    /**
     * Presentation order for the accounts LIST only: worst health first, then a
     * stable id order inside a health band. Pool membership and the focused
     * account lookup keep the source order they were given.
     */
    const sortedAccounts = React.useMemo(() => [...accounts].sort((a, b) => {
        const rank = compareAccountHealthSeverity(
            deriveAccountHealth({ status: a.status, capacityPct: null }),
            deriveAccountHealth({ status: b.status, capacityPct: null }),
        );
        return rank !== 0 ? rank : a.ref.accountId.localeCompare(b.ref.accountId);
    }), [accounts]);
    const [activeSegment, setActiveSegment] =
        React.useState<ConnectedServiceDetailSegment>('accounts');
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
    const legacyQuotaSupported = props.legacyServiceId
        && props.legacyPeerClass
        ? isQualifiedConnectedAccountLegacyOperationSupported({
            service: props.service,
            legacyServiceId: props.legacyServiceId,
            peerClass: props.legacyPeerClass,
            operation: 'quota_read',
        })
        : false;

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

    const createGroup = React.useCallback(async () => {
        const displayNameResult = await Modal.prompt(
            t('connectedServices.detail.groupActions.createTitle'),
            t('connectedServices.detail.groupActions.createSubtitle'),
            {
                placeholder: t('connectedServices.detail.groupActions.displayNamePlaceholder'),
                confirmText: t('common.create'),
                cancelText: t('common.cancel'),
            },
        );
        const displayName = typeof displayNameResult === 'string'
            ? displayNameResult.trim()
            : '';
        if (!displayName) return;
        const groupId = deriveConnectedServiceAuthGroupIdFromName({
            name: displayName,
            existingGroupIds: groups.groups.map(
                (group) => group.ref.groupId,
            ),
        });
        if (!groupId) {
            await Modal.alert(
                t('connectedServices.detail.groupActions.invalidGroupIdTitle'),
                t('connectedServices.detail.groupActions.invalidGroupIdBody'),
            );
            return;
        }
        const created = await groups.create({
            groupId,
            displayName,
        });
        if (created) openFocus({ kind: 'group', groupId: created.ref.groupId });
    }, [groups, openFocus]);

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
    }), [groups, leaveFocusedScreen]);

    /**
     * Pool membership chips per account, so an account row shows which pools it
     * belongs to without opening the Pools segment. They are part of the pools
     * feature: a transport that still answers with groups must not leak them onto
     * the accounts list once pools are unavailable here.
     */
    const poolLabelsByAccountId = React.useMemo(() => {
        const byAccountId: Record<string, string[]> = {};
        for (const group of poolsAvailable ? groups.groups : []) {
            const groupLabel = presentQualifiedConnectedAccountTarget({
                target: {
                    kind: 'group',
                    service: group.ref.service,
                    groupId: group.ref.groupId,
                },
                accounts,
                groups: groups.groups,
                labelsByKey: EMPTY_ACCOUNT_LABELS,
                serviceTitle: props.title,
            }).primaryLabel;
            for (const member of group.members) {
                (byAccountId[member.ref.accountId] ??= []).push(groupLabel);
            }
        }
        return byAccountId;
    }, [accounts, groups.groups, poolsAvailable, props.title]);

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
     * Which credential-replacement affordance the row builder should offer.
     *
     * dev's projection leaves `kind` optional, so it is derived from the
     * account's authentication mode when this descriptor snapshot knows it: a
     * manual (credential-entry) mode replaces a stored token, an authorization
     * flow re-runs a sign-in. An account bound to a mode id this snapshot does
     * not carry still re-runs its flow — reachability is decided by
     * `canReconnect`, not by the descriptor — so it reads as an authorization
     * account.
     */
    const resolveAccountCredentialKind = (
        account: ConnectedAccountServiceProfile,
    ): ConnectedServiceAccountKind => {
        if (account.kind) return account.kind;
        const mode = props.modes.find(
            (candidate) => candidate.id === account.authenticationModeId,
        );
        return mode?.kind === 'manual' ? 'token' : 'oauth';
    };

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

    if (focus?.kind === 'group') {
        const group = groups.groups.find(
            (candidate) => candidate.ref.groupId === focus.groupId,
        ) ?? null;
        if (!group) {
            return groups.status === 'loading' ? (
                <FocusedScreenNotice
                    testID="connected-services-pool-detail:loading"
                    title={t('common.loading')}
                />
            ) : (
                <FocusedScreenNotice
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
            <QualifiedPoolDetailView
                group={group}
                accounts={accounts}
                accountLabels={accountLabels}
                serviceLabel={props.title}
                mutations={poolMutations}
                fallbackControlsEnabled={accountFallbackEnabled}
                fallbackDisabledSubtitle={
                    t('connectedServices.detail.groupActions.accountFallbackDisabled')
                }
                // Mutations here report failure by returning null and setting this;
                // without it a rejected change just reconciles away silently.
                error={groups.error}
            />
        );
    }

    if (focus?.kind === 'account') {
        const account = accounts.find(
            (candidate) => candidate.ref.accountId === focus.accountId,
        ) ?? null;
        if (!account) {
            return (
                <FocusedScreenNotice
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
        return (
            <QualifiedAccountDetailView
                account={account.ref}
                serviceLabel={props.title}
                presentation={resolveAccountIdentity(account)}
                providerEmail={account.providerIdentity?.email ?? null}
                providerAccountId={account.providerIdentity?.accountId ?? null}
                // RAW status: the view owns the recognized-status gate.
                status={account.status}
                isDefault={props.defaultAccountId === account.ref.accountId}
                // Pools apply only when this service has a pool source at all;
                // an empty array still renders the section with its empty state.
                {...(poolsAvailable ? {
                    groups: groups.groups,
                    onOpenPool: (groupId: string) => openFocus({ kind: 'group', groupId }),
                } : {})}
                {...(accountIsRevisioned && props.onToggleDefault ? {
                    onToggleDefault: () => props.onToggleDefault?.(account.ref),
                } : {})}
                {...(accountIsRevisioned && props.onEditLabel ? {
                    onEditLabel: () => props.onEditLabel?.(account.ref),
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

    /**
     * Quota compatibility is independent of the V4-only pool client: released
     * V2/V3 quota peers retain their own account-block read surface, while
     * groups themselves are only ever selected through V4.
     */
    const legacyBlockServiceId = legacyQuotaSupported
        && props.legacyServiceId
        ? props.legacyServiceId
        : null;

    const accountsContent = (
        <>
            <ItemGroup title={props.title} columns={2}>
                {sortedAccounts.length === 0 ? (
                    <EmptyState
                        testID="connected-accounts:empty"
                        icon={<Icon
                            name="key"
                            size={29}
                            color={theme.colors.text.secondary}
                        />}
                        title={t('connectedServices.detail.profiles.empty')}
                    />
                ) : sortedAccounts.map((account) => {
                    const authenticationMode = props.modes.find(
                        (mode) => mode.id === account.authenticationModeId,
                    );
                    const configurationBlocked = isConnectedAccountConfigurationBlocked({
                        account,
                        authenticationMode: authenticationMode ?? null,
                        serviceConfigurationStatusByModeId:
                            props.serviceConfigurationStatusByModeId,
                    });
                    const identity = resolveAccountIdentity(account);
                    const reconnectable = canReconnect(account);
                    const accountIsRevisioned =
                        account.revisionSemantics === 'revisioned';
                    const configurationSupported = Boolean(
                        accountIsRevisioned
                        && props.onConfigureAccount
                        && account.authenticationModeId
                        && props.modes.some((mode) => (
                            mode.id === account.authenticationModeId
                            && mode.configuration?.scope === 'account'
                        )),
                    );
                    // Row-level affordances live in the block's kebab menu — ONE
                    // child per account. They used to be sibling `Item` rows,
                    // which broke the 1:1 child/entity assumption the grid
                    // layout relies on and buried the account under its actions.
                    //
                    // The set, order, icons, and status gating come from the
                    // canonical row-action builder; this screen only supplies the
                    // handlers it is permitted to run, so an action the peer or
                    // the controller does not allow is ABSENT rather than
                    // disabled. dev's single reconnect handler re-runs whichever
                    // flow the account's mode owns, so it fills both the token
                    // and authorization slots the builder gates by kind.
                    const actions: ItemAction[] = buildConnectedServiceAccountRowActions({
                        kind: resolveAccountCredentialKind(account),
                        onOpen: () => openFocus({
                            kind: 'account',
                            accountId: account.ref.accountId,
                        }),
                        ...(accountIsRevisioned && props.onEditLabel ? {
                            onEditLabel: () => props.onEditLabel?.(account.ref),
                        } : {}),
                        ...(reconnectable ? {
                            onReplaceToken: () => props.onBeginReconnect?.(account.ref),
                            onReconnect: () => props.onBeginReconnect?.(account.ref),
                        } : {}),
                        ...(accountIsRevisioned && props.onRevoke ? {
                            onDisconnect: () => props.onRevoke?.(account.ref),
                        } : {}),
                    }).map((action) => (
                        props.busy && BUSY_GATED_ACCOUNT_ACTION_IDS.has(action.id)
                            ? { ...action, disabled: true }
                            : action
                    ));
                    if (configurationSupported) {
                        // Account-scoped plugin configuration has no slot in the
                        // shared builder (it exists only in dev's plugin-driven
                        // auth model), so it is appended to the same kebab.
                        actions.push({
                            id: 'configure',
                            title: t('connectedServices.account.configurationTitle'),
                            icon: 'sliders-horizontal',
                            disabled: props.busy,
                            onPress: () => props.onConfigureAccount?.(account.ref),
                        });
                    }
                    const identityLabel = [
                        identity.secondaryLabel,
                        configurationBlocked ? t('common.blocked') : null,
                    ].filter((value): value is string => Boolean(value)).join(' · ') || null;
                    const blockProps = {
                        testID: `connected-account:${account.ref.accountId}`,
                        title: identity.primaryLabel,
                        identityLabel,
                        // RAW status: the block owns the fail-open usage gate.
                        status: account.status,
                        isDefault: props.defaultAccountId === account.ref.accountId,
                        onToggleDefault: accountIsRevisioned
                            && props.onToggleDefault
                            ? () => props.onToggleDefault?.(account.ref)
                            : undefined,
                        poolLabels: poolLabelsByAccountId[account.ref.accountId],
                        actions,
                    } as const;
                    // Quota compatibility remains independent of the V4-only
                    // pool source: released legacy quota peers use their legacy
                    // block while every group operation is qualified V4.
                    return legacyBlockServiceId ? (
                        <AccountBlock
                            key={account.ref.accountId}
                            serviceId={legacyBlockServiceId}
                            profileId={account.ref.accountId}
                            {...blockProps}
                        />
                    ) : (
                        <QualifiedAccountBlock
                            key={account.ref.accountId}
                            account={account.ref}
                            {...blockProps}
                        />
                    );
                })}
            </ItemGroup>
            {/*
              * SERVICE-level actions only: connect a new account through each
              * public mode, and configure the service. Per-account actions live
              * in that account's own kebab, never as rows down here.
              */}
            {(
                props.onBeginConnect
                || props.onConfigureService
            ) ? (
                <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
                {props.onBeginConnect ? props.modes.map((mode) => (
                    <Item
                        key={mode.id}
                        testID={`connected-account-mode:${mode.id}`}
                        title={resolveProjectedLocalizedText(mode.title, props.localize) || mode.id}
                        icon={<Icon
                            name="plus-circle"
                            size={20}
                            color={theme.colors.accent.blue}
                        />}
                        disabled={props.busy}
                        onPress={() => props.onBeginConnect?.({
                            service: props.service,
                            modeId: mode.id,
                        })}
                    />
                )) : null}
                {props.onConfigureService ? props.modes
                    .filter((mode) =>
                        mode.configuration?.scope === 'service')
                    .map((mode) => (
                        <Item
                            key={`configure:${mode.id}`}
                            testID={`connected-service-configuration-settings:${mode.id}`}
                            title={t('connectedServices.account.configurationTitle')}
                            detail={[
                                resolveProjectedLocalizedText(mode.title, props.localize) || mode.id,
                                isConnectedAccountServiceConfigurationBlocked(
                                    props.serviceConfigurationStatusByModeId,
                                    mode.id,
                                ) ? t('common.blocked') : null,
                            ].filter(
                                (value): value is string => Boolean(value),
                            ).join(' · ')}
                            icon={<Icon
                                name="sliders-horizontal"
                                size={20}
                                color={theme.colors.accent.blue}
                            />}
                            disabled={props.busy}
                            onPress={() =>
                                props.onConfigureService?.(mode.id)}
                        />
                    )) : null}
                </ItemGroup>
            ) : null}
        </>
    );

    const poolsContent = (
        <QualifiedPoolsList
            groups={groups.groups}
            accounts={accounts}
            serviceLabel={props.title}
            accountLabels={accountLabels}
            status={groups.status}
            poolConfigurationSupported={poolsAvailable}
            onOpenPool={(groupId) => openFocus({ kind: 'group', groupId })}
            onCreatePool={() => {
                void createGroup();
            }}
            onRetryLoad={() => {
                void groups.refresh();
            }}
        />
    );

    return (
        <ConnectedServiceSegmentedShell
            activeSegment={activeSegment}
            onSelectSegment={setActiveSegment}
            poolsAvailable={poolsAvailable}
            accountsContent={accountsContent}
            poolsContent={poolsContent}
        />
    );
});
