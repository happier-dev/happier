import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import {
    summarizeConnectedServiceQuotaRecoveryCredits,
    type ConnectedServiceQuotaRecoveryCreditSummary,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { useSetting } from '@/sync/store/hooks';
import { useApplySettings } from '@/sync/store/settingsWriters';
import {
    type ConnectedServiceId,
} from '@happier-dev/protocol';
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
    type LegacyQuotaSnapshotLoadContext,
} from './connectedServiceQuotaSnapshotStore';
import { useConnectedServiceRecoveryCreditMachineTarget } from './useConnectedServiceRecoveryCreditMachineTarget';
import {
    useConnectedServiceLegacyOperationAdmission,
} from './useConnectedServiceLegacyOperationAdmission';

export type UseConnectedServiceQuotaSnapshotResult = Readonly<{
    snapshot: ReturnType<typeof getQuotaSnapshotEntry>['snapshot'];
    loading: boolean;
    error: string | null;
    nowMs: number;
    recoveryCreditSummary: ConnectedServiceQuotaRecoveryCreditSummary | null;
    recoveryCreditMachineId: string | null;
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
 * This is the centralized choke point (load-scope guards, plain/sealed
 * resolution, refresh/backoff poll, recovery-credit consume) consumed by
 * `AccountBlock`; it additionally owns the per-account pinned-meter preference.
 */
export function useConnectedServiceQuotaSnapshot(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialHealthStatus?: unknown;
}>): UseConnectedServiceQuotaSnapshotResult {
    const { serviceId, profileId } = params;
    const auth = useAuth();
    const credentials = auth.credentials;
    const activeServer = useActiveServerSnapshot();

    const credentialScope =
        credentials && activeServer.serverId
            ? [
                activeServer.serverId,
                String(activeServer.generation),
                resolveAuthCredentialsScopeKey(credentials),
            ].join('\u0000')
            : '';
    const resolveAccountMode = useCredentialScopedAccountModeResolver({ credentials, credentialScope });
    const assertLegacyOperationAllowed =
        useConnectedServiceLegacyOperationAdmission();

    // Usage DISPLAY fails OPEN: hide/skip-fetch ONLY for an explicit, recognized
    // `needs_reauth`. Absent / unknown / '' status still fetches (presumed
    // healthy for display) — the opposite fail-direction from the fail-closed
    // reauth-prompting normalizer. Single owner shared with every quota gate.
    const credentialHealthUsable = !shouldHideQuotaForCredentialStatus(params.credentialHealthStatus);

    const key = credentials && credentialHealthUsable && activeServer.serverId
        ? buildQuotaSnapshotScopeKey(credentialScope, serviceId, profileId)
        : null;

    const loadContext =
        React.useMemo<LegacyQuotaSnapshotLoadContext | null>(() => {
        if (
            !credentials
            || !credentialHealthUsable
            || !activeServer.serverId
        ) return null;
        return {
            credentials,
            credentialScope,
            serverBasis: {
                serverId: activeServer.serverId,
                generation: activeServer.generation,
            },
            serviceId,
            profileId,
            resolveAccountMode,
            assertOperationAllowed: (operation) =>
                assertLegacyOperationAllowed(serviceId, operation),
        };
    }, [
        assertLegacyOperationAllowed,
        activeServer.generation,
        activeServer.serverId,
        credentialHealthUsable,
        credentials,
        credentialScope,
        serviceId,
        profileId,
        resolveAccountMode,
    ]);

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
    const recoveryCreditSummary = summarizeConnectedServiceQuotaRecoveryCredits(snapshot?.recoveryCredits, nowMs);
    const recoveryCreditMachineId = useConnectedServiceRecoveryCreditMachineTarget({ serviceId, profileId });

    const [actionError, setActionError] = React.useState<string | null>(null);
    const [consumeRecoveryCreditPendingTarget, setConsumeRecoveryCreditPendingTarget] = React.useState<Readonly<{
        providerCreditId: string | null;
    }> | null>(null);
    const snapshotSuccessKey = snapshot ? `${snapshot.serviceId}:${snapshot.profileId}:${snapshot.fetchedAt}` : null;

    React.useEffect(() => {
        if (!snapshotSuccessKey) return;
        setActionError(null);
    }, [snapshotSuccessKey]);

    const refresh = React.useCallback(async () => {
        if (!key || !loadContext) return;
        setActionError(null);
        await refreshQuotaSnapshot(key, loadContext);
    }, [key, loadContext]);

    const consumeRecoveryCredit = React.useCallback(async (providerCreditId?: string | null) => {
        if (!recoveryCreditSummary) return;
        if (!recoveryCreditMachineId) {
            setActionError(t('connectedServices.quota.recoveryCreditMachineUnavailable'));
            return;
        }
        if (!key || !loadContext) return;
        // Redeem the row's specific credit when provided, else the summary default.
        const targetCreditId = providerCreditId ?? null;
        setConsumeRecoveryCreditPendingTarget({ providerCreditId: targetCreditId ?? null });
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
    }, [key, loadContext, recoveryCreditMachineId, recoveryCreditSummary]);

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
        loading: entry.loading,
        error: actionError ?? entry.error,
        nowMs,
        recoveryCreditSummary,
        recoveryCreditMachineId,
        canRefresh: credentialHealthUsable,
        isRefreshing: entry.refreshing,
        refresh,
        consumeRecoveryCredit,
        consumeRecoveryCreditPending: consumeRecoveryCreditPendingTarget !== null,
        consumeRecoveryCreditPendingTarget,
        pinnedMeterIds,
        togglePinnedMeter,
    };
}
