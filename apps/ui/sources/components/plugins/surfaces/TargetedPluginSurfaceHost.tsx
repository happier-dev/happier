import * as React from 'react';

import type {
    DaemonPluginUiTargetedSurfaceMountV1,
    PluginMachineExecutionOriginV1,
    PluginUiResourceBindingCapabilityV1,
} from '@happier-dev/protocol';
import {
    PluginUiInstanceKeyV1Schema,
    PluginUiLaunchInputV1Schema,
    type PluginUiChannelV1,
    type PluginUiJsonValueV1,
    type PluginUiInstanceKeyV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    cloneStrictPluginJsonValue,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import {
    derivePluginUiTargetedSurfaceMountInstanceKeyV1,
    PluginUiTargetedContributionSurfaceV1Schema,
} from '@happier-dev/protocol/plugins/ui/targetedContributions';

import type { PreparedDaemonPluginUiTargetedSurfaceMountV1 } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { BoundPluginSurfaceFacts } from './boundPluginSurfaceController';
import type { PluginUiPrivateTargetedSurfacePresentation } from './pluginUiPrivatePresentationHost';
import {
    readPluginSurfaceTargetedMountBinding,
    type PluginSurfaceTargetedMountBinding,
} from './pluginSurfaceMountBinding';

/**
 * The one thin declarative adapter input. It deliberately accepts only the
 * protocol-normalized leaf: raw symbolic references have no contributor
 * generation and therefore cannot enter a physical mount.
 */
export type TargetedPluginSurfaceMountRequest = Readonly<{
    mount: PluginSurfaceTargetedMountBinding<PreparedDaemonPluginUiTargetedSurfaceMountV1>;
    /**
     * The one deep-frozen bounded snapshot the child renderer and the
     * host-owned Resource context both read. It never aliases the author's
     * source value, and freezing is what keeps either consumer from reaching
     * the other's view — a second clone would only duplicate that guarantee.
     */
    input: PluginUiJsonValueV1;
    /**
     * Protocol's already-namespaced mount identity. Declarative leaves carry
     * it directly; the React presentation bridge derives it through Protocol
     * after its exact A→B rematch.
     */
    instanceKey: PluginUiInstanceKeyV1;
    /** Renderer-owned declared fallback, retained only for the physical B mount. */
    fallback?: React.ReactNode;
}>;

/**
 * Facts the existing physical host needs to mount a child without borrowing
 * any parent authority. This is a projection of Main's one correlated mount,
 * not a second renderer or host-API decision.
 */
export type TargetedPluginSurfacePhysicalMountFacts = Readonly<{
    pluginId: string;
    contributionId: string;
    surfaceId: string;
    mountInstanceKey: PluginUiInstanceKeyV1;
    launchInput: PluginUiJsonValueV1;
    executionOrigin: PluginMachineExecutionOriginV1;
    resourceCapability: PluginUiResourceBindingCapabilityV1;
    targetedContributions: DaemonPluginUiTargetedSurfaceMountV1['contributorTargetedContributions'];
}>;

const EMPTY_TARGETED_SURFACE_RESOURCE_SCOPE: readonly PluginUiSurfaceContextV1['resourceScope'][number][] = Object.freeze([]);

/**
 * Protocol normalizes and stamps this leaf before the daemon projects it, and
 * the response reaches the UI as decoded JSON. Read its declared fields
 * directly and let the schemas below decide what is admissible; the launch
 * input alone still gets the one bounded strict-JSON snapshot, because that is
 * the value both the child renderer and the host Resource context retain.
 */
function readNormalizedTargetedSurfaceLeaf(
    value: unknown,
): Readonly<Record<string, unknown>> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    return record.kind === 'targetedSurface' ? record : null;
}

/**
 * The admitted snapshot is wrapped rather than returned bare because `null` is
 * itself a valid launch input: an unwrapped `null` would make a legitimately
 * empty input indistinguishable from a refusal.
 */
function readTargetedSurfaceInputSnapshot(
    value: unknown,
): Readonly<{ input: PluginUiJsonValueV1 }> | null {
    try {
        const input = cloneStrictPluginJsonValue(value, 'targetedSurface.input') as PluginUiJsonValueV1;
        return PluginUiLaunchInputV1Schema.safeParse(input).success ? Object.freeze({ input }) : null;
    } catch {
        // The shared Protocol owner rejects malformed values before either
        // child consumer receives a snapshot.
        return null;
    }
}

/**
 * Main selected the exact B mount and Protocol owns its role normalizer. The
 * physical host applies that retained parser and uses AJV only to verify the
 * parser output still matches its emitted-schema projection.
 */
