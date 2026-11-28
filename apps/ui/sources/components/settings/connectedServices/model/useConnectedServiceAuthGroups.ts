import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import {
    createConnectedServiceAuthGroupV3,
} from '@/sync/api/account/apiConnectedServiceAuthGroupsV3';
import {
    useConnectedServiceAuthGroupsQuery,
    type ConnectedServiceAuthGroupsLoadStatus,
} from '@/hooks/server/connectedServices/useConnectedServiceAuthGroupsQuery';
import { deriveConnectedServiceAuthGroupIdFromName } from '@/sync/domains/connectedServices/deriveConnectedServiceAuthGroupIdFromName';
import { t } from '@/text';
import type { ConnectedServiceAuthGroupV1, ConnectedServiceId } from '@happier-dev/protocol';

import { presentConnectedServiceAccountStatusConsent } from '../consent/presentConnectedServiceAccountStatusConsent';
import { resolveConnectedServiceSettingsErrorMessage } from '../errors/connectedServiceSettingsErrors';
export {
    readConnectedServiceAuthGroupsLoadStatus,
    type ConnectedServiceAuthGroupsLoadStatus,
} from '@/hooks/server/connectedServices/useConnectedServiceAuthGroupsQuery';

export type UseConnectedServiceAuthGroupsParams = Readonly<{
    serviceId: ConnectedServiceId | null;
    accountGroupsEnabled: boolean;
    /** Per-provider runtime capability: whether pools can be configured at all. */
    groupConfigurationSupported: boolean;
    runtimeGroupFallbackSupported: boolean;
    /**
     * Structural signature of the projected service (profiles + groups) so the
     * authoritative refetch re-runs when the projection meaningfully changes.
     */
    serviceProjectionSignature: string;
}>;

export type UseConnectedServiceAuthGroupsResult = Readonly<{
    /** Authoritative groups loaded from `listConnectedServiceAuthGroupsV3`. */
    groups: ReadonlyArray<ConnectedServiceAuthGroupV1>;
    /** Explicit status so list UIs can distinguish loading/refreshing from authoritative empty. */
    loadStatus: ConnectedServiceAuthGroupsLoadStatus;
    /** Refetch the authoritative groups (after a mutation completes elsewhere). */
    refresh: () => Promise<ReadonlyArray<ConnectedServiceAuthGroupV1>>;
    /** Create a new pool ("auth group"). No-op when configuration is unsupported. */
    createPool: () => Promise<void>;
}>;

/**
 * Owns the per-provider authoritative auth-group ("pool") read path + the
 * create-pool mutation extracted from `ConnectedServiceDetailView`. Member and
 * policy mutations live in `PoolDetailView` (its own controller); the segmented
 * shell only needs the group list + create flow. Wire symbols stay
 * `group`/`AuthGroup`/`groupId`; "pool" is the user-facing surface name.
 */
export function useConnectedServiceAuthGroups(
    params: UseConnectedServiceAuthGroupsParams,
): UseConnectedServiceAuthGroupsResult {
    const {
        serviceId,
        accountGroupsEnabled,
        groupConfigurationSupported,
        serviceProjectionSignature,
    } = params;
    const auth = useAuth();
    const { groups, loadStatus, refresh, upsertGroup } = useConnectedServiceAuthGroupsQuery({
        serviceId,
        enabled: accountGroupsEnabled,
        serviceProjectionSignature,
    });

    const ensureCredentials = React.useCallback(() => {
        if (!auth.credentials) {
            throw new Error('Not authenticated');
        }
        return auth.credentials;
    }, [auth]);

    const createPool = React.useCallback(async () => {
        if (!serviceId || !accountGroupsEnabled || !groupConfigurationSupported) {
            return;
        }
        // A pool of a consent-gated service turns on account reads for its members.
        if (!(await presentConnectedServiceAccountStatusConsent([serviceId]))) return;
        const res = await Modal.prompt(
            t('connectedServices.detail.groupActions.createTitle'),
            t('connectedServices.detail.groupActions.createSubtitle'),
            {
                placeholder: t('connectedServices.detail.groupActions.displayNamePlaceholder'),
                confirmText: t('common.create'),
                cancelText: t('common.cancel'),
            },
        );
        const displayName = typeof res === 'string' ? res.trim() : '';
        if (!displayName) return;
        const existingGroupIds = groups.map((group) => group.groupId);
        const groupId = deriveConnectedServiceAuthGroupIdFromName({ name: displayName, existingGroupIds })
            ?? deriveConnectedServiceAuthGroupIdFromName({ name: 'group', existingGroupIds });
        if (!groupId) {
            await Modal.alert(
                t('connectedServices.detail.groupActions.invalidGroupIdTitle'),
                t('connectedServices.detail.groupActions.invalidGroupIdBody'),
            );
            return;
        }
        try {
            const created = await createConnectedServiceAuthGroupV3(ensureCredentials(), {
                serviceId,
                groupId,
                displayName,
                members: [],
                activeProfileId: null,
            });
            await sync.refreshProfile().catch(() => undefined);
            await refresh().catch(() => undefined);
            upsertGroup(created);
        } catch (e: unknown) {
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
        }
    }, [
        accountGroupsEnabled,
        ensureCredentials,
        groupConfigurationSupported,
        groups,
        refresh,
        serviceId,
        upsertGroup,
    ]);

    return { groups, loadStatus, refresh, createPool };
}
