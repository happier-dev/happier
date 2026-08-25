import * as React from 'react';

import type {
    ActionExecutorContext,
    ComposerRefV1,
    ComposerTransactionV1,
    PluginMachineExecutionOriginV1,
    PluginContributionIdentityV1,
    PluginResourceContextV1,
    PluginUiResourceBindingCapabilityV1,
} from '@happier-dev/protocol';
import {
    PluginUiApplyComposerRequestV1Schema,
    PluginUiHostMethodV1Schema,
    PluginUiJsonValueV1Schema,
    PluginUiPublishCurrentUiContextRequestV1Schema,
    normalizePluginUiSemanticCommandV1,
    type PluginUiChannelV1,
    type PluginUiApplyComposerRequestV1,
    type PluginUiHostMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiInstanceKeyV1,
    type PluginUiExecuteActionRequestV1,
    type PluginUiJsonValueV1,
    type PluginUiMountedActionReferenceV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiSurfaceContextV1,
    type PluginUiTargetedContributionsV1,
    type CurrentUiContextSnapshotV1,
} from '@happier-dev/protocol/plugins/ui';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import {
    useEndpointStatus,
    useMachineCliDetectionTarget,
} from '@/sync/domains/state/storage';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import {
    createPluginSurfaceHostApiError,
    createPluginSurfaceHostApi,
    type PluginSurfaceHostApiHandlers,
    type PluginSurfaceHostApiV1,
} from './createPluginSurfaceHostApi';
import type { CurrentUiContextMountedEnrichment } from '@/components/appShell/currentUiContext/currentUiContextModel';
import {
    createPluginSurfaceActionHostApi,
    type PluginSurfaceActionMountedBinding,
    type PluginSurfaceContributedActionDescriptorResolver,
    type PluginSurfaceContributedActionTransport,
    type PluginSurfaceHostActionExecute,
} from './pluginSurfaceActionDispatch';
import {
    createPluginSurfaceOpenSurfaceHandler,
    type PluginSurfaceOpenHandler,
} from './openPluginSurface';
import type { PluginSurfaceResourceReadTransport } from './pluginSurfaceResourceRead';
import type { PluginSurfaceResourceWatchTransport } from './pluginSurfaceResourceWatch';
import type { PluginSurfaceOpenableContentBinding } from './pluginSurfaceOpenableContent';
import {
    createPluginActionInputSelectionHostApiHandler,
    serializePluginActionInputSelectionFacts,
} from './pluginActionInputSelectionHostApi';

/**
 * The bound surface controller (§3.1).
 *
 * One owner holds the host-API semantics of a mounted plugin surface. Before it
 * existed, every placement re-derived the same behavior for itself: the app-scope
 * right sidebar and the browser panel each built a `PluginUiSurfaceContextV1`
 * literal, each mapped `machineId` + projection generation onto the contributed-
 * action and resource bindings, and each resolved its own default host-ActionSpec
 * executor (one of them a private re-implementation of the canonical lazy front
 * door) — while every other placement supplied nothing at all and therefore
 * mounted a handler-less API that could serve no method but `context`.
 *
 * A placement now supplies only the facts it owns. The controller decides what is
 * installable from them, and the installed set stays factual (UI-D02): a mount
 * that cannot address a machine and a projected generation installs no
 * `readResource`, and a mount whose placement owns no destination catalog installs
 * no `openSurface`, so both fail with a typed `unsupported_method` rather than
 * resolving after doing nothing.
 *
 * It is not a registry and it holds no state beyond its own disposal: `isCurrent`
 * is the mount lifetime the placement already had, made observable to the action
 * and resource handlers so an in-flight request cannot settle into a retired
 * surface.
 */

/**
 * "Can this mount reach its addressed daemon?" — one rule, so two placements
 * cannot answer it differently. `endpointOnline` and `hasAddressedMachine` let
 * the mount distinguish a local-only facade from an offline exact target;
 * `daemonReachable` is their endpoint-plus-addressed-machine transport fact.
 * `enabled` additionally requires projection admission for daemon-owned
 * Action/Resource semantics. `daemonStateVersion` rides along because the same
 * observation is the authority generation a declarative surface writes against.
 */
export function usePluginSurfaceDaemonInteraction(input: Readonly<{
    machineId?: string | null;
    projectionInteractionEnabled?: boolean;
}>): Readonly<{
    endpointOnline: boolean;
    hasAddressedMachine: boolean;
    daemonReachable: boolean;
    enabled: boolean;
    daemonStateVersion: number;
}> {
    const endpointStatus = useEndpointStatus();
    const machineId = typeof input.machineId === 'string' && input.machineId.trim().length > 0
        ? input.machineId
        : null;
    const machineTarget = useMachineCliDetectionTarget(machineId);
    const endpointOnline = endpointStatus === 'online';
    const hasAddressedMachine = machineId !== null;
    const daemonReachable = hasAddressedMachine
            && endpointOnline
            && machineTarget.isOnline;
    return {
        endpointOnline,
        hasAddressedMachine,
        daemonReachable,
        enabled: daemonReachable && input.projectionInteractionEnabled !== false,
        daemonStateVersion: machineTarget.daemonStateVersion,
    };
}

