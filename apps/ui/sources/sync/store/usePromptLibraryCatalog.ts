import * as React from 'react';
import { PromptLibraryRecordV1Schema, type PromptLibraryCatalogKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { observePromptLibraryCatalog } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getPromptLibraryCatalogValue, subscribePromptLibraryCatalogSnapshots, type PromptLibraryCatalogValueSnapshot, type PromptLibraryValueV1 } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { writePromptLibraryRecord } from '@/sync/api/account/apiPromptLibraryCatalog';

const unavailableScope = Object.freeze({ status: 'unavailable', value: null, revision: 'absent',
    sourceSettingsVersion: null, stale: true, reason: 'scope-unavailable' } as const);
const noSubscription = () => () => {};
type CatalogDemand = Readonly<{ enabled?: boolean }>;
function usePromptLibraryCatalogSource<K extends PromptLibraryCatalogKeyV1>(key: K, requestedScope?: ServerAccountScope | null, demand?: CatalogDemand) {
    const activeScope = useAccountSettingsScope();
    const scope = requestedScope === undefined ? activeScope : requestedScope;
    const explicitlyUnavailable = requestedScope === null;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const captured = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    const enabled = demand?.enabled !== false;
    React.useEffect(() => captured && enabled ? observePromptLibraryCatalog(captured) : undefined, [captured, enabled]);
    const read = React.useCallback(() => explicitlyUnavailable ? unavailableScope : getPromptLibraryCatalogValue(captured, key),
        [captured, explicitlyUnavailable, key]);
    return { captured, read };
}

/** Read-only observers select displayed facts; writers retain the complete authority/CAS snapshot. */
export function usePromptLibraryCatalogSelection<K extends PromptLibraryCatalogKeyV1, T>(key: K,
    select: (snapshot: PromptLibraryCatalogValueSnapshot<K>) => T, requestedScope?: ServerAccountScope | null, demand?: CatalogDemand): T {
    const { read } = usePromptLibraryCatalogSource(key, requestedScope, demand);
    const readSelection = React.useCallback(() => select(read()), [read, select]);
    return React.useSyncExternalStore(demand?.enabled === false ? noSubscription : subscribePromptLibraryCatalogSnapshots, readSelection, readSelection);
}

export function usePromptLibraryCatalogValue<K extends PromptLibraryCatalogKeyV1>(key: K, requestedScope?: ServerAccountScope | null) {
    const { captured, read } = usePromptLibraryCatalogSource(key, requestedScope);
    const snapshot = React.useSyncExternalStore(subscribePromptLibraryCatalogSnapshots, read, read);
    const write = React.useCallback(async (value: PromptLibraryValueV1<K>) => {
        if (!captured || snapshot.status !== 'ready' || snapshot.stale) throw new Error('Prompt library catalog is unavailable');
        const record = PromptLibraryRecordV1Schema.parse({ key, value });
        const result = await writePromptLibraryRecord(captured, { record, expectedRevision: snapshot.revision,
            ...(snapshot.revision === 'absent' && snapshot.sourceSettingsVersion !== null ? { sourceSettingsVersion: snapshot.sourceSettingsVersion } : {}) });
        return result;
    }, [captured, key, snapshot]);
    return React.useMemo(() => ({ ...snapshot, write }), [snapshot, write]);
}
