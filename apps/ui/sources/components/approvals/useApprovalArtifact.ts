import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { storage, useArtifact } from '@/sync/domains/state/storage';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import {
    areServerProfileIdentifiersEquivalent,
    listServerProfiles,
    resolveServerProfileForPortableIdentity,
} from '@/sync/domains/server/serverProfiles';
import { captureActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { sync } from '@/sync/sync';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

function hasCompatibleApprovalArtifact(
    artifact: DecryptedArtifact | null,
    expectedServerIdentityId: string | null,
    /** The caller addressed this Home by its portable identity, not a device-local profile id. */
    requestedByPortableIdentity: boolean,
): boolean {
    if (!artifact) return true;
    // A retained encrypted Artifact is intentionally readable only as a locked
    // structural row. Its body cannot be header-validated until the canonical
    // encryption owner opens it, so preserve it for the screen's locked-state
    // presentation instead of reclassifying it as malformed/missing.
    if (artifact.isDecrypted === false) return true;
    if (typeof artifact.body !== 'string') return false;
    const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
    if (!parsed) return false;
    if (parsed.family !== 'built_in' || parsed.request.v !== 2) return true;
    const headerServerIdentityId = typeof artifact.header?.serverIdentityId === 'string'
        ? artifact.header.serverIdentityId
        : '';
    const bodyServerIdentityId = parsed.request.executionOriginV1.serverIdentityId ?? '';
    if (headerServerIdentityId !== bodyServerIdentityId) return false;
    // Only a Home-signed external invocation records a portable identity. A present-user
    // approval admitted on this Home declares none, so a link that addressed the Home by
    // its portable identity fails closed while an exact local-profile read stays readable.
    if (!headerServerIdentityId) return !requestedByPortableIdentity;
    return !expectedServerIdentityId || headerServerIdentityId === expectedServerIdentityId;
}

/** One exact-Home approval reader for the detail screen and its originating form. */
export function useApprovalArtifact(input: Readonly<{ artifactId: string | null; serverId: string | null }>) {
    const requestedServerIdentifier = input.serverId?.trim() || null;
    const serverProfilesGeneration = useServerProfilesGeneration();
    const requestedServerTarget = React.useMemo(() => {
        if (!requestedServerIdentifier) return null;

        // Current V2 links carry the portable Home identity so another device
        // can resolve its own local profile before the encrypted body is read.
        const portable = resolveServerProfileForPortableIdentity(requestedServerIdentifier);
        if (portable.kind === 'resolved') {
            return {
                serverId: portable.profile.id,
                serverIdentityId: portable.serverIdentityId,
                portable: true,
                unresolved: false,
            } as const;
        }

        // Released V1 links carried a device-local profile id. Keep that path
        // readable, but never promote the local id into a portable identity.
        const local = listServerProfiles().find((profile) => profile.id === requestedServerIdentifier) ?? null;
        if (!local) {
            return {
                serverId: null,
                serverIdentityId: null,
                portable: false,
                unresolved: true,
            } as const;
        }
        return {
            serverId: local.id,
            serverIdentityId: local.serverIdentityId?.trim() || null,
            portable: false,
            unresolved: false,
        } as const;
    }, [requestedServerIdentifier, serverProfilesGeneration]);
    const requestedServerIdentityId = requestedServerTarget?.serverIdentityId ?? null;
    const serverId = requestedServerTarget?.serverId ?? null;
    const unresolvedServer = requestedServerTarget?.unresolved === true;
    const { artifactId } = input;
    const focused = useIsFocused();
    const resolution = useServerCredentialAccountScopeResolution(serverId);
    const activeScope = useActiveServerAccountScope();
    const local = useArtifact(artifactId ?? '');
    // Socket updates can publish the terminal header before this reader has the
    // matching decrypted body. That newer revision must restart the exact-Home
    // fetch; otherwise `fetched` remains the earlier open request forever and
    // every mounted Action continuation waits despite observing the right id.
    const headerOnlyLocalUpdatedAt = local
        && local.isDecrypted !== false
        && typeof local.body !== 'string'
            ? local.updatedAt
            : null;
    // The local store row belongs to the active Home. An unresolvable Home is not
    // the active Home merely because it has no local profile id.
    const localMatches = !unresolvedServer
        && (!serverId || (resolution.kind === 'bound' && areServerAccountScopesEqual(activeScope, resolution.scope)));
    const [loaded, setLoaded] = React.useState<Readonly<{
        artifactId: string;
        serverId: string | null;
        resolution: typeof resolution;
        artifact: DecryptedArtifact | null;
        invalidArtifact: boolean;
    }> | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(false);
    const pending = React.useRef<AbortController | null>(null);
    const fetched = loaded?.artifactId === artifactId && loaded.serverId === serverId && loaded.resolution === resolution
        ? loaded.artifact : null;
    const fetchedInvalid = loaded?.artifactId === artifactId && loaded.serverId === serverId && loaded.resolution === resolution
        ? loaded.invalidArtifact : false;
    // Socket updates are applied to the canonical artifact store while this
    // screen is open. Prefer a newer local projection so a terminal decision
    // cannot be hidden by the initial GET response.
    const requestedByPortableIdentity = requestedServerTarget?.portable === true;
    const compatibleFetched = hasCompatibleApprovalArtifact(
        fetched,
        requestedServerIdentityId,
        requestedByPortableIdentity,
    ) ? fetched : null;
    const compatibleLocal = hasCompatibleApprovalArtifact(
        local,
        requestedServerIdentityId,
        requestedByPortableIdentity,
    ) ? local : null;
    const artifact = compatibleFetched && localMatches && compatibleLocal && compatibleLocal.updatedAt > compatibleFetched.updatedAt
        ? compatibleLocal
        : compatibleFetched ?? (localMatches ? compatibleLocal : null);
    // A store row may legitimately be header-only while the encrypted body is
    // still loading. Only a completed exact-Home fetch can classify an Artifact
    // as structurally incompatible; absence and transport failure stay retryable.
    const invalidArtifact = fetchedInvalid;
    const refresh = React.useCallback(async () => {
        pending.current?.abort();
        if (!artifactId || unresolvedServer || (serverId && resolution.kind !== 'bound')) return;
        const controller = new AbortController();
        pending.current = controller;
        setLoading(true);
        setError(false);
        try {
            const full = serverId ? await (async () => {
                const context = await captureActionAccountContext(serverId, controller.signal);
                try {
                    if (resolution.kind !== 'bound' || context.accountId !== resolution.scope.accountId) return null;
                    return await context.fetchArtifact(artifactId);
                } finally { context.dispose(); }
            })() : await sync.fetchArtifactWithBody(artifactId);
            if (controller.signal.aborted) return;
            // The unscoped singleton fetch is the existing active-Home reader.
            // Preserve its established store update so conflict recovery and
            // socket/local freshness continue through the one artifact owner.
            if (!serverId && full) storage.getState().updateArtifact(full);
            const compatible = hasCompatibleApprovalArtifact(
                full,
                requestedServerIdentityId,
                requestedByPortableIdentity,
            );
            setLoaded({
                artifactId,
                serverId,
                resolution,
                artifact: compatible ? full : null,
                invalidArtifact: Boolean(full && !compatible),
            });
            setError(!full || !compatible);
        } catch {
            if (!controller.signal.aborted) setError(true);
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    }, [artifactId, requestedByPortableIdentity, requestedServerIdentityId, resolution, serverId, unresolvedServer]);
    React.useEffect(() => {
        if (focused && artifactId && (serverId || (local?.body == null && local?.isDecrypted !== false))) void refresh();
        return () => { pending.current?.abort(); };
    }, [artifactId, focused, headerOnlyLocalUpdatedAt, refresh, serverId]);
    React.useEffect(() => {
        if (!focused || !artifactId || !serverId || resolution.kind !== 'bound') return;
        // A concurrently observed Home intentionally cannot publish its Artifact
        // into the focused Home's store. Its existing content-free wake instead
        // invalidates this mounted exact-Home reader through the same fetch owner.
        return subscribeHomeAccountChange(event => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, serverId)) return;
            void refresh();
        });
    }, [artifactId, focused, refresh, resolution, serverId]);
    return {
        artifact,
        isLoading: !artifact && Boolean(artifactId) && (loading || (serverId !== null && resolution.kind === 'resolving')),
        homeUnavailable: unresolvedServer || Boolean(serverId && resolution.kind !== 'bound' && resolution.kind !== 'resolving'),
        error: error || unresolvedServer || Boolean(serverId && resolution.kind !== 'bound'),
        invalidArtifact,
        refresh,
    };
}