/** The identity and environment facts a placement owns about its mount. */
export type BoundPluginSurfaceFacts = Readonly<{
    pluginId: string;
    /** The contribution declaring the surface (its `descriptorId`), not its renderer. */
    contributionId: string;
    surfaceId: string;
    /**
     * The session this mount is scoped to, when its placement owns one. It is part
     * of the surface's identity — the hosted-web bridge matches an incoming envelope
     * against it — so a placement that knows its session must supply it here rather
     * than re-deriving a second identity at its transport.
     */
    sessionId?: string | null;
    /**
     * The exact public target's private lifecycle identity. The controller does
     * not publish this host-private key; it uses it only to retire handlers when
     * a placement moves to a different target under the same mount instance.
     */
    targetAuthorityKey?: string | null;
    placement: PluginUiSurfaceContextV1['placement'];
    platform: PluginUiSurfaceContextV1['platform'];
    channel?: PluginUiChannelV1;
    resourceScope?: readonly PluginUiSurfaceContextV1['resourceScope'][number][];
    /** Daemon addressing. Absent → the daemon-served methods are not installed. */
    machineId?: string | null;
    serverId?: string | null;
    /** The projection generation this mount is bound to. */
    projectionGeneration?: number | string | null;
    /**
     * The one CurrentUiContextProvider reader, borrowed at action-dispatch
     * time. A mounted surface never snapshots, stores, or resolves context on
     * its own.
     */
    readCurrentUiContext?: () => CurrentUiContextSnapshotV1 | null | undefined;
    /**
     * Exact producer-stamped materialization for this mounted contribution.
     * The controller carries it only to the daemon action ingress; it never
     * exposes it to renderer input or lets a placement reconstruct it.
     */
    executionOrigin?: PluginMachineExecutionOriginV1 | null;
    /**
     * The selected surface member's canonical Resource admission fact. It is
     * deliberately only a method-shape capability: exact resource identity,
     * static-versus-dynamic membership, and cross-plugin refusal remain with
     * the daemon Resource owner.
     */
    resourceCapability?: PluginUiResourceBindingCapabilityV1;
    /**
     * The exact already-validated context the host owns for this Resource
     * consumer. Targeted children use the closed Protocol surface arm; ordinary
     * destination/global/session mounts intentionally leave it absent.
     */
    resourceContext?: PluginResourceContextV1;
    /** Exact normalized daemon projection for the selected target/generation. */
    pluginProjectionById?: Readonly<Record<string, PluginProjectionEntry>> | null;
    /**
     * Exact normalized projection used only by the Action presentation resolver.
     * It carries no target selection, execution, or mount currentness authority.
     */
    pluginUiProjection?: PluginUiProjectionModel | null;
    /**
     * Exact current raw V2 Action lookup from the mounted UI projection. It is
     * deliberately opaque here: this controller owns no Action catalog or
     * target normalization.
     */
    resolveContributedAction?: PluginSurfaceContributedActionDescriptorResolver;
    /**
     * The one cold-admitted targeted-contribution snapshot for this mounted
     * target. It is a target fact, not an Action catalog: selection stays
     * unavailable when this surface has no exact snapshot.
     */
    targetedContributions?: PluginUiTargetedContributionsV1 | null;
    /**
     * The incumbent active Account lifetime captured by the mount. The
     * controller consumes its currentness but never creates or retires it.
     */
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    /**
     * An outer physical mount can lend its existing retirement observation to
     * an embedded child. This carries no Account scope, renderer selection, or
     * new lifecycle owner: the child only composes its own controller lifetime
     * with the already-current parent mount.
     */
    parentLifetime?: BoundPluginSurfaceMountLifetime | null;
    /**
     * The resolver-stamped ephemeral instance identity. It is intentionally
     * separate from the artifact-qualified durable crash-disable key.
     */
    mountInstanceKey?: PluginUiInstanceKeyV1;
    /**
     * Whether locally served surface semantics are presently admitted. An
     * active Account can still expose placement-local navigation when this is
     * false; a missing Account is the stronger fully inert, fail-closed case.
     */
    interactionEnabled: boolean;
    /**
     * Whether this mount can currently use its exact daemon binding. This is
     * intentionally narrower than local facade admission: a missing machine
     * removes contributed Action/Resource methods without suppressing context,
     * feedback, or host-Action presentation from an otherwise current mount.
     */
    daemonInteractionEnabled: boolean;
    /**
     * The hook-owned live form of daemon availability. It narrows the already
     * bound daemon handlers during connectivity/projection refresh without
     * becoming a controller identity or lifecycle owner.
     */
    isDaemonInteractionEnabled?: () => boolean;
}>;

