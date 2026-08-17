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
import type { BoundPluginSurfaceFacts } from './boundPluginSurfaceController';
import type { PluginUiPrivateTargetedSurfacePresentation } from './pluginUiPrivatePresentationHost';
import {
    readPluginSurfaceTargetedMountBinding,
    type PluginSurfaceTargetedMountBinding,
} from './pluginSurfaceMountBinding';

type NormalizedTargetedSurfaceLeaf = Readonly<{
    kind: 'targetedSurface';
    surface: unknown;
    input: unknown;
    instanceKey: unknown;
}>;

/**
 * The one thin declarative adapter input. It deliberately accepts only the
 * protocol-normalized leaf: raw symbolic references have no contributor
 * generation and therefore cannot enter a physical mount.
 */
export type TargetedPluginSurfaceMountRequest = Readonly<{
    mount: PluginSurfaceTargetedMountBinding<PreparedDaemonPluginUiTargetedSurfaceMountV1>;
    /**
     * Deep-frozen bounded snapshot supplied to the selected child renderer.
     * It must not alias the private Resource envelope below.
     */
    input: PluginUiJsonValueV1;
    /**
     * Deep-frozen bounded snapshot retained only for the host-owned Resource
     * context. Keeping it separate prevents a public renderer from mutating
     * the context used by a later Resource request.
     */
    resourceInput: PluginUiJsonValueV1;
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
    resourceLaunchInput: PluginUiJsonValueV1;
    executionOrigin: PluginMachineExecutionOriginV1;
    resourceCapability: PluginUiResourceBindingCapabilityV1;
    targetedContributions: DaemonPluginUiTargetedSurfaceMountV1['contributorTargetedContributions'];
}>;

const EMPTY_TARGETED_SURFACE_RESOURCE_SCOPE: readonly PluginUiSurfaceContextV1['resourceScope'][number][] = Object.freeze([]);

function readNormalizedTargetedSurfaceLeaf(value: unknown): NormalizedTargetedSurfaceLeaf | null {
    let cloned: unknown;
    try {
        cloned = cloneStrictPluginJsonValue(value, 'targetedSurface.node');
    } catch {
        return null;
    }
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) return null;
    const record = cloned as Readonly<Record<string, unknown>>;
    return record.kind === 'targetedSurface'
        ? {
            kind: 'targetedSurface',
            surface: record.surface,
            input: record.input,
            instanceKey: record.instanceKey,
        }
        : null;
}

type TargetedSurfaceInputSnapshots = Readonly<{
    input: PluginUiJsonValueV1;
    resourceInput: PluginUiJsonValueV1;
}>;

/**
 * Presentation fallback can be a React node, so this boundary cannot clone
 * the complete presentation object. Read only its data properties before the
 * canonical JSON snapshot owner sees launch input; accessors never run.
 */
function readPresentationDataProperty(
    presentation: unknown,
    key: string,
): Readonly<{ present: boolean; value?: unknown }> | null {
    if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) return null;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(presentation, key);
        if (descriptor === undefined) return Object.freeze({ present: false });
        if (!('value' in descriptor) || descriptor.enumerable !== true) return null;
        return Object.freeze({ present: true, value: descriptor.value });
    } catch {
        return null;
    }
}

function readTargetedSurfaceInputSnapshots(value: unknown): TargetedSurfaceInputSnapshots | null {
    try {
        const input = cloneStrictPluginJsonValue(value, 'targetedSurface.input') as PluginUiJsonValueV1;
        if (!PluginUiLaunchInputV1Schema.safeParse(input).success) return null;
        return Object.freeze({
            input,
            // Clone the already-admitted snapshot so an untrusted input is
            // reflected exactly once while the renderer and Resource owner
            // still receive non-aliasing immutable values.
            resourceInput: cloneStrictPluginJsonValue(
                input,
                'targetedSurface.resourceInput',
            ) as PluginUiJsonValueV1,
        });
    } catch {
        // The shared Protocol owner rejects hostile values before either child
        // consumer receives a snapshot.
        return null;
    }
}

/**
 * Main selected the exact B mount and owns its role schema. The physical host
 * merely admits the already-bounded launch value against that correlated fact;
 * it neither reconstructs the role nor interprets its input.
 */
function isTargetedSurfaceInputAdmitted(
    mount: PreparedDaemonPluginUiTargetedSurfaceMountV1,
    input: PluginUiJsonValueV1,
): boolean {
    try {
        return mount.inputValidation.validate(input) === true;
    } catch {
        // A malformed response-local schema is unavailable, never a reason to
        // relax B admission or disclose its renderer/Resource context.
        return false;
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
    const launchInput = readTargetedSurfaceInputSnapshots(node.input);
    const instanceKey = PluginUiInstanceKeyV1Schema.safeParse(node.instanceKey);
    if (!surface.success || !launchInput || !instanceKey.success) return null;

    const mount = readPluginSurfaceTargetedMountBinding({
        mounts: input.mounts,
        target: input.target,
        surface: surface.data,
    });
    if (!mount || !isTargetedSurfaceInputAdmitted(mount.mount, launchInput.input)) return null;
    return Object.freeze({
        mount,
        input: launchInput.input,
        resourceInput: launchInput.resourceInput,
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
    const surfaceValue = readPresentationDataProperty(input.presentation, 'surface');
    const launchInputValue = readPresentationDataProperty(input.presentation, 'input');
    const rawInstanceKeyValue = readPresentationDataProperty(input.presentation, 'instanceKey');
    if (
        !surfaceValue
        || !surfaceValue.present
        || !launchInputValue
        || !launchInputValue.present
        || rawInstanceKeyValue === null
    ) return null;
    const surface = PluginUiTargetedContributionSurfaceV1Schema.safeParse(surfaceValue.value);
    const launchInput = readTargetedSurfaceInputSnapshots(launchInputValue.value);
    const rawInstanceKey = rawInstanceKeyValue.present === false
        ? undefined
        : PluginUiInstanceKeyV1Schema.safeParse(rawInstanceKeyValue.value);
    if (!surface.success || !launchInput || (rawInstanceKey !== undefined && !rawInstanceKey.success)) {
        return null;
    }
    const mount = readPluginSurfaceTargetedMountBinding({
        mounts: input.mounts,
        target: input.target,
        surface: surface.data,
    });
    if (!mount || !isTargetedSurfaceInputAdmitted(mount.mount, launchInput.input)) return null;
    return Object.freeze({
        mount,
        input: launchInput.input,
        resourceInput: launchInput.resourceInput,
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
        resourceLaunchInput: request.resourceInput,
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
            launchInput: physical.resourceLaunchInput,
        }),
        pluginProjectionById: input.pluginProjectionById,
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
    const presentationFallback = props.presentation === undefined
        ? null
        : readPresentationDataProperty(props.presentation, 'fallback');
    // An own presentation fallback is renderer-owned, including an explicit
    // `null`. Only an omitted property delegates to the caller fallback.
    const fallback = presentationFallback?.present === true
        ? presentationFallback.value as React.ReactNode
        : props.fallback;
    if (!request) return <>{fallback}</>;
    const mountedRequest = fallback === undefined
        ? request
        : Object.freeze({ ...request, fallback });
    return <>{props.renderMountedSurface(mountedRequest)}</>;
}
