import * as React from 'react';

import {
    ComposerSurfaceMountBindingV1Schema,
    type ComposerSnapshotV1,
    type ComposerSurfaceInputV1,
    type ComposerSurfaceRoleV1,
    type DaemonPluginUiComposerSurfaceCatalogEntryV1,
    type PluginContributionIdentityV1,
    type PluginProjectionV2,
    type SessionExecutionTargetV1,
} from '@happier-dev/protocol';
import type { PluginSurfaceTarget } from '@happier-dev/plugin-sdk/ui';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
    createComposerPresentationHostHandlers,
    type ComposerPresentationTransactionApplier,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { BoundPluginSurfaceMountLifetime } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import {
    PluginSurfaceHost,
    type PluginSurfaceComposerSubscriptionPublisher,
} from '@/components/plugins/surfaces/PluginSurfaceHost';
import {
    readPluginSurfaceComposerMountBinding,
    type PluginSurfaceComposerMountBinding,
} from '@/components/plugins/surfaces/pluginSurfaceMountBinding';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export type ComposerPluginSurfaceMountRequest = Readonly<{
    contribution: PluginContributionIdentityV1;
    immutableGenerationId: string;
    role: ComposerSurfaceRoleV1;
    input: ComposerSurfaceInputV1;
    instanceKey: string;
}>;

/**
 * The scope supplies its factual Composer input while the daemon catalog stays
 * the one renderer selector. Missing, stale, and duplicate catalog rows fail
 * before any physical host can observe a candidate.
 */
export function readComposerPluginSurfaceMountBinding(input: Readonly<{
    request: ComposerPluginSurfaceMountRequest;
    projectionGeneration: number;
    catalogEntries: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
}>): PluginSurfaceComposerMountBinding | null {
    const matchingEntries = input.catalogEntries.filter((entry) => (
        entry.contribution.pluginId === input.request.contribution.pluginId
        && entry.contribution.localId === input.request.contribution.localId
        && entry.immutableGenerationId === input.request.immutableGenerationId
        && entry.projectionGeneration === input.projectionGeneration
        && entry.role === input.request.role
    ));
    if (matchingEntries.length !== 1) return null;
    const catalogEntry = matchingEntries[0]!;
    const mount = ComposerSurfaceMountBindingV1Schema.safeParse({
        kind: 'composer',
        contribution: input.request.contribution,
        immutableGenerationId: input.request.immutableGenerationId,
        projectionGeneration: input.projectionGeneration,
        role: input.request.role,
        selectedRenderer: catalogEntry.selectedRenderer.identity,
        rendererChain: catalogEntry.rendererChain,
        composer: input.request.input.composer,
        instanceKey: input.request.instanceKey,
        input: input.request.input,
    });
    if (!mount.success) return null;
    return readPluginSurfaceComposerMountBinding({
        mount: mount.data,
        catalogEntries: input.catalogEntries,
    });
}

export type ComposerPluginSurfaceProps = Readonly<{
    request: ComposerPluginSurfaceMountRequest;
    /** The scope's factual parent target; it is never synthesized from its ref. */
    physicalTarget: PluginSurfaceTarget;
    serverId?: string | null;
    projectionGeneration: number;
    catalogEntries: readonly DaemonPluginUiComposerSurfaceCatalogEntryV1[];
    pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
    pluginProjectionV2: PluginProjectionV2;
    machineId: string | null;
    parentLifetime: BoundPluginSurfaceMountLifetime;
    transactionApplier: ComposerPresentationTransactionApplier;
    /**
     * The enclosing scope's qualified-destination navigation, when one is
     * mounted. A Composer surface is a mounted plugin surface like any other,
     * so it reaches destinations through the same incumbent binding seam every
     * pane/page placement uses; absent, the controller installs no
     * `openSurface` and the method refuses as unsupported rather than
     * resolving after doing nothing.
     */
    openSurface?: PluginSurfaceOpenHandler;
}>;

/**
 * One physical Composer renderer mount. Scope adapters retain document and
 * submission authority; the catalog selects the renderer and PluginSurfaceHost
 * retains the mounted-runtime lifecycle. This component merely joins those
 * incumbent owners through the one existing Composer host arm.
 */
