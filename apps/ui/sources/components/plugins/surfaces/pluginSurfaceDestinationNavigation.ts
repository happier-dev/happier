import * as React from 'react';
import {
    isPluginUiDestinationBindingAdmittedAtRuntimeV1,
    type PluginUiDestinationRuntimeFormFactorV1,
    type PluginUiContainerV1,
    type PluginUiDestinationReferenceV1,
    type PluginUiInstanceKeyV1,
    type PluginUiLaunchInputV1,
    type PluginUiPlatformV1,
    type PluginUiTargetKindV1,
} from '@happier-dev/protocol/plugins/ui';

import type {
    PluginSurfaceOpenHandler,
    PluginSurfaceOpenOutcome,
    PluginSurfaceOpenRequest,
} from './openPluginSurface';
import {
    resolvePluginSurfaceLaunchAuthority,
    isSamePluginSurfaceLaunchAuthority,
    type PluginSurfaceLaunchAuthority,
    type PluginSurfaceScopedLaunchFacts,
} from './pluginSurfaceLaunchAuthority';
import {
    createPluginSurfaceLaunchInputStore,
    type PluginSurfaceLaunchInputStore,
} from './pluginSurfaceLaunchInputStore';
import { canRenderPluginUiProjectionEntry, type PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type {
    PluginUiDestinationProjection,
    PluginUiSettingsPageProjection,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

/**
 * The one normalized result of an admitted `openSurface` destination lookup.
 *
 * It deliberately carries the Registry projection rather than a caller-built
 * target/container copy. A page, Settings route, AppPane, sidebar, or cockpit
 * adapter may only perform the incumbent action for this exact binding; none
 * may re-select a different destination from a local catalog or fall back to
 * another container.
 */
export type PluginSurfaceDestinationOpenResolution<
    TDestination extends PluginUiDestinationProjection = PluginUiSurfacePlacementProjection,
> = Readonly<{
    ok: true;
    request: PluginSurfaceOpenRequest;
    /**
     * Retains the incumbent name for container adapters, but can be either a
     * surface placement or a Settings-page projection. Both are exact Registry
     * destinations; only their incumbent container owners differ.
     */
    placement: TDestination;
    authority: PluginSurfaceLaunchAuthority;
}>;

export type PluginSurfaceDestinationOpenResult<
    TDestination extends PluginUiDestinationProjection = PluginUiDestinationProjection,
> =
    | PluginSurfaceDestinationOpenResolution<TDestination>
    | Extract<PluginSurfaceOpenOutcome, Readonly<{ ok: false }>>;

export type PluginSurfaceDestinationContainerHandler<
    TDestination extends PluginUiDestinationProjection = PluginUiSurfacePlacementProjection,
> = (
    resolution: PluginSurfaceDestinationOpenResolution<TDestination>,
) => PluginSurfaceOpenOutcome | Promise<PluginSurfaceOpenOutcome>;

type PluginSurfacePlacementContainer = Exclude<PluginUiContainerV1, 'settingsPage'>;

/**
 * The handler map preserves the Registry's contribution-family boundary.
 * Existing pane/page adapters can only receive placements, while the one
 * Settings adapter can only receive a Settings-page projection.
 */
export type PluginSurfaceDestinationContainerHandlers = Readonly<{
    settingsPage?: PluginSurfaceDestinationContainerHandler<PluginUiSettingsPageProjection>;
}> & Partial<Record<
    PluginSurfacePlacementContainer,
    PluginSurfaceDestinationContainerHandler<PluginUiSurfacePlacementProjection>
>>;

/**
 * Current host facts consumed directly by the Protocol-owned admission
 * predicate. They are deliberately observed by each mounted owner; this
 * navigation module does not infer a platform or device class itself.
 */
export type PluginSurfaceDestinationRuntimeAdmission = Readonly<{
    platform: PluginUiPlatformV1;
    formFactor: PluginUiDestinationRuntimeFormFactorV1;
}>;

export type PluginSurfaceDestinationOpenSurfaceHandlerInput = Readonly<{
    /** The current normalized surface-placement records this host scope may expose. */
    placements: readonly PluginUiSurfacePlacementProjection[] | null | undefined;
    /**
     * The current normalized Settings-page records for the same app projection.
     * They join the one qualified resolver; the Settings catalog remains their
     * route owner and is not reconstructed here.
     */
    settingsPages?: readonly PluginUiSettingsPageProjection[] | null | undefined;
    /** The exact host-stamped public target; never parsed from a pane scope id. */
    targetKind: PluginUiTargetKindV1;
    /** Existing Account lifetime; a stale realm cannot begin a handoff. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
    /** Required for direct Session/Project scopes that have no app-union origin. */
    scopedLaunchFacts?: PluginSurfaceScopedLaunchFacts | null;
    policyContext?: PluginUiPolicyEvaluationContext;
    /**
     * Present for mounted runtime owners so unsupported phone destinations are
     * rejected before an incumbent container can stage selection or input.
     */
    runtimeAdmission?: PluginSurfaceDestinationRuntimeAdmission;
    /**
     * The enclosing scope's `openSurface`, when this scope is mounted inside
     * one.
     *
     * A destination's `targetKind` is a registry slot fact, so the target
     * scopes PARTITION the destination space: `appPage`, `settingsPage` and the
     * app `rightSidebarTab` are admitted at the `app` target only, and their
     * incumbent route/sidebar owners consequently register with the app-scope
     * binding. Without this, a Session/Project mount could never reach any of
     * them, which is exactly what a Composer "View details" needs.
     *
     * It is a scope handoff, not a fallback chain: only
     * `plugin_surface_open_destination_unknown` — "no destination with this
     * qualified reference belongs to my target at all" — is handed on. Every
     * other outcome, including an ambiguous, unavailable, retired or
     * owner-less destination that IS this scope's, is returned as-is, so a
     * refusal can never be laundered into a second attempt elsewhere.
     */
    enclosingOpenSurface?: PluginSurfaceOpenHandler | null;
    /**
     * Incumbent navigation owners, indexed by their normalized container.
     * Omission is deliberate: an unavailable adapter is never substituted by
     * a page, pane, or another selected plugin surface.
     */
    handlers: PluginSurfaceDestinationContainerHandlers;
}>;

/**
 * One target-scoped binding consumes the normalized projection and delegates
 * only to registered incumbent owners. It owns neither a router nor pane
 * persistence, launch input, admission, collision, or target reconstruction.
 */
export type PluginSurfaceDestinationNavigationBindingInput = Omit<
    PluginSurfaceDestinationOpenSurfaceHandlerInput,
    'handlers'
>;

type PluginSurfaceDestinationPlacementOwner = {
    [Container in PluginSurfacePlacementContainer]: Readonly<{
        container: Container;
        handler: PluginSurfaceDestinationContainerHandler<PluginUiSurfacePlacementProjection>;
    }>;
}[PluginSurfacePlacementContainer];

export type PluginSurfaceDestinationNavigationOwner =
    | Readonly<{
        container: 'settingsPage';
        handler: PluginSurfaceDestinationContainerHandler<PluginUiSettingsPageProjection>;
    }>
    | PluginSurfaceDestinationPlacementOwner;

export type PluginSurfaceDestinationNavigationBinding = Readonly<{
    /**
     * The exact host target this binding resolves destinations for.
     *
     * Target scopes PARTITION the destination space, so a mount whose public
     * surface context declares a DIFFERENT target must not consume this
     * resolver: doing so would give, say, a Services panel the enclosing
     * Session's navigation authority. Consumers compare this against their own
     * target and omit `openSurface` when it does not match.
     */
    readonly targetKind: PluginUiTargetKindV1;
    openSurface: PluginSurfaceOpenHandler;
    /**
     * Existing route/pane/details/settings owners register their exact
     * container adapter. More than one active adapter for a container is a
     * truthful unavailable result, never a last-registered winner.
     */
    registerOwner: (owner: PluginSurfaceDestinationNavigationOwner) => () => void;
}>;

function unavailable(reason: string): Extract<PluginSurfaceOpenOutcome, Readonly<{ ok: false }>> {
    return { ok: false, code: 'unavailable', reason };
}

/**
 * "No destination with this qualified reference belongs to my target at all."
 *
 * It is the ONLY refusal an enclosing scope may be asked to answer instead,
 * because it is the only one that says nothing about the destination itself.
 * Ambiguity, unavailability, a retired origin and a missing owner are all
 * facts about a destination this scope does own, and handing those on would
 * turn one truthful refusal into a search.
 */
function isDestinationOutsideTargetScope(
    outcome: Extract<PluginSurfaceOpenOutcome, Readonly<{ ok: false }>>,
): boolean {
    return outcome.code === 'unavailable'
        && outcome.reason === 'plugin_surface_open_destination_unknown';
}

function isExactDestination(
    placement: PluginUiDestinationProjection,
    request: PluginSurfaceOpenRequest,
    targetKind: PluginUiTargetKindV1,
): boolean {
    return placement.binding.targetKind === targetKind
        && placement.binding.destination.pluginId === request.destination.pluginId
        && placement.binding.destination.localId === request.destination.localId;
}

/**
 * Resolve one qualified destination exactly once for all mounted callers.
 *
 * The prior App sidebar chose a right-sidebar tab first and then retried a
 * page. That made container order an unacknowledged authority. Here an exact
 * target either has one admitted current binding or it is rejected; individual
 * adapters only execute the established owner action.
 */
export function resolvePluginSurfaceDestinationOpen(input: Omit<
    PluginSurfaceDestinationOpenSurfaceHandlerInput,
    // Resolution answers only "is this destination mine?". Handing a scope
    // handoff to the resolver would make it a second navigation decision-maker.
    'handlers' | 'enclosingOpenSurface'
> & Readonly<{
    request: PluginSurfaceOpenRequest;
}>): PluginSurfaceDestinationOpenResult<PluginUiDestinationProjection> {
    const matches = [
        ...(input.placements ?? []),
        ...(input.settingsPages ?? []),
    ].filter((placement) => (
        isExactDestination(placement, input.request, input.targetKind)
    ));
    if (matches.length === 0) {
        return unavailable('plugin_surface_open_destination_unknown');
    }
    // A qualified reference deliberately does not include a container. The
    // registry must make the pair singular; caller/catalog declaration order
    // is not a tie-breaker.
    if (matches.length !== 1) {
        return unavailable('plugin_surface_open_destination_ambiguous');
    }
    const placement = matches[0]!;
    if (
        input.runtimeAdmission
        && !isPluginUiDestinationBindingAdmittedAtRuntimeV1({
            binding: placement.binding,
            ...input.runtimeAdmission,
        })
    ) {
        return unavailable('plugin_surface_open_destination_platform_unavailable');
    }
    if (placement.availability.state !== 'available') {
        return unavailable(placement.availability.reason);
    }
    if (!canRenderPluginUiProjectionEntry(placement, input.policyContext)) {
        return unavailable('plugin_surface_open_destination_policy_unavailable');
    }
    // Only the route owner has a bounded plugin-local sub-path grammar. A
    // pane/cockpit/details adapter must reject it rather than silently losing
    // a caller-visible location while still reporting navigation success.
    if (placement.binding.container !== 'appPage' && input.request.subPath !== undefined) {
        return {
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_open_sub_path_unsupported',
        };
    }
    // Settings owns a restorable route, but it has no pending launch-input
    // carrier. Reject a supplied value at the one resolver rather than routing
    // successfully and silently losing caller data or inventing a second store.
    if (placement.binding.container === 'settingsPage' && input.request.input !== undefined) {
        return {
            ok: false,
            code: 'unsupported_method',
            reason: 'plugin_surface_open_launch_input_unsupported',
        };
    }
    if (
        (placement.binding.instancePolicy === 'singleton' && input.request.instanceKey !== undefined)
        || (placement.binding.instancePolicy === 'multiple' && input.request.instanceKey === undefined)
    ) {
        return {
            ok: false,
            code: 'invalid_payload',
            reason: 'plugin_surface_open_instance_key_unsupported',
        };
    }
    const authority = resolvePluginSurfaceLaunchAuthority({
        placement,
        accountLifetime: input.accountLifetime ?? null,
        scoped: input.scopedLaunchFacts,
    });
    if (!authority) {
        return unavailable('plugin_surface_open_origin_unavailable');
    }
    return Object.freeze({
        ok: true,
        request: input.request,
        placement,
        authority,
    });
}

function isSettingsPageResolution(
    resolution: PluginSurfaceDestinationOpenResolution<PluginUiDestinationProjection>,
): resolution is PluginSurfaceDestinationOpenResolution<PluginUiSettingsPageProjection> {
    return resolution.placement.contributionKind === 'settingsPage'
        && resolution.placement.binding.container === 'settingsPage';
}

function isSurfacePlacementResolution(
    resolution: PluginSurfaceDestinationOpenResolution<PluginUiDestinationProjection>,
): resolution is PluginSurfaceDestinationOpenResolution<PluginUiSurfacePlacementProjection> {
    return resolution.placement.contributionKind === 'surfacePlacement';
}

/**
 * Construct the only mounted `openSurface` handler for a target scope.
 *
 * The handler does no caller-local destination normalization. It calls the
 * one exact resolver above, then delegates to the single existing container
 * owner selected by the normalized binding.
 */
export function createPluginSurfaceDestinationOpenSurfaceHandler(
    input: PluginSurfaceDestinationOpenSurfaceHandlerInput,
): PluginSurfaceOpenHandler {
    return async (request) => {
        const resolved = resolvePluginSurfaceDestinationOpen({
            placements: input.placements,
            ...(input.settingsPages === undefined ? {} : { settingsPages: input.settingsPages }),
            targetKind: input.targetKind,
            ...(input.accountLifetime === undefined ? {} : { accountLifetime: input.accountLifetime }),
            ...(input.scopedLaunchFacts === undefined ? {} : { scopedLaunchFacts: input.scopedLaunchFacts }),
            ...(input.policyContext === undefined ? {} : { policyContext: input.policyContext }),
            ...(input.runtimeAdmission === undefined ? {} : { runtimeAdmission: input.runtimeAdmission }),
            request,
        });
        if (!resolved.ok) {
            return input.enclosingOpenSurface && isDestinationOutsideTargetScope(resolved)
                ? await input.enclosingOpenSurface(request)
                : resolved;
        }
        if (isSettingsPageResolution(resolved)) {
            const handler = input.handlers.settingsPage;
            if (!handler) {
                return unavailable('plugin_surface_open_destination_owner_unavailable');
            }
            return await handler(resolved);
        }
        if (!isSurfacePlacementResolution(resolved)) {
            return unavailable('plugin_surface_open_destination_owner_unavailable');
        }
        const container = resolved.placement.binding.container;
        if (container === 'settingsPage') {
            return unavailable('plugin_surface_open_destination_owner_unavailable');
        }
        const handler = input.handlers[container];
        if (!handler) {
            return unavailable('plugin_surface_open_destination_owner_unavailable');
        }
        return await handler(resolved);
    };
}

type RegisteredPluginSurfaceDestinationOwner = (
    resolution: PluginSurfaceDestinationOpenResolution<PluginUiDestinationProjection>,
) => PluginSurfaceOpenOutcome | Promise<PluginSurfaceOpenOutcome>;

function createPluginSurfaceDestinationNavigationBindingFromReader(
    readInput: () => PluginSurfaceDestinationNavigationBindingInput,
): PluginSurfaceDestinationNavigationBinding {
    const ownersByContainer = new Map<
        PluginUiContainerV1,
        Set<RegisteredPluginSurfaceDestinationOwner>
    >();

    const registerOwner = (owner: PluginSurfaceDestinationNavigationOwner): (() => void) => {
        const delegate: RegisteredPluginSurfaceDestinationOwner = async (resolution) => {
            if (owner.container === 'settingsPage') {
                if (!isSettingsPageResolution(resolution)) {
                    return unavailable('plugin_surface_open_destination_owner_unavailable');
                }
                return await owner.handler(resolution);
            }
            if (
                !isSurfacePlacementResolution(resolution)
                || resolution.placement.binding.container !== owner.container
            ) {
                return unavailable('plugin_surface_open_destination_owner_unavailable');
            }
            return await owner.handler(resolution);
        };
        const current = ownersByContainer.get(owner.container) ?? new Set<RegisteredPluginSurfaceDestinationOwner>();
        current.add(delegate);
        ownersByContainer.set(owner.container, current);
        return () => {
            const active = ownersByContainer.get(owner.container);
            if (!active) return;
            active.delete(delegate);
            if (active.size === 0) ownersByContainer.delete(owner.container);
        };
    };

    const openSurface: PluginSurfaceOpenHandler = async (request) => {
        const input = readInput();
        const resolved = resolvePluginSurfaceDestinationOpen({
            placements: input.placements,
            ...(input.settingsPages === undefined ? {} : { settingsPages: input.settingsPages }),
            targetKind: input.targetKind,
            ...(input.accountLifetime === undefined ? {} : { accountLifetime: input.accountLifetime }),
            ...(input.scopedLaunchFacts === undefined ? {} : { scopedLaunchFacts: input.scopedLaunchFacts }),
            ...(input.policyContext === undefined ? {} : { policyContext: input.policyContext }),
            ...(input.runtimeAdmission === undefined ? {} : { runtimeAdmission: input.runtimeAdmission }),
            request,
        });
        if (!resolved.ok) {
            return input.enclosingOpenSurface && isDestinationOutsideTargetScope(resolved)
                ? await input.enclosingOpenSurface(request)
                : resolved;
        }
        const container = resolved.placement.binding.container;
        const owners = ownersByContainer.get(container);
        if (!owners || owners.size !== 1) {
            return unavailable('plugin_surface_open_destination_owner_unavailable');
        }
        const owner = owners.values().next().value as RegisteredPluginSurfaceDestinationOwner | undefined;
        return owner
            ? await owner(resolved)
            : unavailable('plugin_surface_open_destination_owner_unavailable');
    };

    // A scope host keeps one binding identity while its facts change, so the
    // target is read at access time from the same reader the resolver uses.
    return Object.freeze({
        get targetKind() { return readInput().targetKind; },
        openSurface,
        registerOwner,
    });
}

/**
 * Assemble the one navigation binding for a concrete host target. Callers add
 * incumbent owners through `registerOwner`; a container-local handler map is
 * not a decision boundary on this API.
 */
export function createPluginSurfaceDestinationNavigationBinding(
    input: PluginSurfaceDestinationNavigationBindingInput,
): PluginSurfaceDestinationNavigationBinding {
    return createPluginSurfaceDestinationNavigationBindingFromReader(() => input);
}

const PluginSurfaceDestinationNavigationBindingContext = React.createContext<
    PluginSurfaceDestinationNavigationBinding | null
>(null);

export function PluginSurfaceDestinationNavigationBindingProvider(props: Readonly<{
    binding: PluginSurfaceDestinationNavigationBinding | null | undefined;
    children?: React.ReactNode;
}>): React.ReactElement {
    return React.createElement(
        PluginSurfaceDestinationNavigationBindingContext.Provider,
        { value: props.binding ?? null },
        props.children,
    );
}

/** The target-scope binding installed by the host, if this surface has one. */
export function usePluginSurfaceDestinationNavigationBinding(): PluginSurfaceDestinationNavigationBinding | null {
    return React.useContext(PluginSurfaceDestinationNavigationBindingContext);
}

/**
 * A scope host keeps one binding identity while its current projection facts
 * change. The binding reads those latest facts at invocation time, so an
 * escaped callback cannot recover an older Account, projection, or target.
 */
export function usePluginSurfaceDestinationNavigationBindingForScope(
    input: PluginSurfaceDestinationNavigationBindingInput,
): PluginSurfaceDestinationNavigationBinding {
    const inputRef = React.useRef(input);
    inputRef.current = input;
    const bindingRef = React.useRef<PluginSurfaceDestinationNavigationBinding | null>(null);
    if (!bindingRef.current) {
        bindingRef.current = createPluginSurfaceDestinationNavigationBindingFromReader(() => inputRef.current);
    }
    return bindingRef.current;
}

/** Register one incumbent owner with the binding supplied by its target host. */
export function useRegisterPluginSurfaceDestinationNavigationOwner(
    owner: PluginSurfaceDestinationNavigationOwner | null | undefined,
    binding?: PluginSurfaceDestinationNavigationBinding | null,
): void {
    const contextualBinding = usePluginSurfaceDestinationNavigationBinding();
    const effectiveBinding = binding ?? contextualBinding;
    React.useEffect(() => {
        if (!effectiveBinding || !owner) return;
        return effectiveBinding.registerOwner(owner);
    }, [effectiveBinding, owner]);
}

/**
 * Ephemeral input for a selected AppPane/sidebar destination. The selection
 * itself remains AppPane state; this record is deliberately private and is
 * removed as soon as its exact current mount receives it.
 */
export type PluginSurfacePaneLaunch = Readonly<{
    authority: PluginSurfaceLaunchAuthority;
    targetKind: Extract<PluginUiTargetKindV1, 'app' | 'session' | 'project'>;
    container: Extract<PluginUiContainerV1, 'rightPane' | 'rightSidebarTab' | 'bottomPane'>;
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
    input: PluginUiLaunchInputV1 | undefined;
}>;

export type PluginSurfacePaneLaunchStore = PluginSurfaceLaunchInputStore<PluginSurfacePaneLaunch>;

/** Host-private identity; launch JSON never affects a pane selection or key. */
export function buildPluginSurfacePaneLaunchKey(input: Readonly<{
    container: PluginSurfacePaneLaunch['container'];
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>): string {
    return [
        'plugin-surface-pane',
        input.container,
        encodeURIComponent(input.destination.pluginId),
        encodeURIComponent(input.destination.localId),
        input.instanceKey === undefined ? 'singleton' : `instance-${encodeURIComponent(input.instanceKey)}`,
    ].join(':');
}

export function createPluginSurfacePaneLaunchStore(): PluginSurfacePaneLaunchStore {
    return createPluginSurfaceLaunchInputStore<PluginSurfacePaneLaunch>((launch) => (
        buildPluginSurfacePaneLaunchKey(launch)
    ));
}

type PluginSurfacePaneLaunchScopeValue = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    store: PluginSurfacePaneLaunchStore;
}>;

const PluginSurfacePaneLaunchScopeContext = React.createContext<PluginSurfacePaneLaunchScopeValue | null>(null);

/**
 * One ephemeral handoff scope for a host-owned pane or cockpit surface.
 *
 * This is deliberately narrower than AppPane state: it holds no selection,
 * target, geometry, route, or persistence. It only lets the incumbent pane
 * owner carry one already-admitted launch input across a host selection or a
 * cockpit scene transition, and retires that value with the shared Account
 * lifetime.
 */
export function PluginSurfacePaneLaunchScope(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const [store] = React.useState(createPluginSurfacePaneLaunchStore);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [, refreshAfterAccountRetirement] = React.useReducer((revision: number) => revision + 1, 0);

    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(() => {
            store.retire();
            refreshAfterAccountRetirement();
        });
        return () => retirement?.dispose();
    }, [accountLifetime, store]);
    React.useEffect(() => () => { store.retire(); }, [store]);

    const value = React.useMemo(
        () => Object.freeze({ accountLifetime, store }),
        [accountLifetime, store],
    );
    return React.createElement(
        PluginSurfacePaneLaunchScopeContext.Provider,
        { value },
        props.children,
    );
}

