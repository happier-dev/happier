import * as React from 'react';

import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability';

import {
    getInstalledPluginReactNativeBundleCache,
    type PluginReactNativeBundleCache,
} from '@/components/plugins/reactNative/bundleCache';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import {
    derivePluginUiPersistentArtifactKey,
    type PluginUiPersistentArtifactIdentity,
} from '@/sync/domains/plugins/ui/artifactByteCache';

import {
    createPluginAccountAvailabilityReaderStore,
    createPluginAccountAvailabilityReader,
    projectPluginAccountAvailabilityMaterializationIdentity,
    type PluginAccountAvailabilityReader,
    type PluginAccountAvailabilityReleaseClassificationV1,
    type PluginAccountAvailabilitySnapshot,
    type PluginAccountAvailabilityStoredProjection,
} from './reader';

const readerStore = createPluginAccountAvailabilityReaderStore();
let projectionRevision = 0;
// AccountChange clears the active projection before its single coalesced
// refresh supplies the next verified snapshot. Retain exactly that predecessor
// in the incumbent writer; it remains unreadable and is not a second cache or
// persistent identity index.
let clearedProjection: PluginAccountAvailabilityStoredProjection | null = null;
let clearedProjectionRetirement: Readonly<{ dispose: () => void }> | null = null;

function advanceProjectionRevision(): void {
    projectionRevision += 1;
}

function currentProjectionLifetime(scope: ServerAccountScope): ActiveServerAccountScopeLifetime | null {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (
        !lifetime
        || !lifetime.isCurrent()
        || !areServerAccountScopesEqual(lifetime.scope, scope)
    ) return null;
    return lifetime;
}

function releaseClearedProjection(): void {
    clearedProjection = null;
    clearedProjectionRetirement?.dispose();
    clearedProjectionRetirement = null;
}

function retainClearedProjection(previous: PluginAccountAvailabilityStoredProjection): void {
    if (clearedProjection) return;
    const lifetime = currentProjectionLifetime(previous.scope);
    if (!lifetime) return;

    clearedProjection = previous;
    let retirement: Readonly<{ dispose: () => void }> | null = null;
    retirement = lifetime.onRetire(() => {
        if (clearedProjection === previous) {
            clearedProjection = null;
        }
        if (clearedProjectionRetirement === retirement) {
            clearedProjectionRetirement = null;
        }
    });
    // A retirement may win between currentness observation and subscription.
    // In that terminal path, never retain a predecessor beyond its Account.
    if (clearedProjection === previous) {
        clearedProjectionRetirement = retirement;
    } else {
        retirement.dispose();
    }
}

function currentPersistentArtifactIdentities(
    projection: Readonly<{
        scope: ServerAccountScope;
        snapshot: PluginAccountAvailabilitySnapshot;
    }>,
): ReadonlyMap<string, PluginUiPersistentArtifactIdentity> {
    const reader = createPluginAccountAvailabilityReader(projection);
    const identities = new Map<string, PluginUiPersistentArtifactIdentity>();
    for (const intentRead of projection.snapshot.intentReads) {
        const slots = intentRead.response.release?.uiSlots ?? [];
        for (const slot of slots) {
            const admission = reader.readCurrentArtifact({
                pluginId: intentRead.pluginId,
                contributionId: slot.contributionId,
                tier: slot.tier,
                platform: slot.platform,
            });
            if (admission.kind !== 'available') continue;
            const identity: PluginUiPersistentArtifactIdentity = Object.freeze({
                accountScope: projection.scope,
                releaseVersion: admission.artifact.releaseVersion,
                pluginId: admission.artifact.pluginId,
                contributionId: admission.artifact.contributionId,
                tier: admission.artifact.tier,
                platform: admission.artifact.platform,
                artifactDigest: admission.artifact.digest,
            });
            identities.set(derivePluginUiPersistentArtifactKey(identity), identity);
        }
    }
    return identities;
}