export function ComposerPluginSurface(props: ComposerPluginSurfaceProps): React.ReactElement | null {
    const requestedMount = readComposerPluginSurfaceMountBinding({
        request: props.request,
        projectionGeneration: props.projectionGeneration,
        catalogEntries: props.catalogEntries,
    });
    // Scope renderers reconstruct request and catalog object graphs as part of
    // ordinary React renders. The bound host, however, uses this mount's
    // handler identity as its controller lifetime boundary. Retain the exact
    // prior binding only while every fact the host consumes is equivalent;
    // absent, changed, or mismatched candidates still fail closed immediately.
    const mountKey = stableJsonStringify(requestedMount === null ? null : {
        mount: requestedMount.mount,
        catalogEntry: requestedMount.catalogEntry,
    });
    const mount = React.useMemo(
        () => requestedMount,
        // `mountKey` covers the full parsed mount and selected catalog row.
        // Raw response/request object identities are intentionally not mount
        // currentness facts; including them would retire live observations on
        // every equivalent parent render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [mountKey],
    );
    const publisherRef = React.useRef<PluginSurfaceComposerSubscriptionPublisher | null>(null);
    const publishComposerSnapshot = React.useCallback((event: Readonly<{
        subscriptionId: string;
        snapshot: ComposerSnapshotV1;
    }>): void => {
        const publisher = publisherRef.current;
        if (!publisher || publisher(event) !== true) {
            throw new Error('composer_subscription_publisher_unavailable');
        }
    }, []);
    const publisherCapable = mount?.renderer.kind === 'reactNative' || mount?.renderer.kind === 'hostedWeb';
    const composerMediaExecutionTarget = React.useMemo<SessionExecutionTargetV1 | undefined>(() => (
        props.serverId && props.machineId
            ? Object.freeze({ serverId: props.serverId, machineId: props.machineId })
            : undefined
    ), [props.machineId, props.serverId]);
    const handlers = React.useMemo(() => {
        if (!mount) return null;
        return createComposerPresentationHostHandlers({
            owner: {
                identity: mount.mount.contribution,
                immutableGenerationId: mount.mount.immutableGenerationId,
                surfaceInstanceKey: mount.mount.instanceKey,
            },
            transactionApplier: props.transactionApplier,
            ...(composerMediaExecutionTarget ? { executionTarget: composerMediaExecutionTarget } : {}),
            isCurrent: props.parentLifetime.isCurrent,
            ...(publisherCapable ? { publishComposerSnapshot } : {}),
        });
    }, [
        composerMediaExecutionTarget,
        mount,
        props.parentLifetime,
        props.transactionApplier,
        publishComposerSnapshot,
        publisherCapable,
    ]);
    React.useEffect(() => () => handlers?.dispose(), [handlers]);
    const openSurface = props.openSurface;
    const binding = React.useMemo(() => handlers
        ? Object.freeze({
            mountedHostApiHandlers: handlers,
            disposeMountedHostApiHandlers: handlers.dispose,
            ...(openSurface === undefined ? {} : { openSurface }),
        })
        : undefined,
    [handlers, openSurface]);
    const setComposerSubscriptionPublisher = React.useCallback((publisher: PluginSurfaceComposerSubscriptionPublisher | undefined): void => {
        publisherRef.current = publisher ?? null;
    }, []);
    React.useEffect(() => () => {
        publisherRef.current = null;
    }, []);

    if (!mount || !props.parentLifetime.isCurrent()) return null;
    const sessionId = props.physicalTarget.kind === 'session'
        ? props.physicalTarget.sessionId
        : undefined;
    return (
        <PluginSurfaceHost
            composerMount={{
                mount,
                physicalTarget: props.physicalTarget,
                parentLifetime: props.parentLifetime,
                pluginProjectionById: props.pluginProjectionById,
                pluginProjectionV2: props.pluginProjectionV2,
                daemonProjectionReady: true,
                ...(binding === undefined ? {} : { binding }),
                ...(publisherCapable ? { setComposerSubscriptionPublisher } : {}),
            }}
            machineId={props.machineId}
            serverId={props.serverId}
            sessionId={sessionId}
            // The desktop shell runs this same web bundle, so `Platform.OS` alone
            // cannot separate a browser tab from Tauri/Electron. The canonical
            // resolver is the one owner of that distinction; classifying the
            // desktop host as `web` here would route a hosted Composer surface
            // into the sandboxed iframe instead of the native Artifact path.
            platform={resolveLocalServicePreviewPlatform()}
            channel="internal"
            projectionInteractionEnabled
        />
    );
}
