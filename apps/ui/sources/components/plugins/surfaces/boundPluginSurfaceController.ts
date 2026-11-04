import { createPluginOpenAutomationEventHostApiHandler } from './pluginOpenAutomationEventHostApi';
import * as React from 'react';
import { useUiSurfaceOwnerLifetime } from '@/components/plugins/hostApi/useUiSurfaceOwnerLifetime';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { createPluginWidgetAreaHostHandler } from './pluginWidgetAreaHost';
import { createPluginUiResourceStore, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { createPluginDeclaredResourceStore } from './PluginContextualResourceStoreProvider';
import { createPluginSurfaceHostReadStore } from './pluginSurfaceHostReadStore';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { getUsageQueryResourceStore } from '@/sync/api/account/usageQueryResource';
import { resolvePluginUiHostReadActionIdV1 } from '@happier-dev/protocol/plugins/ui/subscriptions';
import type { PluginUiAccountExecutableOrigin } from '@/components/plugins/reactNative/executableModuleHost';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';

import type {
    ActionExecutorContext,
    ComposerRefV1,
    ComposerTransactionV1,
    PluginMachineExecutionOriginV1,
    PluginContributionIdentityV1,
    PluginResourceContextV1,
    PluginUiResourceBindingCapabilityV1,
} from '@happier-dev/protocol';
import { PluginInvocableActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import {
    PLUGIN_UI_HOST_METHODS_V1,
    PluginUiExecuteActionRequestV1Schema,
    PluginUiApplyComposerRequestV1Schema,
    PluginUiHostMethodV1Schema,
    PluginUiJsonValueV1Schema,
    PluginUiPublishCurrentUiContextRequestV1Schema,
    normalizePluginUiSemanticCommandV1,
    reconstructPluginUiSelectedActionInput,
    type PluginUiChannelV1,
    type PluginUiApplyComposerRequestV1,
    type PluginUiHostMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiHostApiErrorPayloadV1,
    type PluginUiInstanceKeyV1,
    type PluginUiExecuteActionRequestV1,
    type PluginUiJsonValueV1,
    type PluginUiMountedActionReferenceV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiSurfaceContextV1,
    type PluginUiTargetedContributionsV1,
    type PluginUiWidgetAreaRequestV1,
    type CurrentUiContextSnapshotV1,
} from '@happier-dev/protocol/plugins/ui';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import {
    useEndpointStatus,
    useMachineCliDetectionTarget,
} from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { PluginMachineExecutionOriginStateV1, PluginMachineOriginRejectionReasonV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { describePluginExecutionOriginRefusal, resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { EMPTY_PLUGIN_UI_PROJECTION, readCompletePluginUiResourceDeclarations, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import {
    createPluginSurfaceHostApiError,
    createPluginSurfaceHostApi,
    type PluginSurfaceHostApiHandlers,
    type PluginSurfaceHostApiMethodHandler,
    type PluginSurfaceHostApiV1,
} from './createPluginSurfaceHostApi';
import type { CurrentUiContextMountedEnrichment } from '@/components/appShell/currentUiContext/currentUiContextModel';
import {
    createPluginSurfaceActionHostApi,
    preparePluginSurfaceHostRead,
    type PluginSurfaceActionMountedBinding,
    type PluginSurfaceContributedActionDescriptorResolver,
    type PluginSurfaceContributedActionTransport,
    type PluginSurfaceHostActionExecute,
    type PluginSurfaceMachineHostApiBindings,
} from './pluginSurfaceActionDispatch';
import {
    createPluginSurfaceOpenSurfaceHandler,
    type PluginSurfaceOpenHandler,
} from './openPluginSurface';
import {
    createPluginOpenConnectedAccountsHostApiHandler,
    type PluginOpenConnectedAccountsHandler,
} from './openPluginConnectedAccounts';
import { createPluginContextualResourceReadClient, type PluginSurfaceResourceReadTransport } from './pluginSurfaceResourceRead';
import { createPluginContextualResourceWatchClient, type PluginSurfaceResourceWatchTransport } from './pluginSurfaceResourceWatch';
import type { PluginSurfaceOpenableContentBinding } from './pluginSurfaceOpenableContent';
import {
    createPluginActionInputSelectionHostApiHandler,
} from './pluginActionInputSelectionHostApi';
import type { PluginActionInputSelectionSnapshot } from './pluginActionInputSelectionFacts';
import { createPluginOpenNewSessionHostApiHandler } from './pluginOpenNewSessionHostApi';
import { createPluginContributedActionController } from '@/components/plugins/actions/pluginContributedActionController';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import { createPluginSurfaceSessionHandlers } from './pluginSurfaceSessionState';
import { createPluginSurfaceStoredImageOwner, type PluginStoredImageReadTransport } from './pluginSurfaceStoredImage';
import { createPluginSurfaceLiveStreamOwner } from './pluginSurfaceLiveStream';
import { WidgetFrameBodyNoticeContext, type WidgetFrameBodyNotice, type WidgetFrameBodyNoticeSource } from '@/components/widgets/frame/widgetFrameBodyCaption';

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
 * that cannot address a machine and an exact occurrence installs no
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
 * Action/Resource semantics. `daemonStateVersion` is runtime metadata;
 * declaration currentness belongs to the supplying occurrence and source.
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
    /** Presentation-only label from the existing machine display projection. */
    machineDisplayName?: string | null;
    /** Whether this Home has any machine at all, so "none can run it" is not worded as "add a machine". */
    homeHasMachines?: boolean;
    /** The plugin's display name, for sentences that name it. */
    pluginDisplayName?: string | null;
    /** Presentation consumes Administration's decision; absence of a pin is not a decision. */
    executionOriginSelectionKind?: PluginMachineExecutionOriginStateV1['kind'];
    /**
     * Why Administration found no runnable Machine, when it has candidates. `machineDisplayName` names the
     * one Machine that refused (`null` while its name loads); absent when several did.
     */
    executionOriginRefusal?: Readonly<{
        reasons: readonly (PluginMachineOriginRejectionReasonV1 | 'no_materialization')[];
        machineDisplayName?: string | null;
    }>;
    /** The target-read owner's classified failure; it does not establish Machine incapability. */
    daemonConnectionFailure?: Readonly<{
        code: PluginUiHostApiErrorPayloadV1['code'];
        reasonCode: string;
    }>;
    serverId?: string | null;
    /** Exact occurrence of the plugin that owns this mounted surface. */
    occurrenceId?: string | null;
    /** Admitted Machine supplier lease for transport; never Account caller custody. */
    daemonOccurrenceId?: string | null;
    /** Current Account-rendered surface custody from the Availability projection. */
    accountExecutionOrigin?: PluginUiAccountExecutableOrigin;
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
     * consumer. Instance-bearing mounts use the closed Protocol surface arm;
     * a Composer Session uses its exact Session arm. Singleton mounts omit it.
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
    /** Undefined is unknown; a present empty set is producer-complete. */
    resourceDeclarations?: PluginUiProjectionModel['resourcesById'];
    /** Current mounted facts; catalog-only readers may override a subset of the captured facts. */
    readActionInputFacts?: () => Partial<BoundPluginSurfaceFacts>;
    /** Source-owned caller custody, including targets with no selectable Actions. */
    targetSourceCustody?: PluginUiTargetedContributionsV1['target']['sourceCustody'] | null;
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
    /** Live admission of a containing host document; this is not another mount lifetime. */
    isHostCurrent?: () => boolean;
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
     * Told, on this mount's first Machine-owned refusal, how to word it from then on (`undefined` once
     * the Machine answers); a widget frame says it once above the body.
     */
    onMachineUnavailable?: (describe: WidgetFrameBodyNoticeSource) => void;
    /**
     * The hook-owned live form of daemon availability. It narrows the already
     * bound daemon handlers during connectivity/projection refresh without
     * becoming a controller identity or lifecycle owner.
     */
    isDaemonInteractionEnabled?: () => boolean;
    /** Positive loading fact from the physical host, distinct from settled unavailability. */
    isDaemonConnectionPending?: () => boolean;
    /** Live projection admission narrows interaction without retiring this physical mount. */
    isInteractionEnabled?: () => boolean;
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
    /** Revalidation is read-only unless an actual operation records the existing last-use hint. */
    isExecutionOriginCurrent?: (options?: Readonly<{ recordUse?: boolean }>) => boolean;
    /**
     * The host-ActionSpec front door. Defaults to the canonical lazily-resolved
     * `ActionExecutor.execute`, so ActionsSettings enablement and approval routing
     * always apply.
     */
    executeHostAction?: PluginSurfaceHostActionExecute;
    /** EU-5a: the placement's own destination selector. Absent → uninstalled. */
    openSurface?: PluginSurfaceOpenHandler;
    /** Happier-owned semantic navigation to Connected Accounts. */
    openConnectedAccounts?: PluginOpenConnectedAccountsHandler;
    /** Transport overrides for the daemon boundary (tests). */
    executeContributedAction?: PluginSurfaceContributedActionTransport;
    readResource?: PluginSurfaceResourceReadTransport;
    readStoredImage?: PluginStoredImageReadTransport;
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
    /** Private declaration-aware facade over the shared Resource owner. */
    resourceStore?: PluginUiResourceStore;
    /** Reconcile representation updates under this physical caller's authority. */
    updateMountedBindings?: (input: Readonly<{
        createMountedHostApiHandlers?: BoundPluginSurfaceMountedHostApiHandlersFactory;
        openConnectedAccounts?: PluginOpenConnectedAccountsHandler;
    }>) => boolean;
    /** Private approved descriptor; it never enters the public subscription result. */
    readLiveStreamViewing: (subscriptionId: string) => import('@happier-dev/protocol').DaemonPluginUiCaptureSourceDescriptorV1 | null;
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
    /** The same current daemon admission used by contributed Action dispatch, without recording use. */
    canInteractWithDaemon: () => boolean;
    /** The exact caller binding consumed by dispatch, independent of daemon reachability. */
    isRequesterAdmitted: () => boolean;
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
     * Host-owned native/declarative widget-area controls. Public plugin code uses
     * hostApi instead; both paths share declared-area admission and mount lifetime.
     */
    widgetArea?: (
        request: PluginUiWidgetAreaRequestV1,
        options?: Readonly<{ signal?: AbortSignal }>,
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
    // Openable stat/read use the File opener's concrete host binding, whose own
    // target/transport reports availability independently of the plugin daemon.
    return method === 'watchLiveStream' || method === 'readStoredImage' || method === 'readResource' || method === 'watchResource'
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
 * occurrence it is bound to cannot serve either, so neither is installed.
 *
 * Caller provenance is deliberately not part of this transport binding. A local
 * host Action remains locally executable while the daemon is unavailable, but a
 * mounted plugin caller separately retains the source that made the surface
 * current. Account custody never substitutes for the supplying Machine's lease.
 */
function resolveDaemonBinding(facts: BoundPluginSurfaceFacts): Readonly<{
    machineId: string;
    serverId?: string | null;
    expectedOccurrenceId: string;
}> | null {
    const machineId = typeof facts.machineId === 'string' && facts.machineId.trim().length > 0
        ? facts.machineId
        : null;
    const occurrenceId = (facts.daemonOccurrenceId ?? (facts.accountExecutionOrigin ? undefined : facts.occurrenceId))?.trim();
    if (!machineId || !occurrenceId) {
        return null;
    }
    return {
        machineId,
        serverId: facts.serverId ?? null,
        expectedOccurrenceId: occurrenceId,
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
    if (facts.accountExecutionOrigin) {
        const selected = readCurrentAccountSurfaceSelection(facts);
        return selected ? Object.freeze({
            pluginId: facts.pluginId, pluginVersion: selected.manifest.version,
            contributionLocalId: facts.contributionId, occurrenceId: selected.custodyId,
            sourceCustody: selected.sourceCustody,
        }) : null;
    }
    const machineId = typeof facts.machineId === 'string' && facts.machineId.trim().length > 0
        ? facts.machineId
        : null;
    const occurrenceId = facts.occurrenceId?.trim();
    const materializationRef = facts.executionOrigin && 'materializationRef' in facts.executionOrigin
        ? facts.executionOrigin.materializationRef : undefined;
    const sourceRef = facts.executionOrigin && 'sourceRef' in facts.executionOrigin ? facts.executionOrigin.sourceRef : undefined;
    if (
        !machineId
        || !occurrenceId
        || (materializationRef !== undefined && (
            materializationRef.pluginId !== facts.pluginId
            || materializationRef.machineId !== machineId
        ))
        || (sourceRef !== undefined && (sourceRef.pluginId !== facts.pluginId || sourceRef.machineId !== machineId))
    ) {
        return null;
    }
    return Object.freeze({
        pluginId: facts.pluginId,
        contributionLocalId: facts.contributionId,
        occurrenceId,
        ...(materializationRef === undefined ? {} : { materializationRef }),
        ...(sourceRef === undefined ? {} : { sourceCustody: sourceRef.sourceCustody }),
    });
}

function readCurrentAccountSurfaceSelection(facts: BoundPluginSurfaceFacts) {
    const origin = facts.accountExecutionOrigin;
    const lifetime = facts.accountLifetime;
    if (!origin || !lifetime?.isCurrent() || origin.accountId !== lifetime.scope.accountId
        || !areServerProfileIdentifiersEquivalent(origin.serverId, lifetime.scope.serverId)
        || origin.custodyId !== facts.occurrenceId) return null;
    const selected = readPluginAccountAvailability(lifetime.scope).readCurrentAccountExecution(facts.pluginId);
    return selected.kind === 'available' && selected.custodyId === origin.custodyId
        && pluginSourceCustodyV1Equal(selected.sourceCustody, origin.sourceCustody) ? selected : null;
}

function readMachineAuthorityKey(facts: BoundPluginSurfaceFacts): string {
    return stableJsonStringify([facts.machineId ?? null, facts.daemonOccurrenceId ?? null, facts.executionOrigin ?? null]);
}

function readMachineBindingsKey(facts: BoundPluginSurfaceFacts): string {
    return stableJsonStringify([readMachineAuthorityKey(facts),
        facts.resourceCapability?.readable === true, facts.resourceCapability?.dynamic === true,
        serializeBoundPluginSurfaceResourceContext(facts.resourceContext)]);
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

function createBoundPluginSurfaceWidgetAreaDispatcher(input: Readonly<{
    surfaceContext: PluginUiSurfaceContextV1;
    hostApi: Pick<PluginSurfaceHostApiV1, 'handleRequest'>;
}>): NonNullable<BoundPluginSurfaceController['widgetArea']> {
    let requestSequence = 0;
    return (payload, options) => {
        requestSequence += 1;
        const request: PluginUiHostApiRequestEnvelopeV1 = {
            version: 1,
            requestId: `bound-surface-widget-area:${requestSequence}`,
            surface: input.surfaceContext,
            method: 'widgetArea',
            payload,
        };
        return Promise.resolve(input.hostApi.handleRequest(request, options?.signal ? { signal: options.signal } : undefined));
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
function omitControllerOwnedHostApiHandlers(
    handlers: PluginSurfaceHostApiHandlers | undefined,
): PluginSurfaceHostApiHandlers | undefined {
    if (!handlers) return handlers;
    const {
        publishCurrentUiContext: _ignoredCurrentUiContext,
        openConnectedAccounts: _ignoredConnectedAccounts,
        watchLiveStream: _ignoredLiveStream,
        ...retained
    } = handlers;
    return retained;
}

export function createBoundPluginSurfaceController(input: Readonly<{
    facts: BoundPluginSurfaceFacts;
    binding?: BoundPluginSurfaceBinding;
}>): BoundPluginSurfaceController {
    const surfaceContext = resolveBoundPluginSurfaceContext(input.facts);
    const interactionOccurrenceId = input.facts.occurrenceId?.trim() || null;
    // The mounted contribution owns the only exact requester provenance for
    // app-scope confirmation. A context-only surface with no exact occurrence
    // cannot mint one, so confirmation remains unavailable there.
    const interactionRequester = interactionOccurrenceId
        ? Object.freeze({
            pluginId: input.facts.pluginId,
            contributionId: input.facts.contributionId,
            occurrenceId: interactionOccurrenceId,
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
    const parentActiveAtConstruction = parentLifetime?.isCurrent() !== false && input.facts.isHostCurrent?.() !== false;
    const isCurrent = (): boolean => !retired
        && accountLifetime?.isCurrent() === true
        && parentLifetime?.isCurrent() !== false
        && input.facts.isHostCurrent?.() !== false
        && (!input.facts.accountExecutionOrigin || readCurrentAccountSurfaceSelection(input.facts) !== null);
    const isInteractionCurrent = (): boolean => isCurrent()
        && (input.facts.isInteractionEnabled?.() ?? input.facts.interactionEnabled);
    const binding = input.binding;
    let mountedOpenConnectedAccounts = binding?.openConnectedAccounts;
    let openConnectedAccounts = mountedOpenConnectedAccounts
        ? createPluginOpenConnectedAccountsHostApiHandler(
            mountedOpenConnectedAccounts,
            isCurrent,
        )
        : undefined;
    const isOpenableContentViewer = binding?.openableContent !== undefined;
    if (!accountActiveAtConstruction || !parentActiveAtConstruction) {
        const hostApi = createPluginSurfaceHostApi({
            surfaceContext,
            // Missing/retired Account scope is a stronger refusal than a
            // disconnected daemon: it cannot expose even placement-local
            // navigation because there is no mounted Account authority to
            // retire the facade with.
            isCurrent,
            handlers: {},
        });
        const dispatchAction = createBoundPluginSurfaceActionDispatcher({ surfaceContext, hostApi });
        const applyComposer = createBoundPluginSurfaceComposerApplyDispatcher({ surfaceContext, hostApi });
        const openSurface = createBoundPluginSurfaceOpenDispatcher({ surfaceContext, hostApi });
        const widgetArea = createBoundPluginSurfaceWidgetAreaDispatcher({ surfaceContext, hostApi });
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
            canInteractWithDaemon: () => false,
            isRequesterAdmitted: () => false,
            // This context-only facade never admits capture viewings.
            readLiveStreamViewing: () => null,
            subscribeResourceInvalidations: () => () => {},
            dispatchAction,
            applyComposer,
            openSurface,
            widgetArea,
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
    let mountedHandlerFactory = binding?.createMountedHostApiHandlers;
    let mountedHandlerBundle = isOpenableContentViewer
        ? undefined
        : mountedHandlerFactory?.({ isCurrent: isInteractionCurrent });
    let currentUiContextEnrichment: CurrentUiContextMountedEnrichment | null = null;
    let currentUiContextEligible = false;
    let mountedHandlersActivated = false;
    const publishCurrentUiContext = (request: PluginUiHostApiRequestEnvelopeV1): PluginUiJsonValueV1 => {
        const normalized = normalizeCurrentUiContextPublication({
            pluginId: surfaceContext.pluginId,
            payload: request.payload,
        });
        if (!normalized.ok) {
            return createPluginSurfaceHostApiError('invalid_payload', [
                'plugin_current_ui_context_payload_invalid',
            ]);
        }
        if (!mountedHandlerBundle?.currentUiContext?.publish(normalized.enrichment)) {
            return createPluginSurfaceHostApiError('unavailable', [
                'plugin_current_ui_context_unavailable',
            ]);
        }
        currentUiContextEnrichment = normalized.enrichment;
        return null;
    };
    // A mounted bundle may contribute other semantic handlers, but only this
    // controller parses/qualifies `publishCurrentUiContext`. Dropping a legacy
    // supplied handler closes the otherwise competing publication path.
    const bindingMountedHostApiHandlers = omitControllerOwnedHostApiHandlers(
        binding?.mountedHostApiHandlers,
    );
    const readMountedHostApiHandlers = (): PluginSurfaceHostApiHandlers => ({
        ...bindingMountedHostApiHandlers,
        ...omitControllerOwnedHostApiHandlers(mountedHandlerBundle?.handlers),
        ...(mountedHandlerBundle?.currentUiContext ? { publishCurrentUiContext } : {}),
        ...(openConnectedAccounts ? { openConnectedAccounts } : {}),
    });
    const disposeMountedBundle = () => {
        // Retire the exact current-UI record before arbitrary mounted
        // presentation cleanup. This is the controller's synchronous
        // currentness boundary, not a provider-side watcher.
        mountedHandlerBundle?.currentUiContext?.dispose();
        mountedHandlerBundle?.dispose?.();
    };
    const disposeMountedHostApiHandlers = () => {
        disposeMountedBundle();
        binding?.disposeMountedHostApiHandlers?.();
    };
    // Factories run while React renders. Keep their optional activation and
    // focus updates attached to this controller, then let the hook below call
    // them only after commit. This avoids a second lifetime side channel and
    // prevents an abandoned render from registering semantic context.
    const activateMountedHostApiHandlers = () => {
        if (!isInteractionCurrent()) return;
        mountedHandlersActivated = true;
        mountedHandlerBundle?.activate?.();
    };
    const setCurrentUiContextEligibility = (eligible: boolean) => {
        currentUiContextEligible = eligible;
        if (isInteractionCurrent()) mountedHandlerBundle?.setCurrentUiContextEligibility?.(eligible);
    };
    const clearCurrentUiContext = (): void => {
        currentUiContextEnrichment = null;
        if (isCurrent()) mountedHandlerBundle?.currentUiContext?.clear();
    };

    const callerBinding = resolvePluginSurfaceCallerBinding(input.facts);
    // Addressing/occurrence are mount identity facts. Reachability is not: a
    // reconnect must make the existing facade capable again without replacing
    // its adapter or aborting an author-held signal.
    const readActionInputFacts = (): BoundPluginSurfaceFacts => input.facts.readActionInputFacts
        ? { ...input.facts, ...input.facts.readActionInputFacts() } : input.facts;
    let machineBindingFacts = readActionInputFacts();
    let machineAuthorityKey = readMachineAuthorityKey(machineBindingFacts);
    let machineBindingsKey = readMachineBindingsKey(machineBindingFacts);
    let daemon = resolveDaemonBinding(machineBindingFacts);
    // The generic executable index resolves client targets by exact occurrence,
    // executable target and execution origin without aggregate admission.
    const clientAction = {
            ...(surfaceContext.sessionId ? { sessionId: surfaceContext.sessionId } : {}),
            ...(input.facts.readCurrentUiContext
                ? { currentUiContext: input.facts.readCurrentUiContext }
                : {}),
        };
    const isDaemonInteractionEnabled = (recordUse = true) => (input.facts.isDaemonInteractionEnabled?.() ?? input.facts.daemonInteractionEnabled)
        && binding?.isExecutionOriginCurrent?.({ recordUse }) !== false;
    // Home-family Actions and borrowed Resources share the exact same target scope.
    const homeFamilyScope = accountLifetime
        && (!input.facts.serverId || areServerProfileIdentifiersEquivalent(input.facts.serverId, accountLifetime.scope.serverId))
        ? accountLifetime.scope
        : null;
    const canAdmitHostReads = Boolean(homeFamilyScope && callerBinding && !isOpenableContentViewer
        && (binding?.executeHostAction ? binding.executeHostAction.prepare : true));
    // Retained projection data still describes the installed structural host
    // contract. Narrow live effects through the existing Host API availability
    // seam instead of constructing a reduced facade that de-admits the page.
    // Navigation/context remain useful without lending retained data authority.
    const isMethodAvailable = (method: PluginUiHostMethodV1): boolean => (
        method === 'context' || method === 'openSurface' || method === 'openConnectedAccounts'
        || (isInteractionCurrent() && (((canAdmitHostReads || hasAccountResources()) && (method === 'readResource' || method === 'watchResource'))
            || !isDaemonOwnedPluginSurfaceMethod(method) || isDaemonInteractionEnabled(false)))
    );
    const readCompleteResourceDeclarations = () => {
        const facts = readActionInputFacts();
        // Account custody owns this caller's Resource declarations. The Session's
        // Machine remains the execution target for nested source Actions.
        if (facts.accountExecutionOrigin && accountLifetime) {
            return readCompletePluginUiResourceDeclarations(
                readPluginAccountAvailability(accountLifetime.scope).readAccountUiProjection(),
                input.facts.pluginId,
                facts.accountExecutionOrigin.custodyId,
            );
        }
        if (facts.resourceDeclarations !== undefined) return facts.resourceDeclarations;
        return readCompletePluginUiResourceDeclarations(facts.pluginUiProjection, input.facts.pluginId,
            facts.accountExecutionOrigin?.custodyId ?? daemon?.expectedOccurrenceId);
    };
    const hasAccountResources = () => Object.values(readCompleteResourceDeclarations() ?? {})
        .some(resource => resource.pluginId === input.facts.pluginId && resource.execution?.target === 'account');
    let canReadResource = machineBindingFacts.resourceCapability?.readable === true || hasAccountResources();
    // A dynamic capability without a readable snapshot is not a usable
    // subscription contract. The daemon owns exact-resource admission once
    // this selected-member gate has installed the transport.
    let canWatchResource = (canReadResource && machineBindingFacts.resourceCapability?.dynamic === true) || hasAccountResources();
    const createOrdinaryResourceStore = () => {
        const admittedDaemon = daemon;
        const readable = canReadResource;
        const watchable = canWatchResource;
        const bindingsKey = machineBindingsKey;
        const resourceContext = machineBindingFacts.resourceContext;
        const current = () => bindingsKey === machineBindingsKey
            && isInteractionCurrent() && isDaemonInteractionEnabled();
        return createPluginUiResourceStore({
        pluginId: input.facts.pluginId,
        ...(accountLifetime ? { accountLifetime } : {}),
        client: {
            async readResource(resource, options) {
                if (!readable || !admittedDaemon || !current()) {
                    throw Object.assign(new Error('Resource transport is unavailable'), { code: 'plugin_resource_transport_unavailable' });
                }
                return createPluginContextualResourceReadClient({
                    pluginId: input.facts.pluginId,
                    resource: { machineId: admittedDaemon.machineId, serverId: admittedDaemon.serverId,
                        expectedCallerOccurrenceId: admittedDaemon.expectedOccurrenceId,
                        ...(resourceContext ? { context: resourceContext } : {}),
                        ...(binding?.readResource ? { read: binding.readResource } : {}) },
                    isCurrent: current,
                }).readResource(resource, options);
            },
            ...(watchable && admittedDaemon ? createPluginContextualResourceWatchClient({
                pluginId: input.facts.pluginId,
                resource: { machineId: admittedDaemon.machineId, serverId: admittedDaemon.serverId,
                    expectedCallerOccurrenceId: admittedDaemon.expectedOccurrenceId,
                    ...(resourceContext ? { context: resourceContext } : {}) },
                subscriptionIdPrefix: `surface-resource:${randomUUID()}`,
                isCurrent: current,
                ...(binding?.watchResource ? { transport: binding.watchResource } : {}),
            }) : {}),
        },
        });
    };
    const createDeclaredResourceStore = () => canReadResource && (daemon || hasAccountResources()) && accountLifetime
        ? createPluginDeclaredResourceStore({ accountLifetime, pluginId: input.facts.pluginId,
            machineId: daemon?.machineId ?? null, serverId: daemon?.serverId ?? accountLifetime.scope.serverId,
            ...(machineBindingFacts.machineId ? { actionExecutionTarget: { machineId: machineBindingFacts.machineId,
                serverId: machineBindingFacts.serverId ?? accountLifetime.scope.serverId } } : {}),
            expectedCallerOccurrenceId: daemon?.expectedOccurrenceId ?? input.facts.occurrenceId ?? '',
            createFallbackStore: createOrdinaryResourceStore,
            get resourceDeclarationsComplete() { return readCompleteResourceDeclarations() !== undefined; },
            get resourcesById() {
                return readCompleteResourceDeclarations() ?? EMPTY_PLUGIN_UI_PROJECTION.resourcesById;
            },
            ...(surfaceContext.sessionId ? { sessionId: surfaceContext.sessionId } : {}),
            ...(machineBindingFacts.resourceContext?.kind === 'surface' ? { surfaceContext: machineBindingFacts.resourceContext } : {}) })
        : null;
    let declaredResourceStore = createDeclaredResourceStore();
    let ordinaryResourceStore: PluginUiResourceStore | null = null;
    // The mount lifetime, observable to the handlers: an action or resource read
    // that settles after disposal must not reach a retired surface (§3.1).
    const readHostActionContext = (): ActionExecutorContext | undefined => {
        // Admission is live, just like Resource transport and public readiness.
        // Initial projection delivery and later withdrawal must both reach the
        // existing facade without replacing the physical mount.
        const admittedDaemon = isDaemonInteractionEnabled(false) ? daemon : null;
        return input.facts.serverId || admittedDaemon ? {
            ...(input.facts.serverId ? { serverId: input.facts.serverId } : {}),
            ...(surfaceContext.sessionId ? { defaultSessionId: surfaceContext.sessionId } : {}),
            // Only the admitted daemon binding can stamp a detached target.
            // It is never Action input and V2 preflight still selects the final
            // exact machine used by the execution.run transport.
            ...(admittedDaemon
                ? { executionRunTargetMachineId: admittedDaemon.machineId }
                : {}),
        }
        : undefined;
    };
    // The mount-scoped invalidation sink. It is a fan-out, not a registry: it
    // holds no subscription state, no queue and no currentness of its own — the
    // daemon owns admission and bounds, and the transport adapter owns the
    // subscription registry it publishes into.
    const resourceInvalidationListeners = new Set<(event: PluginUiResourceSubscriptionEventV1) => void>();
    const deliverResourceInvalidation = (event: PluginUiResourceSubscriptionEventV1): void => {
        for (const listener of [...resourceInvalidationListeners]) {
            try {
                listener(event);
            } catch {
                // One surface's delivery failure never stops another's.
            }
        }
    };
    // Linked-Session state and permission answers are client-realm host
    // capabilities of this Account (r0.42). They share the mount's one
    // invalidation fan-out and its disposal, so they add no second channel.
    const mountLifetime = new AbortController();
    const createLiveStreams = () => {
        const target = daemon;
        const authorityKey = readMachineAuthorityKey(readActionInputFacts());
        return target && accountLifetime && !isOpenableContentViewer ? createPluginSurfaceLiveStreamOwner({
            pluginId: surfaceContext.pluginId, occurrenceId: target.expectedOccurrenceId, machineId: target.machineId,
            serverId: target.serverId ?? accountLifetime.scope.serverId, lifetimeSignal: mountLifetime.signal,
            isCurrent: () => isCurrent() && authorityKey === readMachineAuthorityKey(readActionInputFacts()),
            executeAction: (request, options) => hostApi.handleRequest(request, options),
        }) : null;
    };
    let liveStreams = createLiveStreams();
    const sessionHandlers = accountLifetime && !isOpenableContentViewer
        ? createPluginSurfaceSessionHandlers({
            accountScope: accountLifetime.scope,
            accountLifetime,
            isCurrent,
            deliver: deliverResourceInvalidation,
        })
        : null;
    const mountedDisposeHostResource: PluginSurfaceHostApiMethodHandler = (request, options) =>
        readMountedHostApiHandlers().disposeHostResource?.(request, options) ?? null;
    const createStoredImages = () => {
        const target = daemon;
        const authorityKey = readMachineAuthorityKey(readActionInputFacts());
        return target && accountLifetime && !isOpenableContentViewer ? createPluginSurfaceStoredImageOwner({
            pluginId: surfaceContext.pluginId, occurrenceId: target.expectedOccurrenceId, machineId: target.machineId,
            serverId: target.serverId ?? accountLifetime.scope.serverId,
            isCurrent: () => isCurrent() && authorityKey === readMachineAuthorityKey(readActionInputFacts()),
            lifetimeSignal: mountLifetime.signal,
            ...(binding?.readStoredImage ? { read: binding.readStoredImage } : {}),
        }) : null;
    };
    let storedImages = createStoredImages();
    const readHostApiMountedHandlers = (): PluginSurfaceHostApiHandlers => sessionHandlers
        ? {
            ...readMountedHostApiHandlers(),
            readSession: sessionHandlers.handlers.readSession,
            watchSession: sessionHandlers.handlers.watchSession,
            respondToSessionPermission: sessionHandlers.handlers.respondToSessionPermission,
            ...(liveStreams ? { watchLiveStream: liveStreams.watchLiveStream } : {}),
            disposeHostResource: async (request, options) => {
                liveStreams?.disposeHostResource(request);
                sessionHandlers.handlers.disposeHostResource(request);
                return mountedDisposeHostResource
                    ? await mountedDisposeHostResource(request, options)
                    : null;
            },
        }
        : readMountedHostApiHandlers();
    const disposeHostApiMountedHandlers = sessionHandlers
        ? () => {
            storedImages?.dispose();
            liveStreams?.dispose();
            sessionHandlers.dispose();
            disposeMountedHostApiHandlers?.();
        }
        : disposeMountedHostApiHandlers;
    // One controller-owned lifetime fences target selection and all
    // daemon-backed Resource work. Replacements abort obsolete work rather than
    // merely withholding its eventual delivery.
    const targetedContributions = input.facts.targetedContributions;
    const createActionInputHost = () => ({
        machineId: daemon?.machineId,
        machineDisplayName: input.facts.machineDisplayName ?? null,
        serverId: daemon?.serverId ?? accountLifetime?.scope.serverId ?? null,
        targetPluginId: input.facts.pluginId,
        ...(surfaceContext.sessionId ? { sessionId: surfaceContext.sessionId } : {}),
        accountLifetime,
        signal: mountLifetime.signal,
        isCurrent,
    });
    let actionInputHost = createActionInputHost();
    const createSelectActionInput = (): PluginSurfaceHostApiMethodHandler | null => daemon
        ? (payload, options) => {
            const current = readActionInputFacts();
            return createPluginActionInputSelectionHostApiHandler({
                ...(current.pluginProjectionById
                    ? { pluginProjectionById: current.pluginProjectionById }
                    : {}),
                ...(current.pluginUiProjection
                    ? { pluginUiProjection: current.pluginUiProjection }
                    : {}),
                targetedContributions: current.targetedContributions,
                // Reuse the mounted raw V2 resolver for execution-realm admission.
                ...(current.resolveContributedAction
                    ? { resolveContributedAction: current.resolveContributedAction }
                    : {}),
                host: { ...actionInputHost },
                isCurrent,
            })(payload, options);
        }
        : null;
    const createOpenNewSessionBinding = () => accountLifetime
        ? (executeSelectedOperation: PluginSurfaceHostApiMethodHandler) => (
            createPluginOpenNewSessionHostApiHandler({
                pluginId: input.facts.pluginId,
                accountLifetime,
                lifetimeSignal: mountLifetime.signal,
                isCurrent,
                executeSelectedOperation,
                ...(daemon
                    ? {
                        executionTarget: {
                            serverId: daemon.serverId ?? accountLifetime.scope.serverId,
                            machineId: daemon.machineId,
                        },
                    }
                    : {}),
            })
        )
        : null;
    const hostAction = {
        execute: binding?.executeHostAction ?? (homeFamilyScope ? scopedHomeActionExecutor(homeFamilyScope) : createFrontDoorActionExecute()),
        get context() { return readHostActionContext(); },
    };
    const hostReadResourceStore = accountLifetime && homeFamilyScope && callerBinding && hostAction.execute.prepare && !isOpenableContentViewer
        ? createPluginSurfaceHostReadStore({
            isCurrent: isInteractionCurrent,
            lifetimeSignal: mountLifetime.signal,
            // Borrowed Account reads must not replace the ordinary Resource
            // path when an admitted projection has no shareable declarations.
            // Account host-read entries stay incumbent while the optional
            // Machine-backed declaration facade is admitted in place.
            get declaredStore() { return declaredResourceStore ?? (ordinaryResourceStore ??= createOrdinaryResourceStore()); },
            async admit(reference, signal) {
                const account = await captureLazyActionAccountContext(accountLifetime.scope.serverId, signal);
                try {
                    if (!isInteractionCurrent() || account.accountId !== accountLifetime.scope.accountId) {
                        throw Object.assign(new Error('Plugin Account authority retired'), { code: 'plugin_surface_retired' });
                    }
                    // API-token prepare defers server grant admission until invocation.run.
                    // A shared subscription cannot borrow bytes under that deferred proof.
                    if (account.credentialAuthorityKind === 'api_token') {
                        throw Object.assign(new Error('Host Resource admission is unavailable for this credential'), { code: 'action_prepare_unavailable' });
                    }
                    const actionId = resolvePluginUiHostReadActionIdV1(reference.hostRead);
                    const admission = await preparePluginSurfaceHostRead({
                        action: actionId, input: reference.input,
                        callerPluginId: surfaceContext.pluginId,
                        callerContributionLocalId: surfaceContext.contributionId,
                        callerBinding,
                        ...(targetedContributions ? { callerSourceCustody: targetedContributions.target.sourceCustody } : {}),
                        hostAction, signal, isCurrent: isInteractionCurrent,
                    }, actionId);
                    if (!admission.ok) throw Object.assign(new Error(admission.reason), { code: admission.reason });
                    return getUsageQueryResourceStore(account).getEntry(reference);
                } finally { account.dispose(); }
            },
        }) : null;
    let resourceStore: PluginUiResourceStore | null = hostReadResourceStore ?? declaredResourceStore;
    // The one sentence for a Machine-owned part that cannot run now: it names this mount's Run-on
    // Machine and the next step. Every host method that refuses for that reason reuses it.
    const isMachineUnavailable = (diagnostics: readonly string[], request?: PluginUiHostApiRequestEnvelopeV1): boolean => {
        if (isDaemonInteractionEnabled(false)) return false;
        if (request?.method === 'executeAction') {
            // Account/local host Actions share caller custody, but Machine
            // readiness is not their lifecycle.
            const payload = PluginUiExecuteActionRequestV1Schema.safeParse(request.payload);
            if (payload.success && PluginInvocableActionIdSchema.safeParse(payload.data.action).success) return false;
        }
        return diagnostics.includes('plugin_mounted_caller_unavailable')
            || diagnostics.includes('plugin_surface_contributed_action_unavailable')
            || diagnostics.includes('plugin_resource_transport_unavailable')
            || diagnostics.some((diagnostic) => {
                const prefix = 'host_api_method_unavailable:';
                if (!diagnostic.startsWith(prefix)) return false;
                const method = PluginUiHostMethodV1Schema.safeParse(diagnostic.slice(prefix.length));
                return method.success && isDaemonOwnedPluginSurfaceMethod(method.data);
            });
    };
    const isConnectionPending = (diagnostics: readonly string[], request?: PluginUiHostApiRequestEnvelopeV1) =>
        input.facts.isDaemonConnectionPending?.() === true && isMachineUnavailable(diagnostics, request);
    let machineNoticeLent = false;
    const describeMachineNotice = (diagnostics: readonly string[], request?: PluginUiHostApiRequestEnvelopeV1): WidgetFrameBodyNotice | undefined => {
        const daemonUnavailable = isMachineUnavailable(diagnostics, request);
        if (!daemonUnavailable || input.facts.isDaemonConnectionPending?.() === true) return undefined;
        if (input.facts.daemonConnectionFailure) {
            return { sentence: resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: input.facts.daemonConnectionFailure.reasonCode }).body };
        }
        // The plugin is installed somewhere but Administration refused it: say why, never "install it".
        const refusal = input.facts.executionOriginRefusal;
        const refusedPlugin = input.facts.pluginDisplayName?.trim();
        if (refusal && refusedPlugin && input.facts.executionOriginSelectionKind === 'unavailable') {
            const machine = refusal.machineDisplayName === undefined ? undefined
                : refusal.machineDisplayName?.trim() || input.facts.machineDisplayName?.trim() || t('machine.thisMachineInSentence');
            const explained = describePluginExecutionOriginRefusal({ reasons: refusal.reasons, plugin: refusedPlugin, machine });
            if (explained) return explained.manage
                ? { sentence: explained.sentence, managePluginId: input.facts.pluginId }
                : { sentence: explained.sentence };
        }
        const machineId = machineBindingFacts.machineId?.trim();
        if (!machineId) {
            const kind = input.facts.executionOriginSelectionKind;
            if (kind === 'selectionRequired' || kind === 'conflict') return { sentence: t('settingsPlugins.targetSelection.selectionRequired') };
            // Machines exist but none runs this plugin: name that and lead to the plugin, not to adding a machine.
            const plugin = input.facts.pluginDisplayName?.trim();
            if (kind === 'unavailable' && input.facts.homeHasMachines === true && plugin) {
                return { sentence: t('settingsPlugins.surfaces.noMachineRunsPlugin', { plugin }), managePluginId: input.facts.pluginId };
            }
            // No Machine can run it at all: say what to do, and lead to doing it, not "this machine" cannot.
            if (kind === 'unavailable') return { sentence: t('settingsPlugins.targetSelection.noMachine'), addMachine: true };
        }
        // A Machine whose name has not loaded yet is "this machine" in a sentence, never its raw id.
        const machine = input.facts.machineDisplayName?.trim() || t('machine.thisMachineInSentence');
        return { sentence: t('settingsPlugins.surfaces.machineCapabilityUnavailable', { machine }) };
    };
    const describeMachineUnavailable = (diagnostics: readonly string[], request?: PluginUiHostApiRequestEnvelopeV1): string | undefined =>
        describeMachineNotice(diagnostics, request)?.sentence;
    const widgetArea = createPluginWidgetAreaHostHandler({ facts: input.facts, isCurrent, lifetimeSignal: mountLifetime.signal, hostAction, callerBinding,
        isConnectionPending: reason => isConnectionPending([reason]),
        describeUnavailable: (reason) => describeMachineUnavailable([reason]) });
    const hostWidgetArea = createPluginWidgetAreaHostHandler({ facts: input.facts, isCurrent: isInteractionCurrent,
        hostControl: true,
        lifetimeSignal: mountLifetime.signal, callerBinding,
        isConnectionPending: reason => isConnectionPending([reason]),
        describeUnavailable: reason => describeMachineUnavailable([reason]),
        hostAction,
    });
    const createMachineApiBindings = (): PluginSurfaceMachineHostApiBindings => {
        const target = daemon;
        const declaredStore = declaredResourceStore;
        const resourceContext = machineBindingFacts.resourceContext;
        return Object.freeze({
            ...(machineBindingFacts.machineId ? { executionTarget: {
                machineId: machineBindingFacts.machineId, serverId: machineBindingFacts.serverId ?? null,
            } } : {}),
            admissionMethods: isOpenableContentViewer ? [] : PLUGIN_UI_HOST_METHODS_V1.filter(method => {
                if (!isDaemonOwnedPluginSurfaceMethod(method)) return false;
                if (method === 'readResource') return canReadResource;
                if (method === 'watchResource') return canWatchResource;
                return true;
            }),
            allowPluginResources: canWatchResource,
            ...(target ? { contributedAction: {
                machineId: target.machineId, serverId: target.serverId,
                ...(surfaceContext.sessionId ? { sessionId: surfaceContext.sessionId } : {}),
                ...(binding?.executeContributedAction ? { execute: binding.executeContributedAction } : {}),
            } } : {}),
            ...((target || declaredStore) && (canReadResource || target !== null) ? { resource: {
                machineId: target?.machineId ?? null, serverId: target?.serverId ?? accountLifetime?.scope.serverId,
                expectedCallerOccurrenceId: target?.expectedOccurrenceId ?? input.facts.occurrenceId ?? '',
                ...(resourceContext === undefined ? {} : { context: resourceContext }),
                ...(binding?.readResource ? { read: binding.readResource } : {}),
                get store() { return declaredStore?.hasDeclaredNamespace() ? declaredStore : undefined; },
                get contextualFallbackStore() {
                    // Contextual reads belong to the existing Resource store
                    // even before scoped declarations arrive, so replacing
                    // their full input cancels them without retiring Actions.
                    // Legacy watches keep their direct subscription owner.
                    return resourceContext?.kind === 'surface' && !declaredStore?.hasDeclaredNamespace()
                        ? declaredStore ?? (ordinaryResourceStore ??= createOrdinaryResourceStore()) : undefined;
                },
                get refreshOnRead() { return resourceContext?.kind === 'surface' && !declaredStore?.hasDeclaredNamespace(); },
                ...(declaredStore ? { onDeclaredNamespaceAdmission: declaredStore.onDeclaredNamespaceAdmission } : {}),
            } } : {}),
            selectActionInput: createSelectActionInput() ?? undefined,
            createOpenNewSession: createOpenNewSessionBinding() ?? undefined,
            ...(accountLifetime ? { openAutomationEvent: createPluginOpenAutomationEventHostApiHandler({
                accountLifetime, lifetimeSignal: mountLifetime.signal, isCurrent,
            }) } : {}),
        });
    };
    let machineApiBindings = createMachineApiBindings();
    const hostApi = createPluginSurfaceActionHostApi({
        pluginUiProjection: input.facts.pluginUiProjection,
        surfaceContext,
        // The generic host owns these methods even before an execution target
        // exists. Resource declarations retain their own capability ceiling;
        // opaque viewers retain only their concrete file binding's methods.
        readMachineBindings: () => machineApiBindings,
        ...(callerBinding?.sourceCustody ? { callerSourceCustody: callerBinding.sourceCustody } : targetedContributions
            ? { callerSourceCustody: targetedContributions.target.sourceCustody }
            : {}),
        ...(interactionRequester ? { interactionRequester } : {}),
        isMethodAvailable,
        resolveUnavailableError: (error, request) => {
            const sentence = describeMachineUnavailable(error.diagnostics, request);
            if (sentence && !machineNoticeLent) {
                machineNoticeLent = true;
                input.facts.onMachineUnavailable?.(() => describeMachineNotice(error.diagnostics, request));
            }
            const failure = !isConnectionPending(error.diagnostics, request) && isMachineUnavailable(error.diagnostics, request)
                ? input.facts.daemonConnectionFailure : undefined;
            if (failure) return { code: failure.code,
                diagnostics: [...error.diagnostics, failure.reasonCode],
                ...(sentence ? { message: sentence } : {}) };
            return error.message || !sentence ? undefined : { ...error, message: sentence };
        },
        isConnectionPending: (error, request) => isConnectionPending(error.diagnostics, request),
        isContributedActionAvailable: isDaemonInteractionEnabled,
        isCurrent,
        resourceLifetimeSignal: mountLifetime.signal,
        hostAction,
        ...(hostReadResourceStore ? { hostResourceStore: hostReadResourceStore } : {}),
        ...(!isOpenableContentViewer
            ? { resourceInvalidation: { deliver: deliverResourceInvalidation,
                ...(binding?.watchResource ? { transport: binding.watchResource } : {}) } } : {}),
        ...(callerBinding ? { callerBinding } : {}),
        ...(input.facts.resolveContributedAction
            ? { resolveContributedAction: input.facts.resolveContributedAction }
            : {}),
        ...(clientAction ? { clientAction } : {}),
        ...(daemon && binding?.openableContent ? { openableContent: binding.openableContent } : {}),
        ...(binding?.openSurface ? { openSurface: binding.openSurface } : {}),
        readMountedHostApiHandlers: () => ({ ...readHostApiMountedHandlers(), ...(storedImages ? { readStoredImage: storedImages.readStoredImage } : {}), ...(widgetArea ? { widgetArea } : {}) }),
        ...(disposeHostApiMountedHandlers
            ? { disposeMountedHostApiHandlers: disposeHostApiMountedHandlers }
            : {}),
    });
    const dispatchStructuredAction = createBoundPluginSurfaceActionDispatcher({ surfaceContext, hostApi });
    const createActionInputController = () => daemon
        ? createPluginContributedActionController({
            resolveCurrent: () => {
                const current = readActionInputFacts();
                return current.pluginProjectionById ? {
                    pluginProjectionById: current.pluginProjectionById,
                    pluginUiProjection: current.pluginUiProjection,
                    resolveContributedAction: current.resolveContributedAction,
                    host: actionInputHost,
                } : null;
            },
        })
        : null;
    let actionInputController = createActionInputController();
    // Declarative controls have no author-owned form. Omitted input borrows
    // the declared Action's existing no-invoke form owner; explicit input and
    // SDK executeAction requests keep their structured execution semantics.
    const dispatchAction: BoundPluginSurfaceController['dispatchAction'] = async (action, actionInput) => {
        const { pluginProjectionById } = readActionInputFacts();
        const declared = typeof action === 'string' ? undefined
            : pluginProjectionById?.[action.pluginId]?.actions.find(candidate => candidate.id === action.localId);
        if (actionInput !== undefined || typeof action === 'string'
            || !declared?.inputHints?.fields.length || !actionInputController) {
            return await dispatchStructuredAction(action, actionInput);
        }
        if (!isInteractionCurrent() || !isDaemonInteractionEnabled()) {
            return createPluginSurfaceHostApiError('unavailable', ['plugin_mounted_caller_unavailable']);
        }
        if (!declared.occurrenceId) {
            return createPluginSurfaceHostApiError('unavailable', ['action_retired']);
        }
        const selected = await actionInputController.selectExactBoundActionInput({
            action,
            expectedOccurrenceId: declared.occurrenceId,
            invocationSurface: 'ui',
        });
        if (selected.kind === 'unavailable') {
            return createPluginSurfaceHostApiError('unavailable', [selected.reason]);
        }
        if (selected.kind === 'form') {
            presentActionInputForm({ form: selected.form, signal: mountLifetime.signal,
                actionId: buildQualifiedPluginContributionKey(action),
                pickerContext: { machineId: actionInputHost.machineId, serverId: actionInputHost.serverId,
                    sessionId: actionInputHost.sessionId, ...(accountLifetime ? { accountLifetime } : {}) } });
        }
        const result = selected.kind === 'form' ? await selected.result : selected.result;
        if (result.kind === 'cancelled') return null;
        if (result.kind === 'unavailable') {
            return createPluginSurfaceHostApiError('unavailable', [result.reason]);
        }
        const structured = reconstructPluginUiSelectedActionInput(result);
        if (!structured) return createPluginSurfaceHostApiError('invalid_payload', ['select_action_input_result_invalid']);
        return await dispatchStructuredAction(action, structured);
    };
    const applyComposer = createBoundPluginSurfaceComposerApplyDispatcher({ surfaceContext, hostApi });
    const openSurface = createBoundPluginSurfaceOpenDispatcher({ surfaceContext, hostApi });
    const widgetAreaDispatch = createBoundPluginSurfaceWidgetAreaDispatcher({ surfaceContext, hostApi: {
        handleRequest: (request, options) => hostWidgetArea && isInteractionCurrent()
            ? hostWidgetArea(request, options) : hostApi.handleRequest(request, options),
    } });
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
        // Insertion cleanup only fences admission; cancellation can notify mounted React observers.
        mountLifetime.abort();
        notifyRetirement();
        accountRetirement?.dispose();
        parentRetirement?.dispose();
        hostApi.dispose?.();
        resourceStore?.dispose();
        resourceInvalidationListeners.clear();
    };
    accountRetirement = accountLifetime?.onRetire(dispose);
    if (retired) accountRetirement?.dispose();
    parentRetirement = parentLifetime?.onRetire(dispose);
    if (retired) parentRetirement?.dispose();

    let publishedResourceNamespaceKey: string | undefined;
    let publishedDeclaredResourceStore: typeof declaredResourceStore;
    let publishedResourceStore: PluginUiResourceStore | undefined;
    return Object.freeze({
        surfaceContext,
        hostApi,
        get resourceStore() {
            const currentStore = resourceStore;
            if (!currentStore || !declaredResourceStore) return currentStore ?? undefined;
            const namespaceKey = declaredResourceStore.readNamespaceKey();
            if (!publishedResourceStore || publishedResourceNamespaceKey !== namespaceKey
                || publishedDeclaredResourceStore !== declaredResourceStore) {
                publishedResourceNamespaceKey = namespaceKey;
                publishedDeclaredResourceStore = declaredResourceStore;
                // Native hooks reacquire declaration-bound entries when their
                // namespace changes. Bytes, admission and disposal remain with
                // the incumbent store and this physical controller.
                publishedResourceStore = Object.freeze({
                    getEntry: resource => currentStore.getEntry(resource),
                    requiresMachine: resource => currentStore.requiresMachine?.(resource) ?? true,
                    dispose: () => currentStore.dispose(),
                } satisfies PluginUiResourceStore);
            }
            return publishedResourceStore;
        },
        readLiveStreamViewing: (subscriptionId) => liveStreams?.readViewing(subscriptionId) ?? null,
        get installedMethods() { return hostApi.installedMethods; },
        get admissionMethods(): readonly PluginUiHostMethodV1[] {
            return hostApi.admissionMethods;
        },
        interactive: hostApi.installedMethods.length > 0,
        canInteractWithDaemon: () => isInteractionCurrent() && isDaemonInteractionEnabled(false),
        isRequesterAdmitted: () => callerBinding !== null && isInteractionCurrent(),
        subscribeResourceInvalidations: (listener) => {
            resourceInvalidationListeners.add(listener);
            return () => { resourceInvalidationListeners.delete(listener); };
        },
        dispatchAction,
        applyComposer,
        openSurface,
        widgetArea: widgetAreaDispatch,
        isCurrent,
        onRetire,
        retire,
        dispose,
        clearCurrentUiContext,
        updateMountedBindings: next => {
            if (!isCurrent()) return false;
            let changed = false;
            const currentFacts = readActionInputFacts();
            const nextMachineBindingsKey = readMachineBindingsKey(currentFacts);
            if (!isOpenableContentViewer && machineBindingsKey !== nextMachineBindingsKey) {
                const nextAuthorityKey = readMachineAuthorityKey(currentFacts);
                const authorityChanged = machineAuthorityKey !== nextAuthorityKey;
                declaredResourceStore?.dispose();
                ordinaryResourceStore?.dispose();
                ordinaryResourceStore = null;
                machineBindingFacts = currentFacts;
                machineAuthorityKey = nextAuthorityKey;
                machineBindingsKey = nextMachineBindingsKey;
                daemon = resolveDaemonBinding(currentFacts);
                canReadResource = currentFacts.resourceCapability?.readable === true || hasAccountResources();
                canWatchResource = (canReadResource && currentFacts.resourceCapability?.dynamic === true) || hasAccountResources();
                declaredResourceStore = createDeclaredResourceStore();
                resourceStore = hostReadResourceStore ?? declaredResourceStore;
                if (authorityChanged) {
                    liveStreams?.dispose();
                    storedImages?.dispose();
                    liveStreams = createLiveStreams();
                    storedImages = createStoredImages();
                    actionInputHost = createActionInputHost();
                    actionInputController = createActionInputController();
                }
                machineApiBindings = createMachineApiBindings();
                // Commit the canonical handler map here, before the existing
                // single refresh lets presentation read its new method set.
                void hostApi.installedMethods;
                changed = true;
            }
            if (mountedOpenConnectedAccounts !== next.openConnectedAccounts) {
                mountedOpenConnectedAccounts = next.openConnectedAccounts;
                openConnectedAccounts = mountedOpenConnectedAccounts
                    ? createPluginOpenConnectedAccountsHostApiHandler(mountedOpenConnectedAccounts, isCurrent) : undefined;
                changed = true;
            }
            declaredResourceStore?.reconcile();
            if (isOpenableContentViewer || mountedHandlerFactory === next.createMountedHostApiHandlers) return changed;
            disposeMountedBundle();
            mountedHandlerFactory = next.createMountedHostApiHandlers;
            mountedHandlerBundle = mountedHandlerFactory?.({ isCurrent: isInteractionCurrent });
            if (mountedHandlersActivated) mountedHandlerBundle?.activate?.();
            mountedHandlerBundle?.setCurrentUiContextEligibility?.(currentUiContextEligible);
            if (currentUiContextEnrichment) mountedHandlerBundle?.currentUiContext?.publish(currentUiContextEnrichment);
            return true;
        },
        activateMountedHostApiHandlers,
        setCurrentUiContextEligibility,
    });
}

/**
 * Mount-scoped controller. Rebuilt only when a fact that changes what is
 * installable changes — never on an environment refresh — and disposed when the
 * mount retires it, so a `notify` it published or a `confirm` it opened retires
 * with the surface (§3.4) and in-flight daemon work is fenced.
 */
export function useBoundPluginSurfaceController(input: Readonly<{
    facts: BoundPluginSurfaceFacts & Readonly<{ actionInputSelectionFactsKey: PluginActionInputSelectionSnapshot }>;
    binding?: BoundPluginSurfaceBinding;
}>): BoundPluginSurfaceController {
    const facts = input.facts;
    const binding = input.binding;
    // Admission of the exact Account caller changes execution authority. Keep
    // incidental Availability delivery out of the physical lifetime, but do not
    // retain a controller whose captured dispatch binding was still absent.
    const accountCallerAdmitted = facts.accountExecutionOrigin
        ? resolvePluginSurfaceCallerBinding(facts) !== null : null;
    const currentMachineAuthority = readMachineAuthorityKey(facts);
    const machineAuthorityLifetime = React.useRef({
        current: currentMachineAuthority, admitted: false, key: { authority: currentMachineAuthority },
    });
    const committedMachineAuthority = machineAuthorityLifetime.current;
    // An abandoned render cannot replace the committed lifetime key. Initial
    // optional binding delivery stays in place until actual admission; later
    // replacement/withdrawal still proposes a new physical lifetime.
    const renderedMachineAuthority = committedMachineAuthority.current === currentMachineAuthority
        ? committedMachineAuthority
        : { current: currentMachineAuthority, admitted: false,
            key: committedMachineAuthority.admitted ? { authority: currentMachineAuthority } : committedMachineAuthority.key };
    const machineDisplayNameRef = React.useRef(facts.machineDisplayName);
    machineDisplayNameRef.current = facts.machineDisplayName;
    const executionOriginSelectionKindRef = React.useRef(facts.executionOriginSelectionKind);
    executionOriginSelectionKindRef.current = facts.executionOriginSelectionKind;
    const executionOriginRefusalRef = React.useRef(facts.executionOriginRefusal);
    executionOriginRefusalRef.current = facts.executionOriginRefusal;
    const daemonConnectionFailureRef = React.useRef(facts.daemonConnectionFailure);
    daemonConnectionFailureRef.current = facts.daemonConnectionFailure;
    const interactionEnabledRef = React.useRef(facts.interactionEnabled);
    interactionEnabledRef.current = facts.interactionEnabled;
    const isInteractionEnabled = React.useCallback(() => interactionEnabledRef.current, []);
    const contributedActionResolverRef = React.useRef(facts.resolveContributedAction);
    contributedActionResolverRef.current = facts.resolveContributedAction;
    const hasContributedActionResolver = facts.resolveContributedAction !== undefined;
    const resolveContributedAction = React.useCallback<NonNullable<BoundPluginSurfaceFacts['resolveContributedAction']>>(
        identity => contributedActionResolverRef.current?.(identity) ?? null,
        [],
    );
    const executionOriginCurrentRef = React.useRef(binding?.isExecutionOriginCurrent);
    executionOriginCurrentRef.current = binding?.isExecutionOriginCurrent;
    const isExecutionOriginCurrent = React.useCallback<NonNullable<BoundPluginSurfaceBinding['isExecutionOriginCurrent']>>(
        options => executionOriginCurrentRef.current?.(options) !== false, []);
    // A widget mount's frame says the Machine sentence once; any other mount has no frame to lend it to.
    const lendMachineNotice = React.useContext(WidgetFrameBodyNoticeContext);
    const lendMachineNoticeRef = React.useRef(lendMachineNotice);
    lendMachineNoticeRef.current = lendMachineNotice;
    const onMachineUnavailable = React.useCallback(
        (describe: WidgetFrameBodyNoticeSource) => lendMachineNoticeRef.current?.(describe), [],
    );
    const daemonInteractionEnabledRef = React.useRef(facts.daemonInteractionEnabled);
    daemonInteractionEnabledRef.current = facts.daemonInteractionEnabled;
    const isDaemonInteractionEnabled = React.useCallback(
        () => daemonInteractionEnabledRef.current,
        [],
    );
    const daemonConnectionPendingRef = React.useRef(input.facts.isDaemonConnectionPending);
    daemonConnectionPendingRef.current = input.facts.isDaemonConnectionPending;
    const isDaemonConnectionPending = React.useCallback(() => daemonConnectionPendingRef.current?.() === true, []);
    // The mounted source publishes the current selected dependency snapshot;
    // unrelated catalog delivery is not work or a lifetime at this reader.
    const actionInputFactsRef = React.useRef(facts);
    actionInputFactsRef.current = facts;
    const readActionInputFacts = React.useCallback(() => actionInputFactsRef.current, []);
    // Initial admission fills this mount's selector; it does not replace the
    // physical mount or cancel Account reads started before delivery. Once a
    // selectable contract exists, replacement/withdrawal still retires it.
    const selectedActionInputs = facts.actionInputSelectionFactsKey.selected.length === 0
        ? null : facts.actionInputSelectionFactsKey;
    const selectionLifetime = React.useRef({ selection: selectedActionInputs, key: selectedActionInputs });
    if (selectionLifetime.current.selection !== selectedActionInputs) {
        const initialAdmission = selectionLifetime.current.selection === null;
        selectionLifetime.current = { selection: selectedActionInputs,
            key: initialAdmission ? selectionLifetime.current.key : facts.actionInputSelectionFactsKey };
    }
    const actionInputSelectionFactsKey = selectionLifetime.current.key;
    const controller = React.useMemo(
        () => createBoundPluginSurfaceController({
            facts: { ...facts, get machineDisplayName() { return machineDisplayNameRef.current; },
                get executionOriginSelectionKind() { return executionOriginSelectionKindRef.current; },
                get executionOriginRefusal() { return executionOriginRefusalRef.current; },
                get daemonConnectionFailure() { return daemonConnectionFailureRef.current; },
                isDaemonInteractionEnabled, isDaemonConnectionPending, isInteractionEnabled, onMachineUnavailable,
                readActionInputFacts,
                resolveContributedAction: hasContributedActionResolver ? resolveContributedAction : undefined },
            binding: { ...binding, isExecutionOriginCurrent },
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
            facts.accountExecutionOrigin ? null : facts.machineId,
            facts.serverId,
            facts.sessionId,
            facts.targetAuthorityKey,
            // Validation may reconstruct equal custody on a new descriptor.
            // Custody facts, not that allocation, identify the controller.
            stableJsonStringify(facts.targetSourceCustody ?? null),
            facts.occurrenceId,
            facts.accountExecutionOrigin ? renderedMachineAuthority.key : facts.daemonOccurrenceId,
            stableJsonStringify(facts.accountExecutionOrigin ?? null),
            accountCallerAdmitted,
            facts.readCurrentUiContext,
            facts.accountExecutionOrigin ? null : stableJsonStringify(facts.executionOrigin ?? null),
            facts.accountExecutionOrigin ? null : facts.resourceCapability?.readable,
            facts.accountExecutionOrigin ? null : facts.resourceCapability?.dynamic,
            facts.accountLifetime,
            facts.parentLifetime,
            facts.isHostCurrent,
            facts.mountInstanceKey,
            actionInputSelectionFactsKey,
            readActionInputFacts,
            hasContributedActionResolver,
            resolveContributedAction,
            joinResourceScope(facts.resourceScope),
            binding?.executeHostAction,
            binding?.openSurface,
            binding?.executeContributedAction,
            binding?.readResource,
            binding?.watchResource,
            binding?.openableContent,
            binding?.mountedHostApiHandlers,
            binding?.disposeMountedHostApiHandlers,
        ],
    );
    React.useEffect(() => () => lendMachineNoticeRef.current?.(null), [controller]);
    useUiSurfaceOwnerLifetime(controller);
    const [, refreshMountedBindings] = React.useReducer((revision: number) => revision + 1, 0);
    const machineInteractionReady = facts.accountExecutionOrigin !== undefined && facts.accountExecutionOrigin !== null
        && controller.canInteractWithDaemon();
    React.useLayoutEffect(() => {
        const changed = controller.updateMountedBindings?.({ createMountedHostApiHandlers: binding?.createMountedHostApiHandlers,
            openConnectedAccounts: binding?.openConnectedAccounts });
        machineAuthorityLifetime.current = renderedMachineAuthority;
        // A cached lease is not interaction admission. Remember the canonical
        // controller's positive committed fact, and retain it through later
        // readiness loss until the authority key itself changes.
        if (facts.accountExecutionOrigin && controller.canInteractWithDaemon()) renderedMachineAuthority.admitted = true;
        if (changed) {
            // The physical Host captured the previous presentation binding
            // during render. Read the new committed bundle once; the unchanged
            // factory on that render makes this update settle immediately.
            refreshMountedBindings();
        }
    }, [controller, binding?.createMountedHostApiHandlers, binding?.openConnectedAccounts,
        facts.pluginUiProjection?.resourcesById, facts.resourceDeclarations,
        readMachineBindingsKey(facts), renderedMachineAuthority, machineInteractionReady]);
    React.useLayoutEffect(() => {
        // A mounted-handler factory runs during render to contribute its
        // methods, but external registration remains a committed layout
        // effect. The exact mounted bundle makes replayed activation idempotent.
        controller.activateMountedHostApiHandlers?.();
    }, [controller]);
    const connectionPending = facts.isDaemonConnectionPending?.() === true;
    React.useLayoutEffect(() => {
        if (!connectionPending) controller.hostApi.notifyConnectionSettled?.();
    }, [controller, connectionPending, facts.daemonInteractionEnabled]);
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
