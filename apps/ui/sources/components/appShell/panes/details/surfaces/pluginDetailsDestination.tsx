import * as React from 'react';
import { I18nManager, Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { resolveHappierTabKeySelection } from '@happier-dev/plugin-ui/presentation';
import {
    isPluginUiDestinationBindingAdmittedAtRuntimeV1,
    PluginUiInstanceKeyV1Schema,
    PluginUiLaunchInputV1Schema,
    type PluginUiDestinationReferenceV1,
    type PluginUiInstanceKeyV1,
    type PluginUiLaunchInputV1,
    type PluginUiTargetKindV1,
} from '@happier-dev/protocol/plugins/ui';
import { z } from 'zod';

import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import {
    isSamePluginSurfaceLaunchAuthority,
    resolvePluginSurfaceLaunchAuthority,
    type PluginSurfaceLaunchAuthority,
    type PluginSurfaceScopedLaunchFacts,
} from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import {
    createPluginSurfaceLaunchInputStore,
    type PluginSurfaceLaunchInputStore,
} from '@/components/plugins/surfaces/pluginSurfaceLaunchInputStore';
import type {
    PluginSurfaceOpenHandler,
    PluginSurfaceOpenOutcome,
} from '@/components/plugins/surfaces/openPluginSurface';
import { resolvePluginSurfaceDestinationLabel } from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import {
    createPluginSurfaceDestinationOpenSurfaceHandler,
    usePluginSurfaceDestinationNavigationBinding,
    type PluginSurfaceDestinationContainerHandler,
    type PluginSurfaceDestinationOpenResolution,
    type PluginSurfaceDestinationRuntimeAdmission,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import {
    canRenderPluginUiProjectionEntry,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import type {
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import {
    selectPluginDestinationSurfacePlacements,
    selectPluginSurfacePlacementsByDestination,
} from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';

import type { DetailsTab } from '../workspace/detailsWorkspaceTypes';
import { PersistedPluginUiDestinationReferenceV1Schema } from '../../model/selectedPaneDestination';
import { DetailsSurfaceFallback } from './DetailsSurfaceFallback';
import type {
    DetailsSurfaceHostCallbacksV1,
    DetailsSurfaceRenderInputV1,
    DetailsSurfaceRendererV1,
} from './types';

/**
 * The only durable identity for a qualified plugin details destination.
 *
 * Runtime origin, target, launch input, and opaque content context are all
 * current mount facts. They must be resolved by the Details surface adapter
 * after restoration instead of becoming tab-resource persistence.
 */
export const PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND = 'pluginDetailsDestination';

export type PluginDetailsDestinationResourceV1 = Readonly<{
    kind: typeof PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND;
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>;

export const PluginDetailsDestinationResourceV1Schema = z.object({
    kind: z.literal(PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND),
    destination: PersistedPluginUiDestinationReferenceV1Schema,
    instanceKey: PluginUiInstanceKeyV1Schema.optional(),
}).strip();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a resource claims the generic plugin-details namespace. */
export function isPluginDetailsDestinationResourceCandidate(value: unknown): boolean {
    return isRecord(value) && value.kind === PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND;
}

/**
 * Parse and clone a durable resource at the Details persistence boundary.
 * Unknown fields deliberately do not survive the strict Protocol-owned shape.
 */
export function normalizePluginDetailsDestinationResource(
    value: unknown,
): PluginDetailsDestinationResourceV1 | null {
    const parsed = PluginDetailsDestinationResourceV1Schema.safeParse(value);
    if (!parsed.success) return null;
    return Object.freeze({
        kind: PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND,
        destination: Object.freeze({ ...parsed.data.destination }),
        ...(parsed.data.instanceKey === undefined ? {} : { instanceKey: parsed.data.instanceKey }),
    });
}

export function createPluginDetailsDestinationResource(input: Readonly<{
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>): PluginDetailsDestinationResourceV1 {
    return Object.freeze({
        kind: PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND,
        destination: Object.freeze({ ...input.destination }),
        ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
    });
}

/**
 * Host tab identity is derived solely from the qualified destination and its
 * explicitly bounded instance discriminator. Delimited segments are encoded so
 * a plugin-provided identifier cannot collide with the host's key grammar.
 */
export function buildPluginDetailsDestinationTabKey(input: Readonly<{
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>): string {
    const instance = input.instanceKey === undefined
        ? 'singleton'
        : `instance-${encodeURIComponent(input.instanceKey)}`;
    return [
        'plugin-details',
        encodeURIComponent(input.destination.pluginId),
        encodeURIComponent(input.destination.localId),
        instance,
    ].join(':');
}

/**
 * Create the Details workspace's normal tab resource for an admitted plugin
 * destination. The opener supplies display text from the current placement;
 * no input, origin, target, or opaque resource context crosses this durable
 * boundary.
 */
export function createPluginDetailsDestinationTab(input: Readonly<{
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
    title: string;
    subtitle?: string | null;
}>): DetailsTab {
    const resource = createPluginDetailsDestinationResource(input);
    return Object.freeze({
        key: buildPluginDetailsDestinationTabKey(resource),
        kind: PLUGIN_DETAILS_DESTINATION_RESOURCE_KIND,
        title: input.title,
        ...(input.subtitle === undefined ? {} : { subtitle: input.subtitle }),
        resource,
    });
}

export type PluginDetailsDestinationTargetKind = Extract<PluginUiTargetKindV1, 'session' | 'project'>;

/**
 * The mount facts supplied by the current details scope adapter. The renderer
 * itself supplies the placement, selected projection, ephemeral launch input,
 * instance identity, and deliberately no page subpath.
 */
export type PluginDetailsDestinationMountProps = Omit<
    React.ComponentProps<typeof PluginSurfacePlacementHost>,
    'placement' | 'binding' | 'launchInput' | 'mountInstanceKey' | 'pluginUiProjection' | 'subPath'
> & Readonly<{
    /** Scope currentness is an owner fact, not a property inferred from the model. */
    projectionPhase: PluginUiProjectionPhase;
}>;

/**
 * The direct scope adapter's current launch facts. This helper deliberately
 * consumes the renderer's actual mount/projection facts, so callers cannot
 * derive a target from `scopeId`, a raw target selector, or a current machine.
 */
export function createPluginDetailsDestinationLaunchScopeFacts(input: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    mount: PluginDetailsDestinationMountProps;
}>): PluginSurfaceScopedLaunchFacts {
    return Object.freeze({
        serverId: input.mount.serverId ?? null,
        machineId: input.mount.machineId ?? null,
        generation: input.projection?.generation ?? null,
        interactionEnabled: input.mount.projectionPhase === 'current'
            && input.mount.projectionInteractionEnabled === true,
    });
}

export type PluginDetailsDestinationRenderContext = Readonly<{
    resource: PluginDetailsDestinationResourceV1;
    tabKey: string;
    placement: PluginUiSurfacePlacementProjection;
    details: DetailsSurfaceRenderInputV1;
}>;

/**
 * A staged input is usable only when this renderer observes the exact same
 * current authority, destination, target, tab, and instance. The record is
 * private to the host Details lifecycle: it never crosses the tab resource,
 * Protocol payload, route, or plugin-facing resource identity.
 */
export type PluginDetailsDestinationLaunch = Readonly<{
    /** Private store discriminator; never a Details resource or persisted field. */
    handoffKind: 'detailsTab';
    authority: PluginSurfaceLaunchAuthority;
    targetKind: PluginDetailsDestinationTargetKind;
    tabKey: string;
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
    /** Explicit `undefined` replaces an earlier input instead of retaining it. */
    input: PluginUiLaunchInputV1 | undefined;
    /** Private per-mount host handlers, such as an opaque openable-content ref. */
    binding?: BoundPluginSurfaceBinding;
    /** Host-owned chooser model/factory; never a plugin-rendered chrome node. */
    viewerChoice?: (context: PluginDetailsDestinationRenderContext) => PluginDetailsViewerChoiceModel | null;
    /**
     * Host-private recovery for a previously delivered opaque launch. It may
     * replace this tab with an incumbent built-in tab, but never receives a
     * plugin-facing path/ref through persistence or Protocol.
     */
    unavailableFallback?: (fallback: PluginDetailsDestinationFallback) => void;
}>;

/**
 * The `detailsPane` counterpart to a Details tab handoff. Its key is private
 * AppPane-scope state; the durable overlay arm independently retains only the
 * qualified destination/instance selection.
 */
export type PluginDetailsPaneLaunch = Readonly<{
    handoffKind: 'detailsPane';
    authority: PluginSurfaceLaunchAuthority;
    targetKind: PluginDetailsDestinationTargetKind;
    overlayKey: string;
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
    input: PluginUiLaunchInputV1 | undefined;
    binding?: BoundPluginSurfaceBinding;
}>;

type PluginDetailsLaunchHandoff = PluginDetailsDestinationLaunch | PluginDetailsPaneLaunch;

export type PluginDetailsViewerChoice = Readonly<{
    /** `builtin` or the canonical `openableContentViewer:*` projection id. */
    id: string;
    label: string;
    /** Bounded plugin attribution or availability state shown below the label. */
    detail?: string;
    selected: boolean;
    /** Retained unavailable preferences stay visible but cannot be selected. */
    disabled?: boolean;
}>;

/**
 * A bounded candidate model owned by the file-opening owner. This Details
 * module owns only the fixed chrome and pending interaction state; it neither
 * ranks viewers nor persists a preference or a file identity.
 */
export type PluginDetailsViewerChoiceModel = Readonly<{
    candidates: readonly PluginDetailsViewerChoice[];
    selectCandidate: (candidateId: string) => Promise<void>;
}>;

export type PluginDetailsDestinationFallback = Readonly<{
    kind: 'unresolved' | 'unavailable';
    resource: PluginDetailsDestinationResourceV1;
    reason?: string;
    details: DetailsSurfaceRenderInputV1;
}>;

export type PluginDetailsDestinationPlacementResolution =
    | Readonly<{
        kind: 'available';
        resource: PluginDetailsDestinationResourceV1;
        placement: PluginUiSurfacePlacementProjection;
    }>
    | Readonly<{
        kind: 'unresolved';
        resource: PluginDetailsDestinationResourceV1;
    }>
    | Readonly<{
        kind: 'unavailable';
        resource: PluginDetailsDestinationResourceV1;
        reason: string;
    }>;

/** The durable tab identity returned after a private launch has been staged. */
export type PluginDetailsDestinationLaunchReceipt = Readonly<{
    resource: PluginDetailsDestinationResourceV1;
    tabKey: string;
}>;

/** Private handoff identity for an already-qualified Details workspace overlay. */
export function buildPluginDetailsPaneOverlayKey(input: Readonly<{
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>): string {
    const instance = input.instanceKey === undefined
        ? 'singleton'
        : `instance-${encodeURIComponent(input.instanceKey)}`;
    return [
        'plugin-details-pane',
        encodeURIComponent(input.destination.pluginId),
        encodeURIComponent(input.destination.localId),
        instance,
    ].join(':');
}

export type PluginDetailsPaneLaunchReceipt = Readonly<{
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
    overlayKey: string;
}>;

/**
 * The caller supplies a current, normalized details placement. The staging
 * owner derives destination, tab identity, and launch authority from that one
 * record instead of accepting caller-assembled copies.
 */
export type PluginDetailsDestinationLaunchStageInput = Readonly<{
    placement: PluginUiSurfacePlacementProjection;
    targetKind: PluginDetailsDestinationTargetKind;
    /** Current direct-scope facts for this Details owner. */
    scopedLaunchFacts?: PluginSurfaceScopedLaunchFacts | null;
    instanceKey?: PluginUiInstanceKeyV1;
    input: PluginUiLaunchInputV1 | undefined;
    binding?: BoundPluginSurfaceBinding;
    viewerChoice?: (context: PluginDetailsDestinationRenderContext) => PluginDetailsViewerChoiceModel | null;
    unavailableFallback?: (fallback: PluginDetailsDestinationFallback) => void;
}>;

export type PluginDetailsPaneLaunchStageInput = Readonly<{
    placement: PluginUiSurfacePlacementProjection;
    targetKind: PluginDetailsDestinationTargetKind;
    /** Current direct-scope facts for this Details owner. */
    scopedLaunchFacts?: PluginSurfaceScopedLaunchFacts | null;
    instanceKey?: PluginUiInstanceKeyV1;
    input: PluginUiLaunchInputV1 | undefined;
    binding?: BoundPluginSurfaceBinding;
}>;

export type PluginDetailsDestinationLaunchStore = PluginSurfaceLaunchInputStore<PluginDetailsLaunchHandoff>;

/**
 * Details has one pending selected launch per AppPane scope. This is the same
 * generic pending-open owner used by app pages; a Details tab key is the
 * canonical handoff location instead of a page route/location.
 */
export function createPluginDetailsDestinationLaunchStore(): PluginDetailsDestinationLaunchStore {
    return createPluginSurfaceLaunchInputStore<PluginDetailsLaunchHandoff>((launch) => (
        launch.handoffKind === 'detailsTab' ? launch.tabKey : launch.overlayKey
    ));
}

function isSameDetailsLaunchDestination(
    left: PluginUiDestinationReferenceV1,
    right: PluginUiDestinationReferenceV1,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

/**
 * Stage one opaque launch against the exact registry-normalized details
 * binding. Replacement is atomic: a fresh open (including one with undefined
 * input) drops any prior private binding/ref before the destination mounts.
 */
export function stagePluginDetailsDestinationLaunch(input: Readonly<{
    store: PluginDetailsDestinationLaunchStore;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}> & PluginDetailsDestinationLaunchStageInput): PluginDetailsDestinationLaunchReceipt | null {
    const { placement } = input;
    if (
        placement.binding.container !== 'detailsTab'
        || placement.binding.targetKind !== input.targetKind
        || placement.availability.state !== 'available'
    ) {
        return null;
    }
    if (
        (placement.binding.instancePolicy === 'singleton' && input.instanceKey !== undefined)
        || (placement.binding.instancePolicy === 'multiple' && input.instanceKey === undefined)
    ) {
        return null;
    }
    const parsedInput = input.input === undefined
        ? { success: true as const, data: undefined }
        : PluginUiLaunchInputV1Schema.safeParse(input.input);
    if (!parsedInput.success) return null;

    const authority = resolvePluginSurfaceLaunchAuthority({
        placement,
        accountLifetime: input.accountLifetime,
        scoped: input.scopedLaunchFacts,
    });
    if (!authority) return null;

    const resource = createPluginDetailsDestinationResource({
        destination: placement.binding.destination,
        ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
    });
    const tabKey = buildPluginDetailsDestinationTabKey(resource);
    const staged = input.store.stage(Object.freeze({
        handoffKind: 'detailsTab',
        authority,
        targetKind: input.targetKind,
        tabKey,
        destination: resource.destination,
        ...(resource.instanceKey === undefined ? {} : { instanceKey: resource.instanceKey }),
        input: parsedInput.data,
        ...(input.binding === undefined ? {} : { binding: input.binding }),
        ...(input.viewerChoice === undefined ? {} : { viewerChoice: input.viewerChoice }),
        ...(input.unavailableFallback === undefined ? {} : { unavailableFallback: input.unavailableFallback }),
    }));
    return staged ? Object.freeze({ resource, tabKey }) : null;
}

/**
 * Read a private handoff only after the destination has independently resolved
 * the same exact target binding/current authority. A matching tab key alone is
 * insufficient because multiple-instance keys and projection generations are
 * real identity facts.
 */
export function resolvePluginDetailsDestinationLaunch(input: Readonly<{
    store: PluginDetailsDestinationLaunchStore;
    authority: PluginSurfaceLaunchAuthority | null;
    targetKind: PluginDetailsDestinationTargetKind;
    resource: PluginDetailsDestinationResourceV1;
    tabKey: string;
}>): PluginDetailsDestinationLaunch | null {
    if (!input.authority) return null;
    const launch = input.store.peek({
        authority: input.authority,
        handoffKey: input.tabKey,
    });
    if (
        !launch
        || launch.handoffKind !== 'detailsTab'
        || launch.targetKind !== input.targetKind
        || launch.tabKey !== input.tabKey
        || !isSameDetailsLaunchDestination(launch.destination, input.resource.destination)
        || !isSameInstanceKey(launch.instanceKey, input.resource.instanceKey)
        || !isSamePluginSurfaceLaunchAuthority(launch.authority, input.authority)
    ) {
        return null;
    }
    return launch;
}

/**
 * Stage one opaque `detailsPane` launch against the same AppPane-scope store
 * as Details tabs. The resulting overlay selection has no input/origin field;
 * it is written by the AppPane owner only after this private handoff succeeds.
 */
export function stagePluginDetailsPaneLaunch(input: Readonly<{
    store: PluginDetailsDestinationLaunchStore;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}> & PluginDetailsPaneLaunchStageInput): PluginDetailsPaneLaunchReceipt | null {
    const { placement } = input;
    if (
        placement.binding.container !== 'detailsPane'
        || placement.binding.targetKind !== input.targetKind
        || placement.availability.state !== 'available'
    ) {
        return null;
    }
    if (
        (placement.binding.instancePolicy === 'singleton' && input.instanceKey !== undefined)
        || (placement.binding.instancePolicy === 'multiple' && input.instanceKey === undefined)
    ) {
        return null;
    }
    const parsedInput = input.input === undefined
        ? { success: true as const, data: undefined }
        : PluginUiLaunchInputV1Schema.safeParse(input.input);
    if (!parsedInput.success) return null;

    const authority = resolvePluginSurfaceLaunchAuthority({
        placement,
        accountLifetime: input.accountLifetime,
        scoped: input.scopedLaunchFacts,
    });
    if (!authority) return null;

    const destination = Object.freeze({ ...placement.binding.destination });
    const overlayKey = buildPluginDetailsPaneOverlayKey({
        destination,
        ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
    });
    const staged = input.store.stage(Object.freeze({
        handoffKind: 'detailsPane',
        authority,
        targetKind: input.targetKind,
        overlayKey,
        destination,
        ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
        input: parsedInput.data,
        ...(input.binding === undefined ? {} : { binding: input.binding }),
    }));
    return staged
        ? Object.freeze({
            destination,
            ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
            overlayKey,
        })
        : null;
}

/** Read a private overlay handoff only for its exact restored selection/current authority. */
export function resolvePluginDetailsPaneLaunch(input: Readonly<{
    store: PluginDetailsDestinationLaunchStore;
    authority: PluginSurfaceLaunchAuthority | null;
    targetKind: PluginDetailsDestinationTargetKind;
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>): PluginDetailsPaneLaunch | null {
    if (!input.authority) return null;
    const overlayKey = buildPluginDetailsPaneOverlayKey({
        destination: input.destination,
        ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
    });
    const launch = input.store.peek({ authority: input.authority, handoffKey: overlayKey });
    if (
        !launch
        || launch.handoffKind !== 'detailsPane'
        || launch.targetKind !== input.targetKind
        || launch.overlayKey !== overlayKey
        || !isSameDetailsLaunchDestination(launch.destination, input.destination)
        || !isSameInstanceKey(launch.instanceKey, input.instanceKey)
        || !isSamePluginSurfaceLaunchAuthority(launch.authority, input.authority)
    ) {
        return null;
    }
    return launch;
}

type PluginDetailsDestinationLaunchScopeValue = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    store: PluginDetailsDestinationLaunchStore;
}>;

const PluginDetailsDestinationLaunchScopeContext = React.createContext<PluginDetailsDestinationLaunchScopeValue | null>(null);

/**
 * The AppPane-scope lifecycle owner for private details handoffs. Its cleanup
 * releases opaque bindings on scope disposal; Account retirement clears them
 * synchronously before a successor projection can mount.
 */
export function PluginDetailsDestinationLaunchScope(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const [store] = React.useState(createPluginDetailsDestinationLaunchStore);
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

    const value = React.useMemo(() => Object.freeze({ accountLifetime, store }), [accountLifetime, store]);
    return (
        <PluginDetailsDestinationLaunchScopeContext.Provider value={value}>
            {props.children}
        </PluginDetailsDestinationLaunchScopeContext.Provider>
    );
}

/**
 * Host launchers use this writer immediately before `openDetailsTab`. It is
 * intentionally unavailable outside an AppPane scope rather than falling back
 * to a module-global private-ref map.
 */
export function usePluginDetailsDestinationLaunchStaging(): (
    input: PluginDetailsDestinationLaunchStageInput,
) => PluginDetailsDestinationLaunchReceipt | null {
    const scope = React.useContext(PluginDetailsDestinationLaunchScopeContext);
    return React.useCallback((input) => {
        if (!scope) return null;
        return stagePluginDetailsDestinationLaunch({
            ...input,
            store: scope.store,
            accountLifetime: scope.accountLifetime,
        });
    }, [scope]);
}

/**
 * The matching scoped writer for a full-bleed `detailsPane` overlay. Keeping
 * staging and retirement together lets an outer AppPane host hand off opaque
 * input before it updates the durable overlay selection, without introducing
 * another pane-local store or lifecycle owner.
 */
export function usePluginDetailsPaneLaunchStaging(): Readonly<{
    stage: (input: PluginDetailsPaneLaunchStageInput) => PluginDetailsPaneLaunchReceipt | null;
    retire: () => void;
}> | null {
    const scope = React.useContext(PluginDetailsDestinationLaunchScopeContext);
    return React.useMemo(() => {
        if (!scope) return null;
        return Object.freeze({
            stage: (input: PluginDetailsPaneLaunchStageInput) => stagePluginDetailsPaneLaunch({
                ...input,
                store: scope.store,
                accountLifetime: scope.accountLifetime,
            }),
            retire: () => scope.store.retire(),
        });
    }, [scope]);
}

export type PluginDetailsDestinationOpenSurfaceCallbacks = Readonly<{
    /** The existing Details workspace tab owner; no plugin tab reducer exists. */
    openTab?: DetailsSurfaceHostCallbacksV1['openTab'];
    /** The existing Details workspace overlay owner; no plugin overlay store exists. */
    openOverlay?: DetailsSurfaceHostCallbacksV1['openOverlay'];
}>;

export type PluginDetailsDestinationOpenSurfaceAdapterInput = Readonly<{
    targetKind: PluginDetailsDestinationTargetKind;
    projection: PluginUiProjectionModel | null | undefined;
    mount: PluginDetailsDestinationMountProps;
}> & PluginDetailsDestinationOpenSurfaceCallbacks;

function unavailableDetailsDestination(reason: string): PluginSurfaceOpenOutcome {
    return { ok: false, code: 'unavailable', reason };
}

/**
 * The canonical Details-local `openSurface` adapter. It deliberately resolves
 * only destinations this Details scope can host: app pages and other pane
 * families remain owned by their own navigation adapters instead of becoming
 * a details-specific router/fallback chain.
 */
export type PluginDetailsDestinationNavigationOwners = Readonly<{
    detailsTab: PluginSurfaceDestinationContainerHandler;
    detailsPane: PluginSurfaceDestinationContainerHandler;
}>;

/**
 * Build only the existing Details container delegates. The target binding
 * resolves admission once and invokes one of these exact owner callbacks; the
 * Details owner never re-resolves a request it did not own.
 */
export function createPluginDetailsDestinationNavigationOwners(input: Readonly<{
    store: PluginDetailsDestinationLaunchStore;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}> & PluginDetailsDestinationOpenSurfaceAdapterInput): PluginDetailsDestinationNavigationOwners {
    const localizePluginText = createPluginLocalizedTextResolver({ projection: input.projection });
    const scopedLaunchFacts = createPluginDetailsDestinationLaunchScopeFacts({
        projection: input.projection,
        mount: input.mount,
    });
    const openDetailsTab = (resolution: PluginSurfaceDestinationOpenResolution): PluginSurfaceOpenOutcome => {
        if (!input.openTab) {
            return unavailableDetailsDestination('details_destination_tab_owner_unavailable');
        }
        const receipt = stagePluginDetailsDestinationLaunch({
            store: input.store,
            accountLifetime: input.accountLifetime,
            placement: resolution.placement,
            targetKind: input.targetKind,
            scopedLaunchFacts,
            ...(resolution.request.instanceKey === undefined ? {} : { instanceKey: resolution.request.instanceKey }),
            input: resolution.request.input,
        });
        if (!receipt) return unavailableDetailsDestination('details_destination_not_current');
        try {
            input.openTab(createPluginDetailsDestinationTab({
                destination: receipt.resource.destination,
                ...(receipt.resource.instanceKey === undefined ? {} : { instanceKey: receipt.resource.instanceKey }),
                title: resolvePluginSurfaceDestinationLabel(resolution.placement, localizePluginText),
            }));
        } catch {
            // The stage/open pair is atomic from the caller's point of view:
            // a failed incumbent owner cannot leave a private input eligible for
            // a later unrelated Details mount.
            input.store.retire();
            return { ok: false, code: 'internal_error', reason: 'details_destination_open_failed' };
        }
        return { ok: true };
    };
    const openDetailsPane = (resolution: PluginSurfaceDestinationOpenResolution): PluginSurfaceOpenOutcome => {
        if (!input.openOverlay) {
            return unavailableDetailsDestination('details_destination_overlay_owner_unavailable');
        }
        const receipt = stagePluginDetailsPaneLaunch({
            store: input.store,
            accountLifetime: input.accountLifetime,
            placement: resolution.placement,
            targetKind: input.targetKind,
            scopedLaunchFacts,
            ...(resolution.request.instanceKey === undefined ? {} : { instanceKey: resolution.request.instanceKey }),
            input: resolution.request.input,
        });
        if (!receipt) return unavailableDetailsDestination('details_destination_not_current');
        try {
            input.openOverlay({
                destination: receipt.destination,
                ...(receipt.instanceKey === undefined ? {} : { instanceKey: receipt.instanceKey }),
            });
        } catch {
            input.store.retire();
            return { ok: false, code: 'internal_error', reason: 'details_destination_open_failed' };
        }
        return { ok: true };
    };
    return Object.freeze({
        detailsTab: openDetailsTab,
        detailsPane: openDetailsPane,
    });
}

/**
 * Compatibility adapter for Details-only embeds that do not yet consume a
 * target-scope binding. Mounted target hosts register the owners above instead.
 */
export function createPluginDetailsDestinationOpenSurfaceHandler(input: Readonly<{
    store: PluginDetailsDestinationLaunchStore;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}> & PluginDetailsDestinationOpenSurfaceAdapterInput): PluginSurfaceOpenHandler {
    const scopedLaunchFacts = createPluginDetailsDestinationLaunchScopeFacts({
        projection: input.projection,
        mount: input.mount,
    });
    const owners = createPluginDetailsDestinationNavigationOwners(input);
    return createPluginSurfaceDestinationOpenSurfaceHandler({
        placements: input.projection ? selectPluginDestinationSurfacePlacements(input.projection) : [],
        targetKind: input.targetKind,
        accountLifetime: input.accountLifetime,
        scopedLaunchFacts,
        policyContext: input.mount.policyContext,
        ...(
            input.mount.platform === undefined || input.mount.formFactor === undefined
                ? {}
                : {
                    runtimeAdmission: {
                        platform: input.mount.platform,
                        formFactor: input.mount.formFactor,
                    },
                }
        ),
        handlers: owners,
    });
}

/**
 * Install navigation only inside the AppPane Details scope that owns the
 * private handoff lifecycle. Outside it, the controller exposes no local
 * fallback method rather than accepting an unbound launch.
 */
export function usePluginDetailsDestinationOpenSurfaceHandler(
    input: PluginDetailsDestinationOpenSurfaceAdapterInput,
): PluginSurfaceOpenHandler | undefined {
    const scope = React.useContext(PluginDetailsDestinationLaunchScopeContext);
    return React.useMemo(() => {
        if (!scope) return undefined;
        return createPluginDetailsDestinationOpenSurfaceHandler({
            ...input,
            store: scope.store,
            accountLifetime: scope.accountLifetime,
        });
    }, [
        input.mount.formFactor,
        input.mount.machineId,
        input.mount.policyContext,
        input.mount.platform,
        input.mount.projectionInteractionEnabled,
        input.mount.projectionPhase,
        input.mount.serverId,
        input.openOverlay,
        input.openTab,
        input.projection,
        input.targetKind,
        scope,
    ]);
}

/**
 * Details registers these exact incumbent container delegates with the parent
 * target binding. The hook deliberately exposes no route/pane selection API.
 */
export function usePluginDetailsDestinationNavigationOwners(
    input: PluginDetailsDestinationOpenSurfaceAdapterInput,
): PluginDetailsDestinationNavigationOwners | undefined {
    const scope = React.useContext(PluginDetailsDestinationLaunchScopeContext);
    return React.useMemo(() => {
        if (!scope) return undefined;
        return createPluginDetailsDestinationNavigationOwners({
            ...input,
            store: scope.store,
            accountLifetime: scope.accountLifetime,
        });
    }, [
        input.mount.machineId,
        input.mount.policyContext,
        input.mount.projectionInteractionEnabled,
        input.mount.projectionPhase,
        input.mount.serverId,
        input.openOverlay,
        input.openTab,
        input.projection,
        input.targetKind,
        scope,
    ]);
}

/**
 * A private staged binding may carry an incumbent file/content capability, but
 * navigation itself remains this scope's canonical handler. Replacing an
 * accidental supplied `openSurface` prevents two Details navigation owners.
 */
export function bindPluginDetailsDestinationOpenSurface(input: Readonly<{
    binding?: BoundPluginSurfaceBinding;
    openSurface?: PluginSurfaceOpenHandler;
}>): BoundPluginSurfaceBinding | undefined {
    if (!input.binding && !input.openSurface) return undefined;
    return Object.freeze({
        ...(input.binding ?? {}),
        ...(input.openSurface ? { openSurface: input.openSurface } : {}),
    });
}

function isCurrentDetailsPaneLaunch(input: Readonly<{
    launch: PluginDetailsPaneLaunch | null;
    authority: PluginSurfaceLaunchAuthority | null;
    targetKind: PluginDetailsDestinationTargetKind;
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>): input is typeof input & Readonly<{
    launch: PluginDetailsPaneLaunch;
    authority: PluginSurfaceLaunchAuthority;
}> {
    const { authority, launch } = input;
    return Boolean(
        launch
        && authority
        && launch.targetKind === input.targetKind
        && isSameDetailsLaunchDestination(launch.destination, input.destination)
        && isSameInstanceKey(launch.instanceKey, input.instanceKey)
        && isSamePluginSurfaceLaunchAuthority(launch.authority, authority),
    );
}

/**
 * Deliver a staged overlay input only while the restored overlay resolves to
 * the exact same current binding. The durable workspace arm never becomes a
 * fallback carrier for the private value.
 */
export function usePluginDetailsPaneLaunch(input: Readonly<{
    placement: PluginUiSurfacePlacementProjection | null;
    targetKind: PluginDetailsDestinationTargetKind;
    projection: PluginUiProjectionModel | null | undefined;
    mount: PluginDetailsDestinationMountProps;
    destination: PluginUiDestinationReferenceV1;
    instanceKey?: PluginUiInstanceKeyV1;
}>): PluginDetailsPaneLaunch | null {
    const scope = React.useContext(PluginDetailsDestinationLaunchScopeContext);
    const authority = React.useMemo(() => (
        scope && input.placement
            ? resolvePluginSurfaceLaunchAuthority({
                placement: input.placement,
                accountLifetime: scope.accountLifetime,
                scoped: createPluginDetailsDestinationLaunchScopeFacts({
                    projection: input.projection,
                    mount: input.mount,
                }),
            })
            : null
    ), [input.mount, input.placement, input.projection, scope]);
    const overlayKey = React.useMemo(() => buildPluginDetailsPaneOverlayKey({
        destination: input.destination,
        ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
    }), [input.destination, input.instanceKey]);
    const subscribe = React.useCallback((onStoreChange: () => void) => (
        scope ? scope.store.subscribe(onStoreChange) : () => {}
    ), [scope]);
    const getSnapshot = React.useCallback(() => (
        scope
            ? resolvePluginDetailsPaneLaunch({
                store: scope.store,
                authority,
                targetKind: input.targetKind,
                destination: input.destination,
                ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
            })
            : null
    ), [authority, input.destination, input.instanceKey, input.targetKind, scope]);
    const staged = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [delivered, setDelivered] = React.useState<PluginDetailsPaneLaunch | null>(null);
    const deliveredIsCurrent = isCurrentDetailsPaneLaunch({
        launch: delivered,
        authority,
        targetKind: input.targetKind,
        destination: input.destination,
        ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
    });

    React.useEffect(() => {
        scope?.store.retireHandoffIfAuthorityChanged({ authority, handoffKey: overlayKey });
    }, [authority, overlayKey, scope]);
    React.useEffect(() => {
        if (!staged || !scope) return;
        setDelivered(staged);
        scope.store.settle(staged);
    }, [scope, staged]);
    React.useEffect(() => {
        if (delivered !== null && !deliveredIsCurrent) {
            setDelivered(null);
        }
    }, [delivered, deliveredIsCurrent]);

    return staged ?? (deliveredIsCurrent ? delivered : null);
}

function isScopeCompatibleWithTarget(
    details: DetailsSurfaceRenderInputV1,
    targetKind: PluginDetailsDestinationTargetKind,
): boolean {
    return details.region === 'details' && details.scope.kind === targetKind;
}

function isSameDestination(
    left: PluginUiDestinationReferenceV1,
    right: PluginUiDestinationReferenceV1,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function isSameInstanceKey(
    left: PluginUiInstanceKeyV1 | undefined,
    right: PluginUiInstanceKeyV1 | undefined,
): boolean {
    return left === right;
}

/**
 * Resolve exactly one current registry placement for this durable resource.
 * A same-named placement in a different target/container is not a fallback;
 * duplicate exact placements are likewise unavailable until the registry is
 * corrected rather than letting order choose an owner.
 */
export function resolvePluginDetailsDestinationPlacement(input: Readonly<{
    resource: PluginDetailsDestinationResourceV1;
    targetKind: PluginDetailsDestinationTargetKind;
    projection: PluginUiProjectionModel | null | undefined;
    projectionPhase: PluginUiProjectionPhase;
    policyContext?: PluginUiPolicyEvaluationContext;
    runtimeAdmission?: PluginSurfaceDestinationRuntimeAdmission;
}>): PluginDetailsDestinationPlacementResolution {
    if (input.projectionPhase === 'establishing') {
        return { kind: 'unresolved', resource: input.resource };
    }
    if (input.projectionPhase !== 'current' && input.projectionPhase !== 'retainedOffline') {
        return {
            kind: 'unavailable',
            resource: input.resource,
            reason: 'details_destination_projection_unavailable',
        };
    }
    if (!input.projection) {
        return {
            kind: 'unavailable',
            resource: input.resource,
            reason: 'details_destination_projection_unavailable',
        };
    }

    const matches = selectPluginSurfacePlacementsByDestination(
        input.projection,
        input.resource.destination,
    ).filter((placement) => (
        placement.binding.container === 'detailsTab'
        && placement.binding.targetKind === input.targetKind
    ));
    if (matches.length !== 1) {
        return {
            kind: 'unavailable',
            resource: input.resource,
            reason: 'details_destination_not_admitted',
        };
    }

    const placement = matches[0]!;
    if (
        input.runtimeAdmission
        && !isPluginUiDestinationBindingAdmittedAtRuntimeV1({
            binding: placement.binding,
            ...input.runtimeAdmission,
        })
    ) {
        return {
            kind: 'unavailable',
            resource: input.resource,
            reason: 'details_destination_platform_unavailable',
        };
    }
    if (placement.availability.state !== 'available') {
        return {
            kind: 'unavailable',
            resource: input.resource,
            reason: placement.availability.reason,
        };
    }
    if (!canRenderPluginUiProjectionEntry(placement, input.policyContext)) {
        return {
            kind: 'unavailable',
            resource: input.resource,
            reason: 'details_destination_policy_unavailable',
        };
    }
    return { kind: 'available', resource: input.resource, placement };
}

const viewerChoiceStylesheet = StyleSheet.create((theme) => ({
    root: {
        borderBottomColor: theme.colors.border.default,
        borderBottomWidth: 1,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 10,
        paddingVertical: 6,
    },
    choices: {
        alignItems: 'center',
        gap: 8,
        paddingRight: 10,
    },
    choice: {
        maxWidth: 220,
        borderColor: theme.colors.border.default,
        borderRadius: 8,
        borderWidth: 1,
        justifyContent: 'center',
        paddingHorizontal: 10,
        paddingVertical: 5,
    },
    choiceFocused: {
        ...(Platform.select({
            web: {
                outlineStyle: 'solid',
                outlineWidth: 2,
                outlineColor: theme.colors.border.focus,
                outlineOffset: -2,
            },
            default: {},
        }) as object),
    },
    choicePressed: {
        opacity: 0.84,
    },
    choiceSelected: {
        backgroundColor: theme.colors.surface.base,
        borderColor: theme.colors.border.strong,
    },
    choiceDisabled: {
        opacity: 0.5,
    },
    choiceContent: {
        minWidth: 0,
    },
    label: {
        color: theme.colors.text.secondary,
        ...Typography.rowMeta(),
    },
    labelSelected: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    detail: {
        color: theme.colors.text.secondary,
        marginTop: 1,
        ...Typography.pillLabel(),
    },
}));

/**
 * Fixed Details chrome for a host-supplied candidate model. It deliberately
 * accepts labels and commands rather than a plugin node: layout, focus,
 * accessibility state, and pending-action serialization remain host-owned.
 */
export function PluginDetailsViewerChoiceChrome(props: Readonly<{
    model: PluginDetailsViewerChoiceModel;
}>): React.ReactElement | null {
    const styles = viewerChoiceStylesheet;
    const [pending, setPending] = React.useState(false);
    const tabRefs = React.useRef(new Map<string, React.ElementRef<typeof Pressable> | null>());
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

    const selectCandidate = React.useCallback((candidate: PluginDetailsViewerChoice) => {
        if (pending || candidate.disabled === true || candidate.selected) return;
        setPending(true);
        let operation: Promise<void>;
        try {
            operation = props.model.selectCandidate(candidate.id);
        } catch {
            setPending(false);
            return;
        }
        void operation.catch(() => undefined).finally(() => {
            setPending(false);
        });
    }, [pending, props.model]);

    const handleTabKeyDown = React.useCallback((candidateIndex: number, event: any) => {
        if (Platform.OS !== 'web') return;
        const key = event?.nativeEvent?.key ?? event?.key;
        const nextIndex = resolveHappierTabKeySelection({
            tabs: props.model.candidates.map((candidate) => ({
                disabled: pending || candidate.disabled === true,
            })),
            currentIndex: candidateIndex,
            key,
            rtl: I18nManager.isRTL,
        });
        if (nextIndex === null || nextIndex < 0) return;
        const nextCandidate = props.model.candidates[nextIndex];
        if (!nextCandidate) return;
        event?.preventDefault?.();
        selectCandidate(nextCandidate);
        if (nextIndex !== candidateIndex) tabRefs.current.get(nextCandidate.id)?.focus?.();
    }, [pending, props.model.candidates, selectCandidate]);

    if (props.model.candidates.length === 0) return null;

    return (
        <View
            style={styles.root}
            accessibilityRole="tablist"
            accessibilityLabel={t('common.fileViewer')}
        >
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.choices}
            >
                {props.model.candidates.map((candidate, candidateIndex) => {
                    const disabled = pending || candidate.disabled === true;
                    const webKeyDownProps = Platform.OS === 'web'
                        ? ({ onKeyDown: (event: any) => handleTabKeyDown(candidateIndex, event) } as Record<string, unknown>)
                        : {};
                    const accessibilityLabel = candidate.detail
                        ? `${candidate.label} · ${candidate.detail}`
                        : candidate.label;
                    return (
                        <Pressable
                            key={candidate.id}
                            ref={(node) => {
                                if (node) tabRefs.current.set(candidate.id, node);
                                else tabRefs.current.delete(candidate.id);
                            }}
                            testID={`plugin-details-viewer-choice:${candidate.id}`}
                            accessibilityRole="tab"
                            accessibilityLabel={accessibilityLabel}
                            accessibilityState={{ selected: candidate.selected, disabled }}
                            aria-selected={candidate.selected}
                            disabled={disabled}
                            tabIndex={Platform.OS === 'web' ? (candidate.selected && !disabled ? 0 : -1) : undefined}
                            {...webKeyDownProps}
                            onPress={() => selectCandidate(candidate)}
                            style={(interactionState) => {
                                const webState = interactionState as typeof interactionState & { focused?: boolean };
                                return [
                                    styles.choice,
                                    {
                                        minWidth: minimumInteractiveTargetSize,
                                        minHeight: minimumInteractiveTargetSize,
                                    },
                                    candidate.selected ? styles.choiceSelected : null,
                                    disabled ? styles.choiceDisabled : null,
                                    !disabled && interactionState.pressed ? styles.choicePressed : null,
                                    webState.focused === true ? styles.choiceFocused : null,
                                ];
                            }}
                        >
                            <View style={styles.choiceContent}>
                                <Text
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                    style={[
                                        styles.label,
                                        candidate.selected ? styles.labelSelected : null,
                                    ]}
                                >
                                    {candidate.label}
                                </Text>
                                {candidate.detail ? (
                                    <Text
                                        testID={`plugin-details-viewer-choice-detail:${candidate.id}`}
                                        numberOfLines={1}
                                        ellipsizeMode="tail"
                                        style={styles.detail}
                                    >
                                        {candidate.detail}
                                    </Text>
                                ) : null}
                            </View>
                        </Pressable>
                    );
                })}
            </ScrollView>
        </View>
    );
}

function PluginDetailsDestinationSurfaceFrame(props: Readonly<{
    viewerChoice: PluginDetailsViewerChoiceModel;
    children: React.ReactNode;
}>): React.ReactElement {
    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <PluginDetailsViewerChoiceChrome model={props.viewerChoice} />
            <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
                {props.children}
            </View>
        </View>
    );
}

function isCurrentDetailsDestinationLaunch(input: Readonly<{
    launch: PluginDetailsDestinationLaunch | null;
    authority: PluginSurfaceLaunchAuthority | null;
    targetKind: PluginDetailsDestinationTargetKind;
    resource: PluginDetailsDestinationResourceV1;
    tabKey: string;
}>): input is typeof input & Readonly<{
    launch: PluginDetailsDestinationLaunch;
    authority: PluginSurfaceLaunchAuthority;
}> {
    const { authority, launch, resource } = input;
    return Boolean(
        launch
        && authority
        && launch.targetKind === input.targetKind
        && launch.tabKey === input.tabKey
        && isSameDestination(launch.destination, resource.destination)
        && isSameInstanceKey(launch.instanceKey, resource.instanceKey)
        && isSamePluginSurfaceLaunchAuthority(launch.authority, authority),
    );
}

function isRetainableDetailsDestinationLaunch(input: Readonly<{
    launch: PluginDetailsDestinationLaunch | null;
    targetKind: PluginDetailsDestinationTargetKind;
    resource: PluginDetailsDestinationResourceV1;
    tabKey: string;
}>): input is typeof input & Readonly<{ launch: PluginDetailsDestinationLaunch }> {
    const { launch, resource } = input;
    return Boolean(
        launch
        && launch.authority.accountLifetime?.isCurrent() !== false
        && launch.targetKind === input.targetKind
        && launch.tabKey === input.tabKey
        && isSameDestination(launch.destination, resource.destination)
        && isSameInstanceKey(launch.instanceKey, resource.instanceKey),
    );
}

/**
 * The one details mount that takes a private pending launch. Taking it moves
 * the value out of the scope slot into this exact mounted tab; a later open
 * replaces it rather than merging hidden file refs or chooser callbacks.
 */
function PluginDetailsDestinationSurfaceMount(props: Readonly<{
    targetKind: PluginDetailsDestinationTargetKind;
    projection: PluginUiProjectionModel | null | undefined;
    mount: PluginDetailsDestinationMountProps;
    resolution: PluginDetailsDestinationPlacementResolution;
    details: DetailsSurfaceRenderInputV1;
    renderFallback: (fallback: PluginDetailsDestinationFallback) => React.ReactNode;
}>): React.ReactElement {
    const scope = React.useContext(PluginDetailsDestinationLaunchScopeContext);
    const targetNavigationBinding = usePluginSurfaceDestinationNavigationBinding();
    const fallbackOpenSurface = usePluginDetailsDestinationOpenSurfaceHandler({
        targetKind: props.targetKind,
        projection: props.projection,
        mount: props.mount,
        openTab: props.details.callbacks.openTab,
        openOverlay: props.details.callbacks.openOverlay,
    });
    const openSurface = targetNavigationBinding?.openSurface ?? fallbackOpenSurface;
    const resource = props.resolution.resource;
    const tabKey = props.details.tab.key;
    const authority = React.useMemo(() => (
        scope && props.resolution.kind === 'available'
            ? resolvePluginSurfaceLaunchAuthority({
                placement: props.resolution.placement,
                accountLifetime: scope.accountLifetime,
                scoped: createPluginDetailsDestinationLaunchScopeFacts({
                    projection: props.projection,
                    mount: props.mount,
                }),
            })
            : null
    ), [props.mount, props.projection, props.resolution, scope]);
    const subscribe = React.useCallback((onStoreChange: () => void) => (
        scope ? scope.store.subscribe(onStoreChange) : () => {}
    ), [scope]);
    const getSnapshot = React.useCallback(() => (
        scope
            ? resolvePluginDetailsDestinationLaunch({
                store: scope.store,
                authority,
                targetKind: props.targetKind,
                resource,
                tabKey,
            })
            : null
    ), [authority, resource, scope, tabKey, props.targetKind]);
    const staged = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const [delivered, setDelivered] = React.useState<PluginDetailsDestinationLaunch | null>(null);
    const deliveredIsCurrent = props.resolution.kind === 'available' && isCurrentDetailsDestinationLaunch({
        launch: delivered,
        authority,
        targetKind: props.targetKind,
        resource,
        tabKey,
    });
    const launch = staged ?? (deliveredIsCurrent ? delivered : null);
    const retainedDelivered = isRetainableDetailsDestinationLaunch({
        launch: delivered,
        targetKind: props.targetKind,
        resource,
        tabKey,
    }) ? delivered : null;
    const fallback = props.resolution.kind === 'available'
        ? retainedDelivered && !deliveredIsCurrent
            ? {
                kind: 'unavailable' as const,
                resource,
                reason: 'details_destination_launch_authority_changed',
                details: props.details,
            }
            : null
        : {
            kind: props.resolution.kind,
            resource,
            ...(props.resolution.kind === 'unavailable' ? { reason: props.resolution.reason } : {}),
            details: props.details,
        };
    const fallbackLaunch = fallback && retainedDelivered ? retainedDelivered : null;
    const fallbackInvocationRef = React.useRef<Readonly<{
        launch: PluginDetailsDestinationLaunch;
        reason: string | undefined;
    }> | null>(null);

    React.useEffect(() => {
        scope?.store.retireHandoffIfAuthorityChanged({
            authority,
            handoffKey: tabKey,
        });
    }, [authority, scope, tabKey]);
    React.useEffect(() => {
        if (!staged || !scope) return;
        setDelivered(staged);
        scope.store.settle(staged);
    }, [scope, staged]);
    React.useEffect(() => {
        if (!fallback || !fallbackLaunch?.unavailableFallback) return;
        const prior = fallbackInvocationRef.current;
        if (prior?.launch === fallbackLaunch && prior.reason === fallback.reason) return;
        fallbackInvocationRef.current = Object.freeze({
            launch: fallbackLaunch,
            reason: fallback.reason,
        });
        try {
            fallbackLaunch.unavailableFallback(fallback);
        } catch {
            // Recovery is host-owned best effort; failure must not revive a
            // retired private ref or replace the canonical tombstone.
        }
    }, [fallback, fallbackLaunch]);
    React.useEffect(() => {
        if (delivered !== null && !deliveredIsCurrent) {
            setDelivered(null);
        }
    }, [delivered, deliveredIsCurrent]);

    if (fallback) {
        return <>{props.renderFallback(fallback)}</>;
    }
    // Resolution is now narrowed to the exact available binding; only that
    // branch may receive private launch state or mount a plugin renderer.
    if (props.resolution.kind !== 'available') {
        return <DetailsSurfaceFallback status="missing" />;
    }
    const context: PluginDetailsDestinationRenderContext = {
        resource,
        tabKey,
        placement: props.resolution.placement,
        details: props.details,
    };
    let viewerChoice: PluginDetailsViewerChoiceModel | null = null;
    try {
        viewerChoice = launch?.viewerChoice?.(context) ?? null;
    } catch {
        viewerChoice = null;
    }
    const placementHost = (
        <PluginSurfaceFocusEligibilityProvider active>
            <PluginSurfacePlacementHost
                {...props.mount}
                placement={props.resolution.placement}
                pluginUiProjection={props.projection}
                projectionInteractionEnabled={props.mount.projectionPhase === 'current'
                    && props.mount.projectionInteractionEnabled === true}
                binding={bindPluginDetailsDestinationOpenSurface({
                    binding: launch?.binding,
                    openSurface,
                })}
                launchInput={launch?.input}
                mountInstanceKey={resource.instanceKey}
                subPath={undefined}
            />
        </PluginSurfaceFocusEligibilityProvider>
    );
    return viewerChoice
        ? <PluginDetailsDestinationSurfaceFrame viewerChoice={viewerChoice}>{placementHost}</PluginDetailsDestinationSurfaceFrame>
        : placementHost;
}

export function createPluginDetailsDestinationSurfaceRenderer(input: Readonly<{
    targetKind: PluginDetailsDestinationTargetKind;
    projection: PluginUiProjectionModel | null | undefined;
    mount: PluginDetailsDestinationMountProps;
    renderFallback?: (fallback: PluginDetailsDestinationFallback) => React.ReactNode;
}>): DetailsSurfaceRendererV1 {
    const renderFallback = (fallback: PluginDetailsDestinationFallback): React.ReactNode => {
        if (input.renderFallback) return input.renderFallback(fallback);
        return (
            <DetailsSurfaceFallback
                status={fallback.kind === 'unresolved' ? 'pending' : 'missing'}
                reason={fallback.reason}
            />
        );
    };

    return {
        id: `plugin-details-destination:${input.targetKind}`,
        owner: 'plugin',
        order: 5,
        canRender: (details) => (
            isScopeCompatibleWithTarget(details, input.targetKind)
            && normalizePluginDetailsDestinationResource(details.tab.resource) !== null
        ),
        render: (details) => {
            const resource = normalizePluginDetailsDestinationResource(details.tab.resource);
            if (!resource) {
                return <DetailsSurfaceFallback status="missing" />;
            }
            const resolution = resolvePluginDetailsDestinationPlacement({
                resource,
                targetKind: input.targetKind,
                projection: input.projection,
                projectionPhase: input.mount.projectionPhase,
                policyContext: input.mount.policyContext,
                ...(
                    input.mount.platform === undefined || input.mount.formFactor === undefined
                        ? {}
                        : {
                            runtimeAdmission: {
                                platform: input.mount.platform,
                                formFactor: input.mount.formFactor,
                            },
                        }
                ),
            });
            return (
                <PluginDetailsDestinationSurfaceMount
                    targetKind={input.targetKind}
                    projection={input.projection}
                    mount={input.mount}
                    resolution={resolution}
                    details={details}
                    renderFallback={renderFallback}
                />
            );
        },
    };
}
