import * as React from 'react';
import type { ComposedGesture, GestureType } from 'react-native-gesture-handler';

import { useApplySettings } from '@/sync/store/settingsWriters';
import { useSetting } from '@/sync/store/hooks';
import { useQualifiedConnectedAccountQuota } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildQuotaResetRows } from '@/sync/domains/connectedServices/buildQuotaResetRows';
import {
    computeConnectedServiceQuotaGaugeViewModel,
    summarizeConnectedServiceQuotaRecoveryCredits,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { deriveAccountCapacityPct } from '@/sync/domains/connectedServices/deriveAccountCapacityPct';
import { parseDisplayableCredentialHealthStatus } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import {
    connectedServiceProfileKey,
    qualifiedConnectedAccountPreferenceServiceKey,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { type QualifiedConnectedAccountRef } from '@happier-dev/protocol';

import { resolveAccountUsageRows } from './accountBlockModel';
import {
    ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER,
    ACCOUNT_BLOCK_RESET_COUNTDOWN_DAYS_FORMATTER,
} from './accountBlockFormatters';
import {
    AccountBlockView,
    defaultAccountBlockTestID,
    type AccountBlockQuotaView,
    type AccountBlockVariant,
} from './AccountBlockView';

/**
 * Presentation namespace for a qualified service. Mirrors the projected route
 * key so collapse state and testIDs stay stable per service, and can never
 * collide with a legacy `ConnectedServiceId`.
 */
export function qualifiedServicePresentationKey(
    service: QualifiedConnectedAccountRef['service'],
): string {
    return `${service.pluginId}:${service.localId}`;
}

/**
 * Per-account pinned-meter preference key. Pins live in the SHARED
 * `connectedServicesQuotaPinnedMeterIdsByKey` map that the Usage panel and the
 * settings-list badges read, so the key must be built by the canonical
 * `connectedServiceProfileKey` owner over the qualified service key — exactly
 * how account labels and default-account preferences key the same account.
 */
function qualifiedPinnedMeterKey(ref: QualifiedConnectedAccountRef): string {
    return connectedServiceProfileKey({
        serviceId: qualifiedConnectedAccountPreferenceServiceKey(ref.service),
        profileId: ref.accountId,
    });
}

export interface QualifiedAccountBlockProps {
    account: QualifiedConnectedAccountRef;
    title: string;
    /** Identity line (e.g. provider email) shown when expanded. */
    identityLabel?: string | null;
    /**
     * RAW credential status (pass the record value untouched) — the usage gate
     * fails OPEN exactly as in the legacy block: only an explicit recognized
     * `needs_reauth` hides usage and pins the reauth pill.
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

type SharedViewProps = Omit<React.ComponentProps<typeof AccountBlockView>, 'quota'>;

/**
 * Quota-connected qualified block. Builds the SAME `AccountBlockQuotaView` the
 * legacy block builds, from the V4 snapshot — which is the legacy snapshot minus
 * its identity, so it flows through the same gauge owner.
 *
 * One affordance degrades because the V4 quota surface does not expose it:
 * recovery-credit consumption ("Use reset") is read-only. Pinned meters are a
 * LOCAL preference, so they keep working via the shared per-account settings map.
 */
const QuotaConnectedQualifiedAccountBlock = React.memo(function QuotaConnectedQualifiedAccountBlock(
    props: Readonly<SharedViewProps & { account: QualifiedConnectedAccountRef }>,
) {
    const { account, ...viewProps } = props;
    const hook = useQualifiedConnectedAccountQuota(account);
    const pinnedByKey = useSetting('connectedServicesQuotaPinnedMeterIdsByKey');
    const applySettings = useApplySettings();

    const settingKey = qualifiedPinnedMeterKey(account);
    const pinnedMeterIds = pinnedByKey[settingKey] ?? [];
    const togglePinnedMeter = React.useCallback((meterId: string) => {
        const existing = pinnedByKey[settingKey] ?? [];
        const nextPinned = existing.includes(meterId)
            ? existing.filter((id) => id !== meterId)
            : [...existing, meterId];
        const nextMap = { ...pinnedByKey };
        if (nextPinned.length === 0) delete nextMap[settingKey];
        else nextMap[settingKey] = nextPinned;
        applySettings({ connectedServicesQuotaPinnedMeterIdsByKey: nextMap });
    }, [applySettings, pinnedByKey, settingKey]);

    const snapshot = hook.snapshot;
    const nowMs = Date.now();
    const gauge = snapshot
        ? computeConnectedServiceQuotaGaugeViewModel({
            snapshot,
            windowMode: 'most_constrained',
            nowMs,
            formatter: ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER,
        })
        : null;

    const resetRows = buildQuotaResetRows(
        snapshot?.recoveryCredits,
        nowMs,
        ACCOUNT_BLOCK_RESET_COUNTDOWN_DAYS_FORMATTER,
    );

    const quota: AccountBlockQuotaView = {
        loading: hook.loading,
        hasSnapshot: snapshot != null,
        canRefresh: hook.supported === true,
        isRefreshing: hook.refreshing,
        error: hook.error,
        refresh: hook.refresh,
        planLabel: snapshot?.planLabel ?? null,
        usageRows: resolveAccountUsageRows(gauge?.allMeterRows),
        capacityPct: gauge ? deriveAccountCapacityPct(gauge.allMeterRows) : null,
        resetRows,
        // The collapsed reset signal counts AVAILABLE credits through the shared
        // summary owner, exactly as the legacy block does. Rows are not that count:
        // undisclosed credits collapse into one aggregate row.
        resetAvailableCount: summarizeConnectedServiceQuotaRecoveryCredits(
            snapshot?.recoveryCredits,
            nowMs,
        )?.availableCount ?? 0,
        pinnedMeterIds,
        togglePinnedMeter,
        // V4 exposes no credit-redemption operation at all, so the reset rows are
        // read-only: `unsupported` drops the "Use" affordance entirely instead of
        // disabling it behind the machine-unavailable explanation, which would
        // blame a transient machine for a capability the protocol never had.
        consumeRecoveryCredit: async () => {},
        consumeRecoveryCreditPending: false,
        consumeRecoveryCreditPendingTarget: null,
        consumeUnavailableReason: 'unsupported',
    };

    return <AccountBlockView {...viewProps} quota={quota} />;
});

/**
 * Qualified (V4) sibling of {@link AccountBlock}: the same account block, bound
 * to dev's qualified account identity and quota source. Both containers render
 * the one shared `AccountBlockView`, so account presentation stays single-owner
 * across the two identity models.
 */
export const QualifiedAccountBlock = React.memo(function QualifiedAccountBlock(
    props: QualifiedAccountBlockProps,
) {
    const quotasEnabled = useFeatureEnabled('connectedServices.quotas');
    const serviceId = qualifiedServicePresentationKey(props.account.service);
    const profileId = props.account.accountId;

    const testID = props.testID ?? defaultAccountBlockTestID({
        serviceId,
        profileId,
        variant: props.variant,
        groupId: props.groupId,
    });

    const shared: SharedViewProps = {
        serviceId,
        profileId,
        title: props.title,
        identityLabel: props.identityLabel,
        status: parseDisplayableCredentialHealthStatus(props.status),
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

    if (!quotasEnabled || shouldHideQuotaForCredentialStatus(props.status)) {
        return <AccountBlockView {...shared} quota={null} />;
    }

    return <QuotaConnectedQualifiedAccountBlock {...shared} account={props.account} />;
});

QualifiedAccountBlock.displayName = 'QualifiedAccountBlock';