/**
 * A container consumes this when a surrounding host owns its pane/cockpit
 * lifetime. A standalone route may establish the same generic scope at its
 * route boundary; no module-global or destination-local fallback exists.
 */
export function usePluginSurfacePaneLaunchScope(): PluginSurfacePaneLaunchScopeValue | null {
    return React.useContext(PluginSurfacePaneLaunchScopeContext);
}

function hasExactInstanceShape(
    placement: PluginUiDestinationProjection,
    instanceKey: PluginUiInstanceKeyV1 | undefined,
): boolean {
    return placement.binding.instancePolicy === 'multiple'
        ? instanceKey !== undefined
        : instanceKey === undefined;
}

/**
 * Stage the private handoff only after the common resolver selected a current
 * pane binding. This never writes the opaque input into AppPane state.
 */
export function stagePluginSurfacePaneLaunch(input: Readonly<{
    store: PluginSurfacePaneLaunchStore;
    resolution: PluginSurfaceDestinationOpenResolution;
}>): boolean {
    const container = input.resolution.placement.binding.container;
    const targetKind = input.resolution.placement.binding.targetKind;
    if (
        (container !== 'rightPane' && container !== 'rightSidebarTab' && container !== 'bottomPane')
        || (targetKind !== 'app' && targetKind !== 'session' && targetKind !== 'project')
        || !hasExactInstanceShape(input.resolution.placement, input.resolution.request.instanceKey)
    ) {
        return false;
    }
    return input.store.stage(Object.freeze({
        authority: input.resolution.authority,
        targetKind,
        container,
        destination: Object.freeze({ ...input.resolution.placement.binding.destination }),
        ...(input.resolution.request.instanceKey === undefined
            ? {}
            : { instanceKey: input.resolution.request.instanceKey }),
        input: input.resolution.request.input,
    }));
}

