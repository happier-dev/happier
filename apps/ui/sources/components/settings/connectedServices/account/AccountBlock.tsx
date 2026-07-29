import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    useConnectedServiceQuotaSnapshot,
    type UseConnectedServiceQuotaSnapshotResult,
} from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot';
import type { ComposedGesture, GestureType } from 'react-native-gesture-handler';

import { buildQuotaResetRows } from '@/sync/domains/connectedServices/buildQuotaResetRows';
import {
    computeConnectedServiceQuotaGaugeViewModel,
    type ConnectedServiceQuotaGaugeLabelFormatter,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { deriveAccountCapacityPct } from '@/sync/domains/connectedServices/deriveAccountCapacityPct';
import { type ResetCountdownDaysFormatter } from '@/sync/domains/connectedServices/formatResetCountdown';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import {
    ConnectedServiceCredentialHealthStatusV1Schema,
    type ConnectedServiceCredentialHealthStatusV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';
import { t } from '@/text';

import { resolveAccountUsageRows } from './accountBlockModel';
import {
    AccountBlockView,
    defaultAccountBlockTestID,
    type AccountBlockQuotaView,
    type AccountBlockVariant,
} from './AccountBlockView';

export type { AccountBlockVariant } from './AccountBlockView';

/**
 * Public, shared connected-service account block. ONE block renders every account
 * surface (account detail + pool member) so connected-service facts (health,
 * capacity, tone, resets) stop drifting across screens.
 *
 * This container owns the FEATURE GATE + quota-snapshot wiring and hands a single
 * `AccountBlockQuotaView` to the presentational `AccountBlockView`. When the
 * `connectedServices.quotas` feature is off, the snapshot hook is never mounted
 * (fail-closed: no fetch, no USAGE/RESETS, no quota-derived health).
 */
export interface AccountBlockProps {
    serviceId: ConnectedServiceId;
    profileId: string;
    title: string;
    /** Identity line (e.g. provider email) shown when expanded. */
    identityLabel?: string | null;
    /**
     * RAW credential status (pass the record value untouched). AccountBlock is the
     * single fail-direction owner for DISPLAY: the usage gate, snapshot fetch, and
     * reauth pill all fail OPEN — absent/unknown still shows usage and no pill;
     * only an explicit recognized `needs_reauth` hides usage and pins the pill.
     * Callers must NOT pre-normalize (fail-closed normalization is for row
     * actions/ordering only), or the fail-open gate becomes inert (UI-1).
     */
    status?: unknown;
    isDefault?: boolean;
    onToggleDefault?: () => void;
    /** Pool membership chip labels. */
    poolLabels?: ReadonlyArray<string>;
    /** Header kebab actions. */
    actions?: React.ComponentProps<typeof AccountBlockView>['actions'];
    variant?: AccountBlockVariant;
    /** poolMember: owning pool id (namespaces collapse + reorder). */
    groupId?: string | null;
    /** poolMember: member enabled state + toggle. */
    enabled?: boolean;
    onToggleEnabled?: (next: boolean) => void;
    /** poolMember: whether this member is the pool's currently-active account. */
    isActive?: boolean;
    /** poolMember: select this member as the active account (leading radio). */
    onSetActive?: () => void;
    /** poolMember: inline drag-reorder pan gesture (rendered INLINE in the view). */
    reorderGesture?: GestureType | ComposedGesture;
    showDivider?: boolean;
    testID?: string;
}

/**
 * Real `t()`-backed gauge formatter so the USAGE rows carry localized
 * remaining/used/reset labels through the canonical domain formatter.
 */
const GAUGE_LABEL_FORMATTER: ConnectedServiceQuotaGaugeLabelFormatter = {
    remaining: ({ percent }) => t('connectedServices.quota.remaining', { percent }),
    remainingWithReset: ({ percent, reset }) =>
        t('connectedServices.quota.remainingWithReset', { percent, reset }),
    used: ({ used, limit }) => t('connectedServices.account.usedDetail', { used, limit }),
    durationNow: () => t('connectedServices.quota.duration.now'),
    durationOutdated: () => t('connectedServices.quota.duration.outdated'),
    durationDaysHours: ({ days, hours }) => t('connectedServices.quota.duration.daysHours', { days, hours }),
    durationHoursMinutes: ({ hours, minutes }) =>
        t('connectedServices.quota.duration.hoursMinutes', { hours, minutes }),
    durationHours: ({ hours }) => t('connectedServices.quota.duration.hours', { hours }),
    durationMinutes: ({ minutes }) => t('connectedServices.quota.duration.minutes', { minutes }),
};

const RESET_COUNTDOWN_DAYS_FORMATTER: ResetCountdownDaysFormatter = {
    now: () => t('connectedServices.account.resets.now'),
    inDays: ({ days }) => t('connectedServices.account.resets.inDays', { days }),
};

type SharedViewProps = Omit<React.ComponentProps<typeof AccountBlockView>, 'quota'>;

/**
 * Fail-OPEN display parse: a recognized enum value passes through; `null`,
 * `undefined`, `''`, or any unrecognized string becomes `null` (no pill, no
 * hidden usage). The fail-CLOSED normalizer (`unknown -> needs_reauth`) is for
 * reauth-prompting actions/ordering at the callers, never for display (UI-1).
 */
function parseRecognizedCredentialStatus(status: unknown): ConnectedServiceCredentialHealthStatusV1 | null {
    const parsed = ConnectedServiceCredentialHealthStatusV1Schema.safeParse(status);
    return parsed.success ? parsed.data : null;
}

/**
 * Build the single `AccountBlockQuotaView` consumed by the header signals,
 * USAGE/RESETS body, capacity, and health dot. All quota facts flow through ONE
 * gauge view-model + ONE recovery-credit summary so they can never disagree.
 */
function buildQuotaView(hook: UseConnectedServiceQuotaSnapshotResult): AccountBlockQuotaView {
    const { snapshot, nowMs } = hook;

    const gauge = snapshot
        ? computeConnectedServiceQuotaGaugeViewModel({
            snapshot,
            windowMode: 'most_constrained',
            nowMs,
            formatter: GAUGE_LABEL_FORMATTER,
        })
        : null;

    const usageRows = resolveAccountUsageRows(gauge?.allMeterRows);
    const capacityPct = gauge ? deriveAccountCapacityPct(gauge.allMeterRows) : null;
    const resetRows = buildQuotaResetRows(snapshot?.recoveryCredits, nowMs, RESET_COUNTDOWN_DAYS_FORMATTER);

    return {
        loading: hook.loading,
        hasSnapshot: snapshot != null,
        isStale: hook.isStale,
        canRefresh: hook.canRefresh,
        isRefreshing: hook.isRefreshing,
        error: hook.error,
        refresh: hook.refresh,
        planLabel: snapshot?.planLabel ?? null,
        usageRows,
        capacityPct,
        resetRows,
        resetAvailableCount: hook.recoveryCreditSummary?.availableCount ?? 0,
        pinnedMeterIds: hook.pinnedMeterIds,
        togglePinnedMeter: hook.togglePinnedMeter,
        consumeRecoveryCredit: hook.consumeRecoveryCredit,
        consumeRecoveryCreditPending: hook.consumeRecoveryCreditPending,
        consumeRecoveryCreditPendingTarget: hook.consumeRecoveryCreditPendingTarget,
        // A reset can only be consumed when a target machine is resolved.
        canConsume: hook.recoveryCreditMachineId != null,
    };
}

/**
 * Quota-connected variant: mounts the shared snapshot hook (one network read per
 * account key, deduped by the shared store) and renders the block with live
 * USAGE/RESETS. Only rendered when the quotas feature is enabled so the hook is
 * never invoked behind a closed gate (fail-closed).
 */
const QuotaConnectedAccountBlock = React.memo(function QuotaConnectedAccountBlock(
    props: Readonly<SharedViewProps & { serviceId: ConnectedServiceId; profileId: string; rawCredentialStatus: unknown }>,
) {
    const { rawCredentialStatus, ...viewProps } = props;
    const hook = useConnectedServiceQuotaSnapshot({
        serviceId: props.serviceId,
        profileId: props.profileId,
        // The fetch key shares the fail-open gate with the display path, so it must
        // see the RAW status, not the normalized pill value in `props.status`.
        credentialHealthStatus: rawCredentialStatus,
    });
    const quota = buildQuotaView(hook);
    return <AccountBlockView {...viewProps} quota={quota} />;
});

export const AccountBlock = React.memo(function AccountBlock(props: AccountBlockProps) {
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');

    const testID = props.testID ?? defaultAccountBlockTestID({
        serviceId: props.serviceId,
        profileId: props.profileId,
        variant: props.variant,
        groupId: props.groupId,
    });

    const shared: SharedViewProps = {
        serviceId: props.serviceId,
        profileId: props.profileId,
        title: props.title,
        identityLabel: props.identityLabel,
        // Display fails OPEN end to end: only a RECOGNIZED enum value reaches the
        // view (pill shows solely for explicit needs_reauth); absent/unknown raw
        // values render as no-status. The raw value keeps flowing to the fail-open
        // usage gate + snapshot hook below.
        status: parseRecognizedCredentialStatus(props.status),
        isDefault: props.isDefault,
        onToggleDefault: props.onToggleDefault,
        poolLabels: props.poolLabels,
        actions: props.actions,
        variant: props.variant,
        groupId: props.groupId,
        enabled: props.enabled,
        onToggleEnabled: props.onToggleEnabled,
        isActive: props.isActive,
        onSetActive: props.onSetActive,
        reorderGesture: props.reorderGesture,
        showDivider: props.showDivider,
        testID,
    };

    // Usage display fails OPEN: hide quota only for an EXPLICIT needs_reauth
    // credential (shared with the snapshot hook). Absent/unknown status still
    // shows usage so healthy accounts never blank their capacity avatar.
    if (!quotasEnabled || shouldHideQuotaForCredentialStatus(props.status)) {
        return <AccountBlockView {...shared} quota={null} />;
    }

    return (
        <QuotaConnectedAccountBlock
            {...shared}
            serviceId={props.serviceId}
            profileId={props.profileId}
            rawCredentialStatus={props.status}
        />
    );
});

AccountBlock.displayName = 'AccountBlock';
