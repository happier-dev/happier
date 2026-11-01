import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import {
    summarizeConnectedServiceQuotaRecoveryCredits,
    type ConnectedServiceQuotaRecoveryCreditSummary,
} from '@/sync/domains/connectedServices/connectedServiceQuotaRecoveryCreditSummary';
import { useSetting } from '@/sync/store/hooks';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { type ConnectedServiceId } from '@happier-dev/protocol';
import { t } from '@/text';
import { Modal } from '@/modal';
import { resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey } from '@/sync/domains/connectedServices/connectedServiceQuotaRecoveryCreditReceiptPresentation';

import { useCredentialScopedAccountModeResolver } from './useCredentialScopedAccountModeResolver';
import {
    buildQuotaSnapshotScopeKey,
    consumeQuotaRecoveryCredit,
    getQuotaSnapshotEntry,
    retainQuotaSnapshotPolling,
    refreshQuotaSnapshot,
    subscribeQuotaSnapshotEntry,
    type QuotaSnapshotLoadContext,
} from '@/sync/domains/connectedServices/connectedServiceQuotaSnapshotStore';
import { useConnectedServiceRecoveryCreditMachineTarget } from './useConnectedServiceRecoveryCreditMachineTarget';

export type UseConnectedServiceQuotaSnapshotResult = Readonly<{
    snapshot: ReturnType<typeof getQuotaSnapshotEntry>['snapshot'];
    loading: boolean;
    error: string | null;
    isStale: boolean;
    nowMs: number;
    recoveryCreditSummary: ConnectedServiceQuotaRecoveryCreditSummary | null;
    recoveryCreditMachineId: string | null;
    canConsumeRecoveryCredit: boolean;
    /** False when this hook is displaying a provider-account-usage projection without a source-correct refresh path. */
    canRefresh: boolean;
    /** True while a force-refresh (server refresh + reload poll) is in flight. */
    isRefreshing: boolean;
    refresh: () => Promise<void>;
    /**
     * Consume a recovery credit. Pass a `providerCreditId` to redeem THAT
     * specific credit (per-row "Use"); omit it to redeem the summary's default
     * (the aggregate placeholder row).
     */
    consumeRecoveryCredit: (providerCreditId?: string | null) => Promise<void>;
    consumeRecoveryCreditPending: boolean;
    consumeRecoveryCreditPendingTarget: Readonly<{ providerCreditId: string | null }> | null;
    pinnedMeterIds: ReadonlyArray<string>;
    togglePinnedMeter: (meterId: string) => void;
}>;

/**
 * Single connected-service account quota snapshot, backed by a shared cache so
 * the same account in multiple mounted blocks performs ONE network read.
 * Extracted from `ConnectedServiceQuotaCard` (load-scope guards, plain/sealed
 * resolution, refresh/backoff poll, recovery-credit consume) and additionally
 * owns the per-account pinned-meter preference.
 */