/** Host-private currentness observation supplied by an incumbent physical mount. */
export type BoundPluginSurfaceMountLifetime = Readonly<{
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;

/**
 * A physical mount may derive one exact semantic handler bundle only after the
 * controller has established its single currentness predicate. The controller
 * still owns Host API assembly, installed-method negotiation, and retirement;
 * this factory never creates another facade, lifecycle, or transport.
 */
export type BoundPluginSurfaceMountedHostApiHandlersFactory = (input: Readonly<{
    isCurrent: () => boolean;
}>) => Readonly<{
    handlers: PluginSurfaceHostApiHandlers;
    /**
     * Exact controller-bound publication data. The controller parses and
     * qualifies the public request before it reaches this private capability.
     */
    currentUiContext?: BoundPluginSurfaceCurrentUiContextPublication;
    /**
     * Runs only from the controller hook's committed-effect lifecycle. A
     * factory executes while React renders, so external registration here
     * would leak an abandoned render into a host-owned store.
     */
    activate?: () => void;
    /**
     * Host-private current-UI focus fact for this exact mounted bundle. It is
     * data pushed after commit, never an author callback or store predicate.
     */
    setCurrentUiContextEligibility?: (eligible: boolean) => void;
    dispose?: () => void;
}>;

/**
 * The provider-local mount record capability. It carries no callback or
 * executable dispatcher: semantic commands remain opaque to the snapshot.
 */
export type BoundPluginSurfaceCurrentUiContextPublication = Readonly<{
    publish: (enrichment: CurrentUiContextMountedEnrichment | null) => boolean;
    clear: () => void;
    restore: () => boolean;
    dispose: () => void;
}>;

/**
 * The extras a placement — and only a placement — can supply. Everything here is
 * a fact about the host around the surface, never a pre-composed API.
 */
export type BoundPluginSurfaceBinding = Readonly<{
    /**
     * The host-ActionSpec front door. Defaults to the canonical lazily-resolved
     * `ActionExecutor.execute`, so ActionsSettings enablement and approval routing
     * always apply.
     */
    executeHostAction?: PluginSurfaceHostActionExecute;
    /** EU-5a: the placement's own destination selector. Absent → uninstalled. */
    openSurface?: PluginSurfaceOpenHandler;
    /** Transport overrides for the daemon boundary (tests). */
    executeContributedAction?: PluginSurfaceContributedActionTransport;
    readResource?: PluginSurfaceResourceReadTransport;
    watchResource?: Partial<PluginSurfaceResourceWatchTransport>;
    /** The selected workspace-file viewer's exact opaque host binding. */
    openableContent?: PluginSurfaceOpenableContentBinding;
    /** Exact semantic handlers supplied by this physical mount's canonical owner. */
    mountedHostApiHandlers?: PluginSurfaceHostApiHandlers;
    /** Retires the mounted semantic handlers with this controller's lifecycle. */
    disposeMountedHostApiHandlers?: () => void;
    /**
     * Derives mounted semantic handlers from this controller's one lifecycle.
     * Opaque file viewers deliberately never invoke it because their selected
     * content binding is the complete factual host-method ceiling.
     */
    createMountedHostApiHandlers?: BoundPluginSurfaceMountedHostApiHandlersFactory;
}>;

export type BoundPluginSurfaceController = Readonly<{
    /** The one exact surface context for this mount. */
    surfaceContext: PluginUiSurfaceContextV1;
    hostApi: PluginSurfaceHostApiV1;
    /**
     * The host API method snapshot consumed by existing host-local controls.
     * Renderer admission uses `admissionMethods` so temporary daemon
     * availability changes cannot de-admit an established same-target surface.
     */
    installedMethods: readonly PluginUiHostMethodV1[];
    /**
     * The canonical host API's structural admission set. It excludes transient
     * availability narrowing but still clears when this mount retires.
     */
    admissionMethods: readonly PluginUiHostMethodV1[];
    /**
     * True when the canonical facade can be delivered, including a factual
     * context-only method set. Renderer offline presentation remains a separate
     * transport/admission decision at the mounted host.
     */
    interactive: boolean;
    /**
     * EU-4b: observe the live resource invalidations this mount's
     * `watchResource` handler produces. The transport publishes here; the
     * surface's own transport adapter republishes into the ONE subscription
     * registry it already owns, so no second registry exists.
     */
    subscribeResourceInvalidations: (
        listener: (event: PluginUiResourceSubscriptionEventV1) => void,
    ) => () => void;
    /**
     * Host-side declarative renderers use the same mounted facade as every
     * transported author request. This is deliberately an adapter over
     * `hostApi.handleRequest`, not another action dispatcher or currentness
     * owner.
     */
    dispatchAction: (
        action: PluginUiMountedActionReferenceV1,
        input?: PluginUiJsonValueV1,
    ) => Promise<PluginUiJsonValueV1>;
    /**
     * Declarative Composer effects use the same mounted Host API facade as
     * SDK clients. The caller supplies only an already-host-stamped Composer
     * ref and canonical transaction; this adapter creates no Composer owner.
     */
    applyComposer: (
        ref: ComposerRefV1,
        transaction: ComposerTransactionV1,
    ) => Promise<PluginUiJsonValueV1>;
    /**
     * Declarative collection commands use the same mounted facade for a
     * qualified surface destination. The Protocol handler remains the one
     * parser/currentness owner; this only constructs its canonical envelope.
     */
    openSurface: (
        destination: PluginContributionIdentityV1,
    ) => Promise<PluginUiJsonValueV1>;
    /**
     * Host-internal mount predicate for an adapter that must avoid delivering a
     * late response. It is not exposed through the public plugin Host API.
     */
    isCurrent: () => boolean;
    /**
     * Lets an embedded physical child observe this controller's existing
     * lifetime. It is intentionally host-private and emits only retirement;
     * the parent remains the sole lifecycle owner.
     */
    onRetire: BoundPluginSurfaceMountLifetime['onRetire'];
    /**
     * Synchronously fences this exact mount without invoking teardown that can
     * schedule React state. The owner performs full disposal in a safe phase.
     */
    retire: () => void;
    /** Idempotent. Retires what the mount put in front of the user and fences in-flight work. */
    dispose: () => void;
    /**
     * Host-private post-commit activation for a mounted semantic bundle. It is
     * absent unless the exact controller factory provided one.
     */
    activateMountedHostApiHandlers?: () => void;
    /**
     * Host-private current-UI focus update for this exact controller. A
     * retired controller ignores it; no plugin payload crosses this seam.
     */
    setCurrentUiContextEligibility?: (eligible: boolean) => void;
    /** Hides only this exact current mount's enrichment; retirement disposes it. */
    clearCurrentUiContext: () => void;
}>;

const EMPTY_RESOURCE_SCOPE: readonly PluginUiSurfaceContextV1['resourceScope'][number][] = Object.freeze([]);
const NOOP_MOUNT_RETIREMENT = Object.freeze({ dispose(): void {} });

function isDaemonOwnedPluginSurfaceMethod(method: PluginUiHostMethodV1): boolean {
    return method === 'readResource'
        || method === 'watchResource'
        || method === 'statOpenableContent'
        || method === 'readOpenableContent'
        || method === 'selectActionInput';
}

export function resolveBoundPluginSurfaceContext(
    facts: BoundPluginSurfaceFacts,
): PluginUiSurfaceContextV1 {
    return {
        pluginId: facts.pluginId,
        contributionId: facts.contributionId,
        surfaceId: facts.surfaceId,
        ...(typeof facts.sessionId === 'string' && facts.sessionId.trim().length > 0
            ? { sessionId: facts.sessionId }
            : {}),
        placement: facts.placement,
        platform: facts.platform,
        channel: facts.channel ?? 'internal',
        resourceScope: [...(facts.resourceScope ?? EMPTY_RESOURCE_SCOPE)],
        diagnostics: [],
    };
}

/**
 * The daemon binding both the contributed-action branch and the resource snapshot
 * authority ride. One derivation: a mount that cannot name a machine and the
 * generation it is bound to cannot serve either, so neither is installed.
 *
 * Caller provenance is deliberately not part of this transport binding. A local
 * host Action remains locally executable while the daemon is unavailable, but a
 * mounted plugin caller must still carry the exact producer-owned materialization
 * that made the surface current.
 */
function resolveDaemonBinding(facts: BoundPluginSurfaceFacts): Readonly<{
    machineId: string;
    serverId?: string | null;
    expectedGeneration: string;
}> | null {
    const machineId = typeof facts.machineId === 'string' && facts.machineId.trim().length > 0
        ? facts.machineId
        : null;
    const generation = facts.projectionGeneration;
    if (!machineId || generation === null || generation === undefined) {
        return null;
    }
    return {
        machineId,
        serverId: facts.serverId ?? null,
        expectedGeneration: String(generation),
    };
}

/**
 * One exact mounted-caller gate, independent from daemon reachability. This is
 * provenance for an actual plugin surface, not transport state: consumers must
 * not fabricate it from a plugin id or downgrade a mounted request to host
 * presentation when the daemon disappears.
 */
function resolvePluginSurfaceCallerBinding(
    facts: BoundPluginSurfaceFacts,
): PluginSurfaceActionMountedBinding | null {
    const machineId = typeof facts.machineId === 'string' && facts.machineId.trim().length > 0
        ? facts.machineId
        : null;
    const materializationRef = facts.executionOrigin?.materializationRef;
    if (
        !machineId
        || !materializationRef
        || materializationRef.pluginId !== facts.pluginId
        || materializationRef.machineId !== machineId
    ) {
        return null;
    }
    return Object.freeze({
        contributionLocalId: facts.contributionId,
        materializationRef,
    });
}

function createBoundPluginSurfaceActionDispatcher(input: Readonly<{
    surfaceContext: PluginUiSurfaceContextV1;
    hostApi: PluginSurfaceHostApiV1;
}>): BoundPluginSurfaceController['dispatchAction'] {
    let requestSequence = 0;
    return (action, actionInput) => {
        requestSequence += 1;
        const payload: PluginUiExecuteActionRequestV1 = {
            action,
            ...(actionInput === undefined ? {} : { input: actionInput }),
        };
        const request: PluginUiHostApiRequestEnvelopeV1 = {
            version: 1,
            requestId: `bound-surface-action:${requestSequence}`,
            surface: input.surfaceContext,
            method: 'executeAction',
            payload,
        };
        return Promise.resolve(input.hostApi.handleRequest(request));
    };
}

function createBoundPluginSurfaceComposerApplyDispatcher(input: Readonly<{
    surfaceContext: PluginUiSurfaceContextV1;
    hostApi: PluginSurfaceHostApiV1;
}>): BoundPluginSurfaceController['applyComposer'] {
    let requestSequence = 0;
    return (ref, transaction) => {
        requestSequence += 1;
        const payload: PluginUiApplyComposerRequestV1 = PluginUiApplyComposerRequestV1Schema.parse({
            ref,
            transaction,
        });
        const request: PluginUiHostApiRequestEnvelopeV1 = {
            version: 1,
            requestId: `bound-surface-composer-apply:${requestSequence}`,
            surface: input.surfaceContext,
            method: 'applyComposer',
            payload: PluginUiJsonValueV1Schema.parse(payload),
        };
        return Promise.resolve(input.hostApi.handleRequest(request));
    };
}

function createBoundPluginSurfaceOpenDispatcher(input: Readonly<{
    surfaceContext: PluginUiSurfaceContextV1;
    hostApi: PluginSurfaceHostApiV1;
}>): BoundPluginSurfaceController['openSurface'] {
    let requestSequence = 0;
    return (destination) => {
        requestSequence += 1;
        const request: PluginUiHostApiRequestEnvelopeV1 = {
            version: 1,
            requestId: `bound-surface-open:${requestSequence}`,
            surface: input.surfaceContext,
            method: 'openSurface',
            // Keep the row command envelope fixed. Context, Account data and
            // author-provided row JSON belong to their canonical owners.
            payload: {
                destination: {
                    pluginId: destination.pluginId,
                    localId: destination.localId,
                },
            },
        };
        return Promise.resolve(input.hostApi.handleRequest(request));
    };
}

type NormalizeCurrentUiContextPublicationResult =
    | Readonly<{ ok: true; enrichment: CurrentUiContextMountedEnrichment | null }>
    | Readonly<{ ok: false }>;

/**
 * The protocol request is the only author-input parser. This controller then
 * qualifies local semantic references once, while deliberately leaving Action
 * execution and destination navigation with their existing semantic owners.
 */
function normalizeCurrentUiContextPublication(input: Readonly<{
    pluginId: string;
    payload: unknown;
}>): NormalizeCurrentUiContextPublicationResult {
    const parsed = PluginUiPublishCurrentUiContextRequestV1Schema.safeParse(input.payload);
    if (!parsed.success) return { ok: false };
    const enrichment = parsed.data.enrichment;
    if (enrichment === null) return { ok: true, enrichment: null };

    const commands: Array<NonNullable<CurrentUiContextMountedEnrichment['commands']>[number]> = [];
    for (const declaration of enrichment.commands ?? []) {
        const command = normalizePluginUiSemanticCommandV1({
            pluginId: input.pluginId,
            command: declaration.command,
        });
        if (command === null) return { ok: false };
        commands.push(Object.freeze({
            title: declaration.title,
            ...(declaration.description === undefined ? {} : { description: declaration.description }),
            command,
        }));
    }
    return Object.freeze({
        ok: true as const,
        enrichment: Object.freeze({
            ...(enrichment.entity === undefined ? {} : { entity: enrichment.entity }),
            ...(enrichment.detail === undefined ? {} : { detail: enrichment.detail }),
            ...(enrichment.commands === undefined ? {} : { commands: Object.freeze(commands) }),
        }),
    });
}

/** The controller owns this Host API method; mounted bundles cannot bypass it. */
function omitCurrentUiContextHostApiHandler(
    handlers: PluginSurfaceHostApiHandlers | undefined,
): PluginSurfaceHostApiHandlers | undefined {
    if (!handlers || handlers.publishCurrentUiContext === undefined) return handlers;
    const { publishCurrentUiContext: _ignored, ...retained } = handlers;
    return retained;
}

export function createBoundPluginSurfaceController(input: Readonly<{
    facts: BoundPluginSurfaceFacts;
    binding?: BoundPluginSurfaceBinding;
}>): BoundPluginSurfaceController {
    const surfaceContext = resolveBoundPluginSurfaceContext(input.facts);
    const interactionGeneration = typeof input.facts.projectionGeneration === 'number'
        ? Number.isFinite(input.facts.projectionGeneration)
            ? String(input.facts.projectionGeneration)
            : null
        : typeof input.facts.projectionGeneration === 'string'
            && input.facts.projectionGeneration.trim().length > 0
            ? input.facts.projectionGeneration
            : null;
    // The mounted contribution owns the only exact requester provenance for
    // app-scope confirmation. A context-only surface with no projection
    // generation cannot mint one, so confirmation remains unavailable there.
    const interactionRequester = interactionGeneration
        ? Object.freeze({
            pluginId: input.facts.pluginId,
            contributionId: input.facts.contributionId,
            generationId: interactionGeneration,
            invocationId: input.facts.surfaceId,
        })
        : null;
    // The controller is the one mount-lifetime owner for every renderer. Even a
    // context-only/inert mount must retire its facade before a replacement
    // Account, generation, or instance can receive requests.
    let retired = false;
    const retirementListeners = new Set<() => void>();
    const onRetire: BoundPluginSurfaceMountLifetime['onRetire'] = (cancel) => {
        if (typeof cancel !== 'function') return NOOP_MOUNT_RETIREMENT;
        if (retired) {
            try {
                cancel();
            } catch {
                // A child observer cannot prevent its already-retired parent
                // from completing teardown.
            }
            return NOOP_MOUNT_RETIREMENT;
        }
        let removed = false;
        retirementListeners.add(cancel);
        return Object.freeze({
            dispose(): void {
                if (removed) return;
                removed = true;
                retirementListeners.delete(cancel);
            },
        });
    };
    const notifyRetirement = (): void => {
        const listeners = [...retirementListeners];
        retirementListeners.clear();
        for (const cancel of listeners) {
            try {
                cancel();
            } catch {
                // Parent retirement is best-effort per observer; it must not
                // leave later observers or the new mount blocked.
            }
        }
    };
    // The shared active Account lifetime is the sole Account-currentness
    // authority. A mount without one is not an implicit process-wide lifetime:
    // it cannot advertise handlers or accept a request until a real Account
    // scope mounts it.
    const accountLifetime = input.facts.accountLifetime;
    const parentLifetime = input.facts.parentLifetime ?? null;
    const accountActiveAtConstruction = accountLifetime?.isCurrent() === true;
    const parentActiveAtConstruction = parentLifetime?.isCurrent() !== false;
    const isCurrent = (): boolean => !retired
        && accountLifetime?.isCurrent() === true
        && parentLifetime?.isCurrent() !== false;
    const binding = input.binding;
    const isOpenableContentViewer = binding?.openableContent !== undefined;
    if (!accountActiveAtConstruction || !parentActiveAtConstruction || !input.facts.interactionEnabled) {
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
            // Missing/retired Account scope is a stronger refusal than a
            // disconnected daemon: it cannot expose even placement-local
            // navigation because there is no mounted Account authority to
            // retire the facade with.
            isCurrent,
            // A placement-local destination selection neither reaches the daemon
            // nor mutates daemon-owned state. Keep this one admitted navigation
            // method live while its Account is offline; every daemon Action,
            // Resource, and presentation method remains uninstalled. An opaque
            // file-viewer binding is a different host role: it cannot gain that
            // generic navigation handler while its stat/read binding is absent.
            handlers: accountActiveAtConstruction
                && parentActiveAtConstruction
                && !isOpenableContentViewer
                && binding?.openSurface
                ? {
                    openSurface: createPluginSurfaceOpenSurfaceHandler(
                        binding.openSurface,
                        isCurrent,
                    ),
                }
                : {},
        });
        const dispatchAction = createBoundPluginSurfaceActionDispatcher({ surfaceContext, hostApi });
        const applyComposer = createBoundPluginSurfaceComposerApplyDispatcher({ surfaceContext, hostApi });
        const openSurface = createBoundPluginSurfaceOpenDispatcher({ surfaceContext, hostApi });
        let accountRetirement: Readonly<{ dispose(): void }> | undefined;
        let parentRetirement: Readonly<{ dispose(): void }> | undefined;
        let disposed = false;
        const retire = (): void => {
            if (retired) return;
            retired = true;
        };
        const dispose = (): void => {
            if (disposed) return;
            disposed = true;
            retire();
            notifyRetirement();
            accountRetirement?.dispose();
            parentRetirement?.dispose();
            hostApi.dispose?.();
        };
        accountRetirement = accountLifetime?.onRetire(dispose);
        if (retired) accountRetirement?.dispose();
        parentRetirement = parentLifetime?.onRetire(dispose);
        if (retired) parentRetirement?.dispose();
        return Object.freeze({
            surfaceContext,
            hostApi,
            installedMethods: hostApi.installedMethods,
            get admissionMethods(): readonly PluginUiHostMethodV1[] {
                return hostApi.admissionMethods;
            },
            // `interactive` controls delivery of the canonical facade. A
            // context-only set remains useful because it preserves the exact
            // public context and typed refusal for omitted methods; the mounted
            // host separately keeps an offline exact target presentation-inert.
            interactive: hostApi.installedMethods.length > 0,
            subscribeResourceInvalidations: () => () => {},
            dispatchAction,
            applyComposer,
            openSurface,
            isCurrent,
            onRetire,
            retire,
            dispose,
            clearCurrentUiContext: () => {},
        });
    }

    // Semantic mount handlers are derived only after this controller owns the
    // exact Account/parent/retirement predicate. The selected workspace-file
    // viewer bypasses this path entirely; its opaque binding remains its full
    // method ceiling rather than acquiring a generic semantic capability.
    const mountedHandlerBundle = isOpenableContentViewer
        ? undefined
        : binding?.createMountedHostApiHandlers?.({ isCurrent });
    const currentUiContextPublication = mountedHandlerBundle?.currentUiContext;
    const publishCurrentUiContext = currentUiContextPublication
        ? (request: PluginUiHostApiRequestEnvelopeV1): PluginUiJsonValueV1 => {
            const normalized = normalizeCurrentUiContextPublication({
                pluginId: surfaceContext.pluginId,
                payload: request.payload,
            });
            if (!normalized.ok) {
                return createPluginSurfaceHostApiError('invalid_payload', [
                    'plugin_current_ui_context_payload_invalid',
                ]);
            }
            if (!currentUiContextPublication.publish(normalized.enrichment)) {
                return createPluginSurfaceHostApiError('unavailable', [
                    'plugin_current_ui_context_unavailable',
                ]);
            }
            return null;
        }
        : undefined;
    // A mounted bundle may contribute other semantic handlers, but only this
    // controller parses/qualifies `publishCurrentUiContext`. Dropping a legacy
    // supplied handler closes the otherwise competing publication path.
    const bindingMountedHostApiHandlers = omitCurrentUiContextHostApiHandler(
        binding?.mountedHostApiHandlers,
    );
    const bundleMountedHostApiHandlers = omitCurrentUiContextHostApiHandler(
        mountedHandlerBundle?.handlers,
    );
    const mountedHostApiHandlers = mountedHandlerBundle
        ? Object.freeze({
            ...bindingMountedHostApiHandlers,
            ...bundleMountedHostApiHandlers,
            ...(publishCurrentUiContext ? { publishCurrentUiContext } : {}),
        })
        : bindingMountedHostApiHandlers;
    const disposeMountedHostApiHandlers = mountedHandlerBundle
        ? () => {
            // Retire the exact current-UI record before arbitrary mounted
            // presentation cleanup. This is the controller's synchronous
            // currentness boundary, not a provider-side watcher.
            currentUiContextPublication?.dispose();
            binding?.disposeMountedHostApiHandlers?.();
            mountedHandlerBundle.dispose?.();
        }
        : binding?.disposeMountedHostApiHandlers;
    // Factories run while React renders. Keep their optional activation and
    // focus updates attached to this controller, then let the hook below call
    // them only after commit. This avoids a second lifetime side channel and
    // prevents an abandoned render from registering semantic context.
    const activateMountedHostApiHandlers = mountedHandlerBundle?.activate
        ? () => {
            if (isCurrent()) mountedHandlerBundle.activate?.();
        }
        : undefined;
    const setCurrentUiContextEligibility = mountedHandlerBundle?.setCurrentUiContextEligibility
        ? (eligible: boolean) => {
            if (isCurrent()) mountedHandlerBundle.setCurrentUiContextEligibility?.(eligible);
        }
        : undefined;
    const clearCurrentUiContext = (): void => {
        if (isCurrent()) currentUiContextPublication?.clear();
    };

    const callerBinding = resolvePluginSurfaceCallerBinding(input.facts);
    // Addressing/generation are mount identity facts. Reachability is not: a
    // reconnect must make the existing facade capable again without replacing
    // its adapter or aborting an author-held signal.
    const daemon = resolveDaemonBinding(input.facts);
    // Client-targeted Actions need the same exact projection generation but no
    // daemon reachability. The generic executable index, not this controller,
    // resolves the target/origin/registration under this fact.
    const clientAction = typeof input.facts.projectionGeneration === 'number'
        && Number.isInteger(input.facts.projectionGeneration)
        && input.facts.projectionGeneration >= 0
        ? {
            projectionGeneration: input.facts.projectionGeneration,
            ...(surfaceContext.sessionId ? { sessionId: surfaceContext.sessionId } : {}),
            ...(input.facts.readCurrentUiContext
                ? { currentUiContext: input.facts.readCurrentUiContext }
                : {}),
        }
        : null;
    const isDaemonInteractionEnabled = input.facts.isDaemonInteractionEnabled
        ?? (() => input.facts.daemonInteractionEnabled);
    const isMethodAvailable = (method: PluginUiHostMethodV1): boolean => (
        !isDaemonOwnedPluginSurfaceMethod(method) || isDaemonInteractionEnabled()
    );
    // Keep host-Action target stamping compatible with the incumbent cold
    // offline facade. Reconnects change daemon-owned method availability live;
    // they do not retrospectively lend an initially offline host Action a
    // detached execution target.
    const daemonBoundAtConstruction = isDaemonInteractionEnabled() ? daemon : null;
    const resourceCapability = input.facts.resourceCapability;
    const canReadResource = resourceCapability?.readable === true;
    // A dynamic capability without a readable snapshot is not a usable
    // subscription contract. The daemon owns exact-resource admission once
    // this selected-member gate has installed the transport.
    const canWatchResource = canReadResource && resourceCapability?.dynamic === true;
    // The mount lifetime, observable to the handlers: an action or resource read
    // that settles after disposal must not reach a retired surface (§3.1).
    const hostActionContext: ActionExecutorContext | undefined = input.facts.serverId || daemonBoundAtConstruction
        ? {
            ...(input.facts.serverId ? { serverId: input.facts.serverId } : {}),
            // Only the admitted daemon binding can stamp a detached target.
            // It is never Action input and V2 preflight still selects the final
            // exact machine used by the execution.run transport.
            ...(daemonBoundAtConstruction
                ? { executionRunTargetMachineId: daemonBoundAtConstruction.machineId }
                : {}),
        }
        : undefined;
    // The mount-scoped invalidation sink. It is a fan-out, not a registry: it
    // holds no subscription state, no queue and no currentness of its own — the
    // daemon owns admission and bounds, and the transport adapter owns the
    // subscription registry it publishes into.
    const resourceInvalidationListeners = new Set<(event: PluginUiResourceSubscriptionEventV1) => void>();
    // One controller-owned lifetime fences target selection and all
    // daemon-backed Resource work. Replacements abort obsolete work rather than
    // merely withholding its eventual delivery.
    const mountLifetime = new AbortController();
    const targetedContributions = input.facts.targetedContributions;
    const selectActionInput = daemon
        ? createPluginActionInputSelectionHostApiHandler({
            ...(input.facts.pluginProjectionById
                ? { pluginProjectionById: input.facts.pluginProjectionById }
                : {}),
            ...(input.facts.pluginUiProjection
                ? { pluginUiProjection: input.facts.pluginUiProjection }
                : {}),
            targetedContributions,
            // The same raw V2 resolver this mount already hands the generic
            // action Host API. Without it the selection controller reads an
            // unknown execution realm as daemon-owned and presents a client
            // Action's form before its executable registration has committed.
            ...(input.facts.resolveContributedAction
                ? { resolveContributedAction: input.facts.resolveContributedAction }
                : {}),
            host: {
                machineId: daemon.machineId,
                serverId: daemon.serverId ?? null,
                expectedGeneration: daemon.expectedGeneration,
                targetPluginId: input.facts.pluginId,
                ...(surfaceContext.sessionId ? { sessionId: surfaceContext.sessionId } : {}),
                accountLifetime,
                signal: mountLifetime.signal,
                isCurrent,
            },
            isCurrent,
        })
        : null;
    const hostApi = createPluginSurfaceActionHostApi({
        pluginUiProjection: input.facts.pluginUiProjection,
        surfaceContext,
        ...(interactionRequester ? { interactionRequester } : {}),
        isMethodAvailable,
        isContributedActionAvailable: isDaemonInteractionEnabled,
        isCurrent,
        resourceLifetimeSignal: mountLifetime.signal,
        hostAction: {
            execute: binding?.executeHostAction ?? createFrontDoorActionExecute(),
            ...(hostActionContext ? { context: hostActionContext } : {}),
        },
        ...(callerBinding ? { callerBinding } : {}),
        ...(input.facts.resolveContributedAction
            ? { resolveContributedAction: input.facts.resolveContributedAction }
            : {}),
        ...(clientAction ? { clientAction } : {}),
        ...(daemon
            ? {
                contributedAction: {
                    ...daemon,
                    ...(surfaceContext.sessionId
                        ? { sessionId: surfaceContext.sessionId }
                        : {}),
                    ...(binding?.executeContributedAction
                        ? { execute: binding.executeContributedAction }
                        : {}),
                },
                ...(canReadResource
                    ? {
                        resource: {
                            ...daemon,
                            ...(input.facts.resourceContext === undefined
                                ? {}
                                : { context: input.facts.resourceContext }),
                            ...(binding?.readResource ? { read: binding.readResource } : {}),
                        },
                    }
                    : {}),
                ...(canWatchResource
                    ? {
                        resourceInvalidation: {
                            deliver: (event) => {
                                for (const listener of [...resourceInvalidationListeners]) {
                                    try {
                                        listener(event);
                                    } catch {
                                        // One surface's delivery failure never stops another's.
                                    }
                                }
                            },
                            ...(binding?.watchResource ? { transport: binding.watchResource } : {}),
                        },
                    }
                    : {}),
                ...(binding?.openableContent
                    ? { openableContent: binding.openableContent }
                    : {}),
            }
            : {}),
        ...(binding?.openSurface ? { openSurface: binding.openSurface } : {}),
        ...(selectActionInput ? { selectActionInput } : {}),
        ...(mountedHostApiHandlers
            ? { mountedHostApiHandlers }
            : {}),
        ...(disposeMountedHostApiHandlers
            ? { disposeMountedHostApiHandlers }
            : {}),
    });
    const dispatchAction = createBoundPluginSurfaceActionDispatcher({ surfaceContext, hostApi });
    const applyComposer = createBoundPluginSurfaceComposerApplyDispatcher({ surfaceContext, hostApi });
    const openSurface = createBoundPluginSurfaceOpenDispatcher({ surfaceContext, hostApi });
    let accountRetirement: Readonly<{ dispose(): void }> | undefined;
    let parentRetirement: Readonly<{ dispose(): void }> | undefined;
    let disposed = false;
    const retire = (): void => {
        if (retired) return;
        retired = true;
        mountLifetime.abort();
    };
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        retire();
        notifyRetirement();
        accountRetirement?.dispose();
        parentRetirement?.dispose();
        hostApi.dispose?.();
        resourceInvalidationListeners.clear();
    };
    accountRetirement = accountLifetime?.onRetire(dispose);
    if (retired) accountRetirement?.dispose();
    parentRetirement = parentLifetime?.onRetire(dispose);
    if (retired) parentRetirement?.dispose();

    return Object.freeze({
        surfaceContext,
        hostApi,
        installedMethods: hostApi.installedMethods,
        get admissionMethods(): readonly PluginUiHostMethodV1[] {
            return hostApi.admissionMethods;
        },
        interactive: hostApi.installedMethods.length > 0,
        subscribeResourceInvalidations: (listener) => {
            resourceInvalidationListeners.add(listener);
            return () => { resourceInvalidationListeners.delete(listener); };
        },
        dispatchAction,
        applyComposer,
        openSurface,
        isCurrent,
        onRetire,
        retire,
        dispose,
        clearCurrentUiContext,
        ...(activateMountedHostApiHandlers ? { activateMountedHostApiHandlers } : {}),
        ...(setCurrentUiContextEligibility ? { setCurrentUiContextEligibility } : {}),
    });
}

