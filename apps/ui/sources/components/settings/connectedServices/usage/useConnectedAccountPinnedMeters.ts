import * as React from 'react';
import type { ConnectedServiceId} from '@happier-dev/protocol/connect/connected-service-bindings';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';

import {
    resolveQualifiedConnectedAccountProfilePreference,
    updateQualifiedConnectedAccountProfilePreference,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { useSettingMutable } from '@/sync/domains/state/storage';

const NO_PINS: readonly string[] = [];

/**
 * The usage windows pinned on one connected account (`connectedServicesQuotaPinnedMeterIdsByKey`).
 * Pinned windows lead the account's usage summaries and show as extra composer gauges; this is the
 * one writer of the setting.
 */
export function useConnectedAccountPinnedMeters(params: Readonly<{
    account: QualifiedConnectedAccountRef;
    legacyServiceId: ConnectedServiceId | null;
}>): Readonly<{ pinnedMeterIds: readonly string[]; onToggle: (meterId: string) => void }> {
    const [pinnedByKey, setPinnedByKey] = useSettingMutable('connectedServicesQuotaPinnedMeterIdsByKey');
    const { account, legacyServiceId } = params;
    const pinnedMeterIds = resolveQualifiedConnectedAccountProfilePreference({
        valuesByKey: pinnedByKey,
        service: account.service,
        legacyServiceId,
        accountId: account.accountId,
    }) ?? NO_PINS;
    const onToggle = React.useCallback((meterId: string) => {
        const next = pinnedMeterIds.includes(meterId)
            ? pinnedMeterIds.filter((id) => id !== meterId)
            : [...pinnedMeterIds, meterId];
        setPinnedByKey(updateQualifiedConnectedAccountProfilePreference({
            valuesByKey: pinnedByKey,
            service: account.service,
            legacyServiceId,
            accountId: account.accountId,
            value: next.length > 0 ? next : null,
        }));
    }, [account.accountId, account.service, legacyServiceId, pinnedByKey, pinnedMeterIds, setPinnedByKey]);
    return React.useMemo(() => ({ pinnedMeterIds, onToggle }), [onToggle, pinnedMeterIds]);
}