export function useConnectedServiceQuotaSnapshot(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialHealthStatus?: unknown;
    enabled?: boolean;
}>): UseConnectedServiceQuotaSnapshotResult {
    const { serviceId, profileId } = params;
    const enabled = params.enabled !== false;
    const auth = useAuth();
    const credentials = auth.credentials;

    const credentialScope = credentials ? resolveAuthCredentialsScopeKey(credentials) : '';
    const resolveAccountMode = useCredentialScopedAccountModeResolver({ credentials, credentialScope });

    // Usage fetch fails OPEN: only an EXPLICIT needs_reauth credential suppresses
    // the snapshot read. Shared with the AccountBlock display gate so the gate and
    // the fetch key can never disagree (absent/unknown status still fetches).
    const credentialHealthUsable = !shouldHideQuotaForCredentialStatus(params.credentialHealthStatus);

    const key = enabled && credentials && credentialHealthUsable
        ? buildQuotaSnapshotScopeKey(credentialScope, serviceId, profileId)
        : null;

    const loadContext = React.useMemo<QuotaSnapshotLoadContext | null>(() => {
        if (!enabled || !credentials || !credentialHealthUsable) return null;
        return { credentials, credentialScope, serviceId, profileId, resolveAccountMode };
    }, [enabled, credentialHealthUsable, credentials, credentialScope, serviceId, profileId, resolveAccountMode]);

    const subscribe = React.useCallback(
        (onChange: () => void) => subscribeQuotaSnapshotEntry(key, onChange),
        [key],
    );
    const getEntry = React.useCallback(() => getQuotaSnapshotEntry(key), [key]);
    const entry = React.useSyncExternalStore(subscribe, getEntry, getEntry);

    React.useEffect(() => {
        if (!key || !loadContext) return;
        return retainQuotaSnapshotPolling(key, loadContext);
    }, [key, loadContext]);

    const snapshot = entry.snapshot;
    const nowMs = Date.now();
    const isStale = snapshot ? nowMs - snapshot.fetchedAt > snapshot.staleAfterMs : false;
    const canConsumeRecoveryCredit = credentialHealthUsable && snapshot !== null;
    const recoveryCreditSummary = summarizeConnectedServiceQuotaRecoveryCredits(snapshot?.recoveryCredits, nowMs);
    const recoveryCreditMachineId = useConnectedServiceRecoveryCreditMachineTarget();

    const [actionError, setActionError] = React.useState<string | null>(null);
    const [consumeRecoveryCreditPendingTarget, setConsumeRecoveryCreditPendingTarget] = React.useState<Readonly<{
        providerCreditId: string | null;
    }> | null>(null);

    const snapshotSuccessKey = snapshot
        ? `${snapshot.serviceId}:${snapshot.profileId}:${snapshot.fetchedAt}`
        : null;

    React.useEffect(() => {
        if (snapshotSuccessKey) setActionError(null);
    }, [snapshotSuccessKey]);

    const refresh = React.useCallback(async () => {
        if (!key || !loadContext) return;
        setActionError(null);
        await refreshQuotaSnapshot(key, loadContext);
    }, [key, loadContext]);

    const consumeRecoveryCredit = React.useCallback(async (providerCreditId?: string | null) => {
        if (!canConsumeRecoveryCredit) return;
        if (!recoveryCreditSummary) return;
        if (!recoveryCreditMachineId) {
            setActionError(t('connectedServices.quota.recoveryCreditMachineUnavailable'));
            return;
        }
        if (!key || !loadContext) return;
        // Redeem the row's specific credit when provided, else the summary default.
        const targetCreditId = providerCreditId ?? null;
        setConsumeRecoveryCreditPendingTarget({ providerCreditId: targetCreditId });
        setActionError(null);
        try {
            const result = await consumeQuotaRecoveryCredit(key, {
                ...loadContext,
                machineId: recoveryCreditMachineId,
                providerCreditId: targetCreditId,
            });
            if (!result.ok) {
                setActionError(result.error);
            } else {
                const noticeKey = resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey(result.receipt.status);
                if (noticeKey) await Modal.alert(t('common.info'), t(noticeKey));
            }
        } finally {
            setConsumeRecoveryCreditPendingTarget(null);
        }
    }, [canConsumeRecoveryCredit, key, loadContext, recoveryCreditMachineId, recoveryCreditSummary]);

    const pinnedByKey = useSetting('connectedServicesQuotaPinnedMeterIdsByKey');
    const applySettings = useApplySettings();
    const settingKey = connectedServiceProfileKey({ serviceId, profileId });
    const pinnedMeterIds = pinnedByKey[settingKey] ?? [];
    const togglePinnedMeter = React.useCallback((meterId: string) => {
        const existing = pinnedByKey[settingKey] ?? [];
        const nextPinned = existing.includes(meterId)
            ? existing.filter((id) => id !== meterId)
            : [...existing, meterId];
        const nextMap = { ...pinnedByKey };
        if (nextPinned.length === 0) {
            delete nextMap[settingKey];
        } else {
            nextMap[settingKey] = nextPinned;
        }
        applySettings({ connectedServicesQuotaPinnedMeterIdsByKey: nextMap });
    }, [applySettings, pinnedByKey, settingKey]);

    return {
        snapshot,
        loading: snapshot ? false : entry.loading,
        error: actionError ?? entry.error,
        isStale,
        nowMs,
        recoveryCreditSummary,
        recoveryCreditMachineId,
        canConsumeRecoveryCredit,
        canRefresh: key !== null && loadContext !== null,
        isRefreshing: entry.refreshing,
        refresh,
        consumeRecoveryCredit,
        consumeRecoveryCreditPending: consumeRecoveryCreditPendingTarget !== null,
        consumeRecoveryCreditPendingTarget,
        pinnedMeterIds,
        togglePinnedMeter,
    };
}