/**
 * Mount-scoped controller. Rebuilt only when a fact that changes what is
 * installable changes — never on an environment refresh — and disposed when the
 * mount retires it, so a `notify` it published or a `confirm` it opened retires
 * with the surface (§3.4) and in-flight daemon work is fenced.
 */
export function useBoundPluginSurfaceController(input: Readonly<{
    facts: BoundPluginSurfaceFacts;
    binding?: BoundPluginSurfaceBinding;
}>): BoundPluginSurfaceController {
    const facts = input.facts;
    const binding = input.binding;
    const daemonInteractionEnabledRef = React.useRef(facts.daemonInteractionEnabled);
    daemonInteractionEnabledRef.current = facts.daemonInteractionEnabled;
    const isDaemonInteractionEnabled = React.useCallback(
        () => daemonInteractionEnabledRef.current,
        [],
    );
    const actionInputSelectionFactsKey = serializePluginActionInputSelectionFacts({
        pluginProjectionById: facts.pluginProjectionById,
        pluginUiProjection: facts.pluginUiProjection,
        targetedContributions: facts.targetedContributions,
        targetPluginId: facts.pluginId,
    });
    const controller = React.useMemo(
        () => createBoundPluginSurfaceController({
            facts: { ...facts, isDaemonInteractionEnabled },
            ...(binding ? { binding } : {}),
        }),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the memo is keyed
        // on the facts themselves; `facts`/`binding` are caller-built objects whose
        // identity would otherwise churn the controller on every parent render and
        // retire every subscription the mounted surface holds (UI-D03).
        [
            facts.pluginId,
            facts.contributionId,
            facts.surfaceId,
            facts.placement,
            facts.platform,
            facts.channel,
            facts.machineId,
            facts.serverId,
            facts.sessionId,
            facts.targetAuthorityKey,
            facts.projectionGeneration,
            facts.readCurrentUiContext,
            facts.executionOrigin?.serverIdentityId,
            facts.executionOrigin?.materializationRef.pluginId,
            facts.executionOrigin?.materializationRef.machineId,
            facts.executionOrigin?.materializationRef.materializationId,
            facts.resourceCapability?.readable,
            facts.resourceCapability?.dynamic,
            serializeBoundPluginSurfaceResourceContext(facts.resourceContext),
            facts.accountLifetime,
            facts.parentLifetime,
            facts.mountInstanceKey,
            facts.interactionEnabled,
            actionInputSelectionFactsKey,
            facts.resolveContributedAction,
            joinResourceScope(facts.resourceScope),
            binding?.executeHostAction,
            binding?.openSurface,
            binding?.executeContributedAction,
            binding?.readResource,
            binding?.watchResource,
            binding?.openableContent,
            binding?.mountedHostApiHandlers,
            binding?.disposeMountedHostApiHandlers,
            binding?.createMountedHostApiHandlers,
        ],
    );
    React.useInsertionEffect(() => (
        // StrictMode replays layout effects without recreating this memoized
        // controller. Insertion cleanup therefore only fences the exact
        // controller; publication teardown waits for the safe layout phase.
        () => controller.retire()
    ), [controller]);
    React.useLayoutEffect(() => {
        // A mounted-handler factory runs during render to contribute its
        // methods, but external registration remains a committed layout
        // effect. The exact mounted bundle makes replayed activation idempotent.
        controller.activateMountedHostApiHandlers?.();
        return () => {
            // React runs insertion cleanup before layout cleanup for actual
            // replacement and unmount. StrictMode replays only layout effects,
            // so a current controller is not disposed by the simulated cleanup.
            if (!controller.isCurrent()) controller.dispose();
        };
    }, [controller]);
    return controller;
}