function discardPersistentArtifactsRevokedByProjectionReplacement(input: Readonly<{
    previous: PluginAccountAvailabilityStoredProjection;
    next: Readonly<{
        scope: ServerAccountScope;
        snapshot: PluginAccountAvailabilitySnapshot;
    }>;
    revision: number;
    lifetime: ActiveServerAccountScopeLifetime;
    cache: Pick<PluginReactNativeBundleCache, 'removePersistentArtifact'>;
}>): void {
    if (!areServerAccountScopesEqual(input.previous.scope, input.next.scope)) return;
    const previous = currentPersistentArtifactIdentities(input.previous);
    if (previous.size === 0) return;
    const next = currentPersistentArtifactIdentities(input.next);
    const revoked = [...previous].filter(([key]) => !next.has(key));
    if (revoked.length === 0) return;

    const isCurrent = () => (
        projectionRevision === input.revision
        && input.lifetime.isCurrent()
        && areServerAccountScopesEqual(input.lifetime.scope, input.next.scope)
    );
    for (const [, identity] of revoked) {
        // The cache owns physical removal, its Account operation fence, and
        // account quarantine on deletion failure. The projection only revokes
        // identities its new verified snapshot no longer admits.
        void input.cache.removePersistentArtifact(identity, isCurrent).catch(() => undefined);
    }
}

/**
 * The sole UI projection writer. The Account Availability HTTP/change owner
 * replaces one complete verified snapshot; consumers only read Account
 * currentness/materialization facts and never write a URL, cache source, or
 * currentness decision into it.
 */
export function replacePluginAccountAvailabilityProjection(input: Readonly<{
    scope: ServerAccountScope;
    snapshot: PluginAccountAvailabilitySnapshot;
}>): void {
    const previous = readerStore.replace(input) ?? clearedProjection;
    releaseClearedProjection();
    advanceProjectionRevision();
    const lifetime = currentProjectionLifetime(input.scope);
    if (!lifetime) return;
    const cache = getInstalledPluginReactNativeBundleCache();
    // Availability is the current Account projection owner. Binding the
    // incumbent cache here makes prior-run bytes retire even when no surface
    // acquires an Artifact during this app lifetime.
    cache.bindAccountLifetime(lifetime);
    if (!previous) return;
    discardPersistentArtifactsRevokedByProjectionReplacement({
        previous,
        next: input,
        revision: projectionRevision,
        lifetime,
        cache,
    });
}

/** Called by the incumbent Account-lifetime/reset owner through its consumer hook. */
export function clearPluginAccountAvailabilityProjection(): void {
    const previous = readerStore.clear();
    if (previous) retainClearedProjection(previous);
    advanceProjectionRevision();
}

/**
 * The one app-facing injection point for Account Availability facts. A
 * returned reader is bound to the active Account realm, so a consumer cannot
 * accidentally pass a local server id or machine choice into currentness.
 */
export function useActivePluginAccountAvailabilityReader(): PluginAccountAvailabilityReader | null {
    const scope = useActiveServerAccountScope();
    const subscribe = React.useCallback((listener: () => void) => readerStore.subscribe(listener), []);
    const getSnapshot = React.useCallback(() => projectionRevision, []);
    const revision = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const serverId = scope?.serverId ?? null;
    const accountId = scope?.accountId ?? null;

    React.useEffect(() => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        const subscription = lifetime.onRetire(clearPluginAccountAvailabilityProjection);
        return () => subscription.dispose();
    }, [accountId, serverId]);

    return React.useMemo(() => {
        if (!scope) return null;
        return readerStore.bind(scope);
    }, [accountId, revision, scope, serverId]);
}

/**
 * Availability's single classifier injection for Administration. An absent
 * Account projection is an explicit fail-closed release result, not a local
 * version or source fallback.
 */
export function useActivePluginAccountAvailabilityReleaseClassifier(): (
    materialization: PluginMachineMaterializationV1,
) => PluginAccountAvailabilityReleaseClassificationV1 {
    const reader = useActivePluginAccountAvailabilityReader();
    return React.useMemo(() => {
        if (reader) return reader.classifyRelease;
        return (materialization): PluginAccountAvailabilityReleaseClassificationV1 => Object.freeze({
            ...projectPluginAccountAvailabilityMaterializationIdentity(materialization),
            releaseContent: 'unknown',
            validation: Object.freeze({ kind: 'rejected', reason: 'unknown' }),
        });
    }, [reader]);
}