function normalizeTargetedSurfaceInput(
    mount: PreparedDaemonPluginUiTargetedSurfaceMountV1,
    input: PluginUiJsonValueV1,
): PluginUiJsonValueV1 | undefined {
    try {
        const normalized = mount.inputNormalizer.safeParse(input);
        if (!normalized.success || mount.inputValidation.validate(normalized.data) !== true) return undefined;
        return cloneStrictPluginJsonValue(
            normalized.data,
            'targetedSurface.normalizedInput',
        ) as PluginUiJsonValueV1;
    } catch {
        // A malformed response-local schema is unavailable, never a reason to
        // relax B admission or disclose its renderer/Resource context.
        return undefined;
    }
}

/**
 * Rematch one normalized leaf against the parent response-local A→B inventory.
 * This owns no renderer selection, input validation, key namespacing, or
 * currentness policy: those facts are respectively Main/Protocol producers and
 * the existing physical mount/controller owners.
 */
export function readTargetedPluginSurfaceMountRequest(input: Readonly<{
    node: unknown;
    mounts: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[];
    /** Exact mounted target requested from the cold Registry projection. */
    target: DaemonPluginUiTargetedSurfaceMountV1['target'];
}>): TargetedPluginSurfaceMountRequest | null {
    const node = readNormalizedTargetedSurfaceLeaf(input.node);
    if (!node) return null;
    const surface = PluginUiTargetedContributionSurfaceV1Schema.safeParse(node.surface);
    const launchInput = readTargetedSurfaceInputSnapshot(node.input);
    const instanceKey = PluginUiInstanceKeyV1Schema.safeParse(node.instanceKey);
    if (!surface.success || !launchInput || !instanceKey.success) return null;

    const mount = readPluginSurfaceTargetedMountBinding({
        mounts: input.mounts,
        target: input.target,
        surface: surface.data,
    });
    const normalizedInput = mount && normalizeTargetedSurfaceInput(mount.mount, launchInput.input);
    if (!mount || normalizedInput === undefined) return null;
    return Object.freeze({
        mount,
        input: normalizedInput,
        instanceKey: instanceKey.data,
    });
}

/**
 * React reaches the same A→B rematch as a normalized declarative leaf. The
 * Protocol owns the shared namespaced instance identity, so this bridge never
 * treats a caller's raw key as a physical mount key.
 */
export function readTargetedPluginSurfaceReactMountRequest(input: Readonly<{
    presentation: PluginUiPrivateTargetedSurfacePresentation;
    mounts: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[];
    /** Exact mounted target requested from the cold Registry projection. */
    target: DaemonPluginUiTargetedSurfaceMountV1['target'];
}>): TargetedPluginSurfaceMountRequest | null {
    const presentation = input.presentation;
    const surface = PluginUiTargetedContributionSurfaceV1Schema.safeParse(presentation.surface);
    // An omitted launch input is not an empty one: the snapshot owner refuses
    // `undefined` while admitting an explicit `null`, so no presence probe is
    // needed to keep those two apart.
    const launchInput = readTargetedSurfaceInputSnapshot(presentation.input);
    const rawInstanceKey = presentation.instanceKey === undefined
        ? undefined
        : PluginUiInstanceKeyV1Schema.safeParse(presentation.instanceKey);
    if (!surface.success || !launchInput || (rawInstanceKey !== undefined && !rawInstanceKey.success)) {
        return null;
    }
    const mount = readPluginSurfaceTargetedMountBinding({
        mounts: input.mounts,
        target: input.target,
        surface: surface.data,
    });
    const normalizedInput = mount && normalizeTargetedSurfaceInput(mount.mount, launchInput.input);
    if (!mount || normalizedInput === undefined) return null;
    return Object.freeze({
        mount,
        input: normalizedInput,
        instanceKey: derivePluginUiTargetedSurfaceMountInstanceKeyV1({
            targetPluginId: mount.mount.target.pluginId,
            surface: surface.data,
            ...(rawInstanceKey?.success ? { rawInstanceKey: rawInstanceKey.data } : {}),
        }),
    });
}

/**
 * Derive child-only physical facts after the exact A→B rematch. `surfaceId`
 * is local to the child's already-namespaced mount identity; it is never a
 * destination id, navigation key, or persistence identity.
 */
export function projectTargetedPluginSurfacePhysicalMountFacts(
    request: TargetedPluginSurfaceMountRequest,
): TargetedPluginSurfacePhysicalMountFacts {
    const mount = request.mount.mount;
    return Object.freeze({
        pluginId: mount.contributor.pluginId,
        contributionId: mount.contributor.contributionId,
        surfaceId: `targeted:${request.instanceKey}`,
        mountInstanceKey: request.instanceKey,
        launchInput: request.input,
        executionOrigin: mount.executionOrigin,
        resourceCapability: mount.resourceCapability,
        targetedContributions: mount.contributorTargetedContributions,
    });
}