function joinResourceScope(
    scope: readonly PluginUiSurfaceContextV1['resourceScope'][number][] | undefined,
): string {
    return (scope ?? EMPTY_RESOURCE_SCOPE).map((entry) => JSON.stringify(entry)).join('|');
}

function serializeBoundPluginSurfaceResourceContext(
    context: PluginResourceContextV1 | undefined,
): string {
    return context === undefined ? '' : stableJsonStringify(context);
}

/**
 * A contribution's declared `requiredHostMethods` — a renderer ADMISSION
 * requirement (§3.4), never an availability claim. An unparseable declaration
 * fails closed as an unsatisfiable requirement rather than as "requires nothing".
 */
export function readRequiredPluginSurfaceHostMethods(
    value: unknown,
): readonly PluginUiHostMethodV1[] | null {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value)) return null;
    const methods: PluginUiHostMethodV1[] = [];
    for (const method of value) {
        const parsed = PluginUiHostMethodV1Schema.safeParse(method);
        if (!parsed.success) return null;
        methods.push(parsed.data);
    }
    return Object.freeze(methods);
}

/**
 * Renderer admission: every declared required method must be in the mount's
 * factually installed set.
 */
export function areRequiredPluginSurfaceHostMethodsInstalled(
    required: readonly PluginUiHostMethodV1[] | null,
    installed: readonly PluginUiHostMethodV1[],
): boolean {
    return required !== null && required.every((method) => installed.includes(method));
}