export function resolvePluginSurfacePaneLaunch(input: Readonly<{
    store: PluginSurfacePaneLaunchStore;
    authority: PluginSurfaceLaunchAuthority | null;
    targetKind: PluginSurfacePaneLaunch['targetKind'];
    container: PluginSurfacePaneLaunch['container'];
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>): PluginSurfacePaneLaunch | null {
    if (!input.authority) return null;
    const launch = input.store.peek({
        authority: input.authority,
        handoffKey: buildPluginSurfacePaneLaunchKey(input),
    });
    return launch
        && launch.targetKind === input.targetKind
        && launch.container === input.container
        && launch.destination.pluginId === input.destination.pluginId
        && launch.destination.localId === input.destination.localId
        && launch.instanceKey === input.instanceKey
        && isSamePluginSurfaceLaunchAuthority(launch.authority, input.authority)
        ? launch
        : null;
}

/**
 * Take an AppPane/sidebar handoff at one selected mount. A fresh open with
 * `undefined` input remains an explicit replacement; a changed authority,
 * target, container, destination, or instance drops the old value.
 */
export function usePluginSurfacePaneLaunch(input: Readonly<{
    store: PluginSurfacePaneLaunchStore;
    placement: PluginUiSurfacePlacementProjection | null;
    targetKind: PluginSurfacePaneLaunch['targetKind'];
    container: PluginSurfacePaneLaunch['container'];
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    scopedLaunchFacts?: PluginSurfaceScopedLaunchFacts | null;
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>): PluginSurfacePaneLaunch | null {
    const authority = React.useMemo(() => (
        input.placement
            ? resolvePluginSurfaceLaunchAuthority({
                placement: input.placement,
                accountLifetime: input.accountLifetime,
                ...(input.scopedLaunchFacts === undefined ? {} : { scoped: input.scopedLaunchFacts }),
            })
            : null
    ), [input.accountLifetime, input.placement, input.scopedLaunchFacts]);
    const handoffKey = React.useMemo(() => buildPluginSurfacePaneLaunchKey({
        container: input.container,
        destination: input.destination,
        ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
    }), [input.container, input.destination, input.instanceKey]);
    const subscribe = React.useCallback((onStoreChange: () => void) => (
        input.store.subscribe(onStoreChange)
    ), [input.store]);
    const getSnapshot = React.useCallback(() => resolvePluginSurfacePaneLaunch({
        store: input.store,
        authority,
        targetKind: input.targetKind,
        container: input.container,
        destination: input.destination,
        ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
    }), [authority, input.container, input.destination, input.instanceKey, input.store, input.targetKind]);
    const staged = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [delivered, setDelivered] = React.useState<PluginSurfacePaneLaunch | null>(null);
    const deliveredIsCurrent = delivered !== null
        && authority !== null
        && delivered.targetKind === input.targetKind
        && delivered.container === input.container
        && delivered.destination.pluginId === input.destination.pluginId
        && delivered.destination.localId === input.destination.localId
        && delivered.instanceKey === input.instanceKey
        && isSamePluginSurfaceLaunchAuthority(delivered.authority, authority);

    React.useEffect(() => {
        input.store.retireHandoffIfAuthorityChanged({ authority, handoffKey });
    }, [authority, handoffKey, input.store]);
    React.useEffect(() => {
        if (!staged) return;
        setDelivered(staged);
        input.store.settle(staged);
    }, [input.store, staged]);
    React.useEffect(() => {
        if (delivered !== null && !deliveredIsCurrent) setDelivered(null);
    }, [delivered, deliveredIsCurrent]);

    return staged ?? (deliveredIsCurrent ? delivered : null);
}