/**
 * The target adapter gives the incumbent bound-controller B's exact mount
 * facts. Main's generic Resource owner consumes the host-stamped surface
 * context below; it is intentionally absent from every parent/destination arm.
 */
export function createTargetedPluginSurfaceBoundFacts(input: Readonly<{
    request: TargetedPluginSurfaceMountRequest;
    serverId?: string | null;
    sessionId?: string | null;
    /**
     * The inherited physical target's private lifecycle identity. It is never
     * published to B, but the incumbent controller uses it to retire requests
     * if that parent target is replaced under one target mount.
     */
    targetAuthorityKey?: string | null;
    platform: PluginUiSurfaceContextV1['platform'];
    channel: PluginUiChannelV1;
    projectionGeneration?: number | string | null;
    pluginProjectionById?: Readonly<Record<string, PluginProjectionEntry>> | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    parentLifetime?: BoundPluginSurfaceFacts['parentLifetime'];
    interactionEnabled: boolean;
    daemonInteractionEnabled: boolean;
}>): BoundPluginSurfaceFacts {
    const physical = projectTargetedPluginSurfacePhysicalMountFacts(input.request);
    return Object.freeze({
        pluginId: physical.pluginId,
        contributionId: physical.contributionId,
        surfaceId: physical.surfaceId,
        sessionId: input.sessionId,
        targetAuthorityKey: input.targetAuthorityKey,
        // Embedded mounts have no destination placement. The existing request
        // envelope keeps its coarse `unknown` value rather than inventing one.
        placement: 'unknown',
        platform: input.platform,
        channel: input.channel,
        resourceScope: EMPTY_TARGETED_SURFACE_RESOURCE_SCOPE,
        machineId: physical.executionOrigin.materializationRef.machineId,
        serverId: input.serverId,
        projectionGeneration: input.projectionGeneration,
        executionOrigin: physical.executionOrigin,
        resourceCapability: physical.resourceCapability,
        resourceContext: Object.freeze({
            kind: 'surface' as const,
            mountInstanceKey: physical.mountInstanceKey,
            launchInput: physical.launchInput,
        }),
        pluginProjectionById: input.pluginProjectionById,
        pluginUiProjection: input.pluginUiProjection,
        targetedContributions: physical.targetedContributions,
        accountLifetime: input.accountLifetime,
        parentLifetime: input.parentLifetime,
        mountInstanceKey: physical.mountInstanceKey,
        interactionEnabled: input.interactionEnabled,
        daemonInteractionEnabled: input.daemonInteractionEnabled,
    });
}

/**
 * The only target-local adapter. It rematches a normalized declarative leaf
 * against the response-local A→B inventory and then delegates the unchanged
 * request to the incumbent physical `PluginSurfaceHost` supplied by its caller.
 * It deliberately owns no renderer, controller, availability, currentness,
 * Artifact, Resource, or fallback decision.
 */
export function TargetedPluginSurfaceHost(props: Readonly<{
    node?: unknown;
    presentation?: PluginUiPrivateTargetedSurfacePresentation;
    /** Declarative renderer-owned fallback, passed without the host interpreting it. */
    fallback?: React.ReactNode;
    mounts: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[];
    /** Exact parent target whose one semantic cold projection supplied `mounts`. */
    target: DaemonPluginUiTargetedSurfaceMountV1['target'];
    renderMountedSurface: (request: TargetedPluginSurfaceMountRequest) => React.ReactNode;
}>): React.ReactElement | null {
    const request = props.presentation
        ? readTargetedPluginSurfaceReactMountRequest({
            presentation: props.presentation,
            mounts: props.mounts,
            target: props.target,
        })
        : readTargetedPluginSurfaceMountRequest({
            node: props.node,
            mounts: props.mounts,
            target: props.target,
        });
    // An own presentation fallback is renderer-owned, including an explicit
    // `null`. Only an omitted property delegates to the caller fallback, so
    // presence — not value — is the fact this reads.
    const presentation = props.presentation;
    const fallback = presentation !== undefined
        && Object.prototype.hasOwnProperty.call(presentation, 'fallback')
        ? presentation.fallback
        : props.fallback;
    if (!request) return <>{fallback}</>;
    const mountedRequest = fallback === undefined
        ? request
        : Object.freeze({ ...request, fallback });
    return <>{props.renderMountedSurface(mountedRequest)}</>;
}
