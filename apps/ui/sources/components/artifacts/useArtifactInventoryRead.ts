import * as React from 'react';

import { sync } from '@/sync/sync';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ArtifactInventorySelection } from '@/sync/domains/artifacts/artifactInventory';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

/**
 * The Artifact inventory read as a surface sees it: when `enabled` it asks the sync owner's queue for
 * the list (`sync.requestArtifactInventoryRead`, which publishes full or requested-kind membership),
 * reports whether that read failed, and `retry` reads again at once. A surface that waits on membership enables it only while
 * the inventory is unknown; one that opens as the intent to refresh it stays enabled. A surface that
 * needs only a leading window (a capped count) passes `window`; pass a stable function.
 */
export function useArtifactInventoryRead(enabled: boolean, selection?: ArtifactInventorySelection, options?: Readonly<{
    includeProvenance?: boolean;
    window?: (read: readonly DecryptedArtifact[]) => boolean;
}>): Readonly<{ failed: boolean; retry: () => void }> {
    const scope = useAccountSettingsScope();
    const presented = useLayoutPresentationActive();
    const initialReadEnabled = React.useRef(enabled);
    initialReadEnabled.current = enabled;
    const includeProvenance = options?.includeProvenance === true;
    const window = options?.window;
    const [failedScope, setFailedScope] = React.useState<ServerAccountScope | null>(null);
    const failed = areServerAccountScopesEqual(scope, failedScope);
    const onSettled = React.useCallback((outcome: 'success' | 'failed') => {
        setFailedScope(outcome === 'failed' ? scope ?? null : null);
    }, [scope?.serverId, scope?.accountId]);
    const attempt = React.useRef<AbortController | null>(null);
    // Readiness can disable the opening read while this mounted surface still needs recovery refreshes.
    React.useEffect(() => {
        if (!scope || !presented) return;
        return sync.observeArtifactInventory(scope, selection, {
            includeProvenance,
            // Already-read rows may have missed a cursor-gone refresh while hidden.
            refreshOnAdmission: !initialReadEnabled.current,
            onSettled,
            window,
        });
    }, [selection, scope?.serverId, scope?.accountId, includeProvenance, presented, onSettled, window]);
    const retry = React.useCallback(() => {
        if (!scope || !presented || Array.isArray(selection) && selection.length === 0) return;
        attempt.current?.abort();
        const controller = new AbortController();
        attempt.current = controller;
        // The same selected acquisition owner reports finite reads and recovery refreshes.
        // Keep a failed refresh visible while Retry is still unfinished.
        void sync.fetchArtifactsList({ selection, signal: controller.signal }).catch(() => {});
    }, [selection, scope?.serverId, scope?.accountId, presented]);
    // The sync queue reads it (an unknown census, or a known one this surface opens to refresh) and joins
    // an unfinished read of it (the scope's first acquisition, another surface's) instead of a second one.
    React.useEffect(() => {
        if (!enabled || !scope || !presented || Array.isArray(selection) && selection.length === 0) return;
        sync.requestArtifactInventoryRead(selection);
    }, [enabled, selection, scope?.serverId, scope?.accountId, presented]);
    React.useEffect(() => () => { attempt.current?.abort(); }, [retry]);
    return { failed, retry };
}
