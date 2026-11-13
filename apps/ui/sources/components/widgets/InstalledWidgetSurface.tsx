import * as React from 'react';
import { View } from 'react-native';
import type { UiSurfaceNetworkRequestV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';

import type {
    PluginUiInstanceKeyV1,
    PluginUiLaunchInputV1,
} from '@happier-dev/protocol/plugins/ui';

import { PluginInlineSurfaceHost } from '@/components/plugins/surfaces';
import { resolvePluginSurfaceState } from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { useSessionPluginPolicyContext } from '@/components/sessions/plugins/useSessionPluginPolicyContext';
import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useProjectDashboardOwner } from '@/components/projects/overview/useProjectDashboardOwner';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { WidgetFrameLoadingBody } from '@/components/widgets/frame/WidgetFrameLoadingBody';
import { useSurfaceStateCardSize } from '@/components/ui/surfaces/surfaceStateSize';
import { randomUUID } from '@/platform/randomUUID';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { WidgetPresentation } from '@/sync/domains/plugins/ui/widgetContract';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolvePluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { areSessionAddressesEqual, normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import type { ConfiguredWidgetTargetResolution, WidgetInputRepairOutcome } from '@/sync/domains/widgets/widgetBinding';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import type { ProjectSurfaceTargetV1, ProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { createPluginUiProjectPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';

import {
    resolveInstalledWidgetMount,
    type InstalledWidgetMount,
    type InstalledWidgetSource,
} from './installedWidgetMount';

/**
 * The installed-plugin arm of every widget host. Physical Home, Board and
 * Companion placements support App and Session targets; the Project host also
 * supplies its exact admitted Project context. Each host keeps its
 * own frame — Board cards, Home's hub section — around this one arm.
 *
 * It correlates the stable `{pluginId, localId}` reference to exactly one
 * currently projected widget placement for its target and then hands the mount
 * to the incumbent `PluginSurfaceHost`/`boundPluginSurfaceController` path. It
 * decides nothing that path already owns: generation, execution origin,
 * Artifact, renderer selection, methods, crash state and retirement all stay
 * there.
 *
 * The facts it MUST supply, because no one below can reconstruct them:
 *
 * - the item's exact persisted bounded `input`, forwarded verbatim as the plugin
 *   launch input. Recomputing it or substituting host metadata would silently
 *   change what the person saved.
 * - a host-owned opaque `mountInstanceKey`, fresh for this physical mount and
 *   stable only while it lives. Without it, a Board card and a Companion card
 *   showing the same item collapse onto one legacy singleton mount.
 * - for a Session target, the canonical Session `policyContext`. Mounting with
 *   `undefined` where an equivalent Agent inline surface passes a real context
 *   would evaluate plugin availability against different facts in two
 *   placements of the same Session. An App target evaluates exactly as a plugin
 *   app page does.
 *
 * A trusted installed plugin reaches this component identically whether it is
 * first-party or external: there is no origin-based privileged branch here.
 */

export type InstalledWidgetTarget =
    | Readonly<{
        kind: 'session';
        sessionId: string;
        /**
         * Exact Home-qualified Session projection captured by the outer Session
         * shell. Absent while that shell is still hydrating — a loading fact this
         * component owns, never a reason for a host to draw a different (and
         * wrong) state.
         */
        session?: Session;
    }>
    | Readonly<{ kind: 'app' }>
    | ProjectSurfaceTargetV1;

export type InstalledWidgetSurfaceProps = Readonly<{
    target: InstalledWidgetTarget;
    projectContext?: ProjectWidgetAreaContextV1;
    /** The host record's revision; changing it retires the prior executable lifetime. */
    recordRevision: string;
    source: InstalledWidgetSource;
    /** The item's persisted bounded launch input, forwarded unchanged. */
    input?: PluginUiLaunchInputV1;
    guestNetworkOverride?: UiSurfaceNetworkRequestV1;
    /** The public embedded presentation this physical host maps onto. */
    presentation: WidgetPresentation;
    /** The host's plugin projection: the Session's, or the app shell's. */
    runtime: PluginUiProjectionCurrentness;
    isCurrent?: () => boolean;
    /** Route-owned recovery retained by the incumbent plugin surface host. */
    onManagePlugin?: () => void;
    /** Current framed renderer's validated intrinsic height for outer semantic sizing. */
    onIntrinsicHeightChange?: (height: number) => void;
    /** An admitted inert reference replaces the executable body without creating a host binding. */
    reference?: React.ReactNode;
    testID: string;
}>;

/** The host's About this widget, for a widget that can only explain itself; null where the host has no About. */
export const WidgetAboutContext = React.createContext<(() => void) | null>(null);

/** A saved definition the viewer cannot read: a durable access fact, not a wait. */
const DEFINITION_FACT_CODES: ReadonlySet<string> = new Set(['widget_definition_unavailable', 'widget_definition_account_mismatch']);

/**
 * A widget that keeps its place but cannot draw (lab p-overview TEAM `unavailW`): which kind of
 * unavailable it is, why, and About this widget where the host has it. Neutral: nothing here needs the
 * viewer, and the rest of the surface works without it.
 */
function UnavailableWidgetFact(props: Readonly<{
    testID: string;
    kind: 'definition' | 'plugin';
    title: string;
    reason: string;
    diagnosticCode: string | null;
    action?: SurfaceStateAction;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const about = React.useContext(WidgetAboutContext);
    const aboutAction: SurfaceStateAction | undefined = about
        ? { label: t('widgetDefinition.aboutMenu'), onPress: about, testID: `${props.testID}-about` } : undefined;
    const primary = props.action ?? aboutAction;
    const secondary = props.action ? aboutAction : undefined;
    // A missing plugin is a fact about the card, not an event in it: one quiet line under the card's own
    // title, its next step on the line. The rest of the surface works, so it asks nothing else of the person.
    if (props.kind === 'plugin') {
        return (
            <SurfaceStateCard
                testID={`${props.testID}-state`}
                kind="unavailable"
                size="line"
                iconName="plug"
                title={props.title}
                diagnosticCode={props.diagnosticCode}
                accessibilitySemantics="status"
                {...(primary ? { action: primary } : {})}
                {...(secondary ? { secondaryAction: secondary } : {})}
            />
        );
    }
    return (
        <View style={[styles.fact, { backgroundColor: theme.colors.surface.inset }]}>
            <SurfaceStateCard
                testID={`${props.testID}-state`}
                kind="unavailable"
                size="details"
                layout="inline"
                iconName="lock"
                title={props.title}
                reason={props.reason}
                diagnosticCode={props.diagnosticCode}
                accessibilitySemantics="status"
                {...(primary ? { action: primary } : {})}
                {...(secondary ? { secondaryAction: secondary } : {})}
            />
        </View>
    );
}

/** Names who made a private definition when that is someone else; a viewer's own unreadable copy says no name. */
function UnavailableDefinitionFact(props: Readonly<{
    testID: string;
    title: string;
    diagnosticCode: string | null;
    owner?: Readonly<{ serverId: string; accountId: string }>;
}>): React.ReactElement {
    const viewer = useActiveServerAccountScope();
    const someoneElse = props.owner && viewer?.accountId !== props.owner.accountId ? props.owner : null;
    const owner = useProjectDashboardOwner(someoneElse?.serverId ?? '', someoneElse?.accountId ?? null);
    // An Account without a name is not named in a sentence ("Unnamed account made this widget").
    const shown = someoneElse ? owner?.displayName?.trim() : undefined;
    const name = shown && shown !== t('accountDisplay.unnamed') ? shown : undefined;
    return <UnavailableWidgetFact testID={props.testID} kind="definition" title={props.title}
        reason={name ? t('projects.widgets.definitionUnavailableOwner', { owner: name }) : t('projects.widgets.definitionUnavailableReason')}
        diagnosticCode={props.diagnosticCode} />;
}

export function UnavailableInstalledWidget(props: Readonly<{
    unresolved: NonNullable<InstalledWidgetMount['unresolved']>;
    testID: string;
    onManagePlugin?: () => void;
    reasonKind?: 'pluginRuntime' | 'widget';
    /** The Account whose saved definition this is (the layout's owner), named when it is not the viewer. */
    definitionOwner?: Readonly<{ serverId: string; accountId: string }>;
}>): React.ReactElement {
    // One factual result, one centralized presentation projection. This adds no
    // widget-local availability enum and no widget-specific error copy.
    const presentation = resolvePluginSurfaceStatePresentation({
        state: props.unresolved.state,
        reasonKind: props.reasonKind,
        reasonCode: props.unresolved.reasonCode,
    });
    // Only `loading` and `unavailable` reach this component, and both produce a
    // replacement card. The fallback keeps a truthful state on screen rather
    // than an empty frame if that ever stops being true.
    // First-time loading is not a problem to explain (lab dashboards ST): the header already stands,
    // and the body keeps the card's room with the same skeleton every widget body uses while it reads.
    // The reason stays on the diagnostic marker for QA only.
    if (props.unresolved.state === 'loading') {
        return (
            <WidgetBodyLoading testID={`${props.testID}-state`} diagnosticCode={presentation.diagnosticCode}
                accessibilityLabel={presentation.card?.title ?? t('common.loading')} />
        );
    }
    if (props.reasonKind === 'widget' && props.unresolved.state === 'unavailable'
        && DEFINITION_FACT_CODES.has(props.unresolved.reasonCode ?? '')) {
        return <UnavailableDefinitionFact testID={props.testID} title={t('projects.widgets.definitionUnavailable')}
            diagnosticCode={presentation.diagnosticCode} owner={props.definitionOwner} />;
    }
    const card = presentation.card ?? Object.freeze({
        kind: 'unavailable' as const,
        title: t('sessionBoard.item.pluginUnavailable.title'),
        reason: t('sessionBoard.item.pluginUnavailable.reason'),
        accessibilitySemantics: 'status' as const,
    });
    return (
        <SurfaceStateCard
            testID={`${props.testID}-state`}
            kind={card.kind}
            title={card.title}
            {...(card.reason === undefined ? {} : { reason: card.reason })}
            diagnosticCode={presentation.diagnosticCode}
            accessibilitySemantics={card.accessibilitySemantics}
            {...(props.unresolved.state === 'unavailable' && props.onManagePlugin ? {
                action: { label: t('sessionBoard.item.actions.managePlugin'), onPress: props.onManagePlugin },
            } : {})}
        />
    );
}

/** The one first-read body of a widget: its rows' room reserved, no copy, announced once as busy. */
function WidgetBodyLoading(props: Readonly<{ testID: string; diagnosticCode: string | null; accessibilityLabel: string }>): React.ReactElement {
    return (
        <View testID={props.testID} accessible accessibilityLabel={props.accessibilityLabel} aria-busy>
            {/* The frame's own first-load rows: one loading look per card, sized by the frame it sits in. */}
            <WidgetFrameLoadingBody testID={`${props.testID}-rows`} accessibilityLabel={props.accessibilityLabel} />
            {props.diagnosticCode ? <DiagnosticMarker testID={`${props.testID}-diagnostic-${props.diagnosticCode}`}
                diagnosticCode={props.diagnosticCode} /> : null}
        </View>
    );
}

/** Hidden marker naming why the body is not ready yet (QA and tests read it; people never do). */
function DiagnosticMarker(props: Readonly<{ testID: string; diagnosticCode: string }>): React.ReactElement {
    return <View testID={props.testID} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 0, height: 0 }} />;
}

type MountedWidgetProps = Readonly<{
    mount: InstalledWidgetMount;
    runtime: PluginUiProjectionCurrentness;
    isCurrent?: () => boolean;
    input?: PluginUiLaunchInputV1;
    guestNetworkOverride?: UiSurfaceNetworkRequestV1;
    onManagePlugin?: () => void;
    onIntrinsicHeightChange?: (height: number) => void;
}>;

function useMountedWidgetHostProps(props: MountedWidgetProps) {
    // This child exists only while the plugin surface is executable. Losing
    // admission/current facts unmounts it; recovery creates a new physical
    // lifetime and therefore a new key. Keeping the key in the outer record
    // shell would let a late delivery from the retired lifetime address the
    // recovered mount with the same identity.
    const [mountInstanceKey] = React.useState<PluginUiInstanceKeyV1>(() => randomUUID());
    return {
        machineId: props.runtime.machineId,
        serverId: props.runtime.serverId,
        pluginUiProjection: props.runtime.pluginUiProjection,
        platform: props.runtime.platform,
        projectionInteractionEnabled: props.runtime.interactionEnabled,
        isHostCurrent: props.isCurrent,
        launchInput: props.input,
        guestNetworkOverride: props.guestNetworkOverride,
        mountInstanceKey,
        ...(props.onIntrinsicHeightChange
            ? { onIntrinsicHeightChange: props.onIntrinsicHeightChange }
            : {}),
        ...(props.onManagePlugin
            ? {
                unavailableAction: {
                    label: t('sessionBoard.item.actions.managePlugin'),
                    onPress: props.onManagePlugin,
                },
            }
            : {}),
    };
}

function MountedSessionWidget(props: MountedWidgetProps & Readonly<{ session: Session }>): React.ReactElement | null {
    const hostProps = useMountedWidgetHostProps(props);
    const policyContext = useSessionPluginPolicyContext({
        session: props.session,
        runtime: props.runtime,
    });
    const placement = props.mount.placement;
    const inlineMount = props.mount.inlineMount;
    if (!placement || !inlineMount) return null;
    return (
        <PluginInlineSurfaceHost
            {...hostProps}
            placement={placement}
            inlineMount={inlineMount}
            sessionId={props.session.id}
            policyContext={policyContext}
        />
    );
}

function MountedAppWidget(props: MountedWidgetProps & Readonly<{ projectContext?: ProjectWidgetAreaContextV1; policyContext?: PluginUiPolicyEvaluationContext }>): React.ReactElement | null {
    const hostProps = useMountedWidgetHostProps(props);
    // The same app-target navigation a plugin app page receives: a widget row
    // opens the plugin's page through the one binding the shell installed.
    const openSurface = usePluginSurfaceDestinationNavigationBinding()?.openSurface;
    const binding = React.useMemo<BoundPluginSurfaceBinding>(
        () => (openSurface ? { openSurface } : {}),
        [openSurface],
    );
    const placement = props.mount.placement;
    const inlineMount = props.mount.inlineMount;
    if (!placement || !inlineMount) return null;
    return (
        <PluginInlineSurfaceHost
            {...hostProps}
            placement={placement}
            inlineMount={inlineMount}
            binding={binding}
            projectContext={props.projectContext}
            policyContext={props.policyContext}
        />
    );
}

function InstalledWidgetReference(props: Readonly<{
    mount: InstalledWidgetMount;
    policyContext: PluginUiPolicyEvaluationContext;
    reference: React.ReactNode;
    testID: string;
    onManagePlugin?: () => void;
}>): React.ReactElement {
    const placement = props.mount.placement;
    if (!placement) return <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: 'widget_surface_absent' }} testID={props.testID} />;
    const gate = resolvePluginSurfaceState(placement, props.policyContext).renderGate;
    if (!gate.canRender && gate.state === 'loading') return <UnavailableInstalledWidget
        unresolved={{ state: 'loading', reasonCode: gate.reason }} testID={props.testID} />;
    if (!gate.canRender) return <ConfiguredWidgetRefusal resolution={{ status: 'unavailable', reasonCode: gate.reason,
        repair: { kind: 'type_unavailable' } }} testID={props.testID} onManagePlugin={props.onManagePlugin} />;
    return <>{props.reference}</>;
}

function SessionInstalledWidgetReference(props: InstalledWidgetSurfaceProps & Readonly<{ mount: InstalledWidgetMount; session: Session }>): React.ReactElement {
    const policyContext = useSessionPluginPolicyContext({ session: props.session, runtime: props.runtime });
    return <InstalledWidgetReference {...props} policyContext={policyContext} reference={props.reference} />;
}

export function InstalledWidgetSurface(props: InstalledWidgetSurfaceProps): React.ReactElement {
    const projectPolicyContext = React.useMemo(() => props.target.kind === 'project'
        ? createPluginUiProjectPolicyEvaluationContext({ platform: props.runtime.platform }, props.target)
        : undefined, [props.runtime.platform, props.target]);
    const mount = React.useMemo(() => resolveInstalledWidgetMount({
        source: props.source,
        target: props.target.kind,
        presentation: props.presentation,
        runtime: props.runtime,
    }), [props.presentation, props.runtime, props.source, props.target.kind]);

    if (mount.unresolved) {
        return <UnavailableInstalledWidget unresolved={mount.unresolved} testID={props.testID} />;
    }
    if (props.runtime.phase !== 'current' || !props.runtime.interactionEnabled) {
        const state = props.runtime.phase === 'establishing' ? 'loading' : 'unavailable';
        return (
            <UnavailableInstalledWidget
                unresolved={{ state, reasonCode: props.runtime.unavailableReasonCode ?? `widget_runtime_${props.runtime.phase}` }}
                testID={`${props.testID}-runtime-${props.runtime.phase}`}
            />
        );
    }
    // The projection owner's occurrence is the physical installed-plugin
    // lifetime. Aggregate snapshot and managed-package generations are
    // transport/custody metadata and must not remount an unchanged slot.
    const lifetimeKey = stableJsonStringify([
        props.recordRevision,
        props.guestNetworkOverride,
        props.runtime.serverId,
        props.runtime.machineId,
        props.target.kind,
        props.target.kind === 'session' ? props.target.sessionId : null,
        props.target.kind === 'project' ? props.target.projectKey : null,
        mount.placement?.occurrenceId ?? null,
    ]);
    const mountedProps: MountedWidgetProps = {
        mount,
        runtime: props.runtime,
        isCurrent: props.isCurrent,
        input: props.input,
        guestNetworkOverride: props.guestNetworkOverride,
        ...(props.onIntrinsicHeightChange ? { onIntrinsicHeightChange: props.onIntrinsicHeightChange } : {}),
        ...(props.onManagePlugin ? { onManagePlugin: props.onManagePlugin } : {}),
    };

    if (props.target.kind !== 'session') {
        if (props.reference !== undefined) return <InstalledWidgetReference {...props} mount={mount}
            policyContext={projectPolicyContext ?? { platform: props.runtime.platform }} reference={props.reference} />;
        return <MountedAppWidget key={lifetimeKey} {...mountedProps} projectContext={props.projectContext} policyContext={projectPolicyContext} />;
    }

    const session = props.target.session ?? null;
    // The shell and runtime already admit one exact Home-qualified Session.
    // Never subscribe to an id-only store lookup here: it would create a second
    // target authority for a physical mount that has already been qualified.
    const hydratedAddress = session
        ? normalizeSessionAddress(session.serverId ?? props.runtime.serverId, session.id)
        : null;
    const runtimeAddress = normalizeSessionAddress(props.runtime.serverId, props.target.sessionId);
    if (!session || !hydratedAddress || !runtimeAddress
        || !areSessionAddressesEqual(hydratedAddress, runtimeAddress)) {
        // An absent or same-id/cross-Home projection is loading here, never
        // authority to borrow another Home's policy facts.
        return (
            <UnavailableInstalledWidget
                unresolved={{ state: 'loading', reasonCode: 'widget_session_hydrating' }}
                testID={props.testID}
            />
        );
    }
    if (props.reference !== undefined) return <SessionInstalledWidgetReference {...props} mount={mount} session={session} />;
    return <MountedSessionWidget key={lifetimeKey} {...mountedProps} session={session} />;
}

/** Consumes the canonical binder's admitted exact target; refusal never mounts ambient data. */
export function ConfiguredInstalledWidgetSurface(props: Omit<InstalledWidgetSurfaceProps, 'target' | 'runtime' | 'input' | 'recordRevision'> & Readonly<{
    resolution: ConfiguredWidgetTargetResolution;
    onRepairInputs?: (outcome: WidgetInputRepairOutcome) => void;
}>): React.ReactElement {
    const { resolution, onRepairInputs, ...mounted } = props;
    if (resolution.status !== 'ready') return <ConfiguredWidgetRefusal resolution={resolution} testID={props.testID} onRepairInputs={onRepairInputs} onManagePlugin={props.onManagePlugin} />;
    if (resolution.target.kind === 'workspace') return <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: 'widget_type_unavailable' }} testID={props.testID} />;
    // A layout revision or display-name edit does not replace the executable.
    // Every configured host uses the admitted source and normalized input here;
    // the installed mount adds its target, occurrence and network authority.
    return <InstalledWidgetSurface {...mounted} recordRevision={stableJsonStringify([props.source, resolution.input])}
        target={resolution.target} projectContext={resolution.projectContext} runtime={resolution.runtime} input={resolution.input} />;
}

/** All widget definitions retain the same factual inputs-repair presentation. */
export function ConfiguredWidgetRefusal(props: Readonly<{
    resolution: Exclude<ConfiguredWidgetTargetResolution, { status: 'ready' }>;
    testID: string;
    onRepairInputs?: (outcome: WidgetInputRepairOutcome) => void;
    onManagePlugin?: () => void;
}>): React.ReactElement {
    const { resolution, onRepairInputs } = props;
    const stateSize = useSurfaceStateCardSize();
    if (resolution.status === 'loading') {
        return <UnavailableInstalledWidget unresolved={{ state: 'loading', reasonCode: resolution.reasonCode }} testID={props.testID} />;
    }
    if (resolution.status === 'unavailable' && (resolution.reasonCode === 'widget_projection_establishing'
        || resolution.reasonCode === 'widget_session_hydrating')) {
        return <UnavailableInstalledWidget unresolved={{ state: 'loading', reasonCode: resolution.reasonCode }} testID={props.testID} />;
    }
    const repair = resolution.repair;
    // A missing plugin with no input of its own is the widget's whole plugin: say it as a neutral fact.
    if (repair?.kind === 'type_unavailable' && !repair.field) {
        return <UnavailableWidgetFact testID={props.testID} kind="plugin" title={t('projects.widgets.pluginUnavailable')}
            reason={t('projects.widgets.pluginUnavailableReason')} diagnosticCode={resolution.reasonCode}
            {...(props.onManagePlugin ? { action: { label: t('sessionBoard.item.actions.managePlugin'),
                onPress: props.onManagePlugin, testID: `${props.testID}-manage-plugin` } } : {})} />;
    }
    if (!repair || resolution.reasonCode === 'widget_viewer_purpose_authority_unavailable') {
        return <UnavailableInstalledWidget reasonKind="widget" unresolved={{ state: 'unavailable', reasonCode: resolution.reasonCode }} testID={props.testID} />;
    }
    // One repair, said where the widget is (lab dagent ST "Invalid input · repair in place"): name the
    // value that stopped resolving and why, and offer that input's own choice — never a generic
    // "review the inputs". It opens the same Edit step, at that input.
    const field = repair.field;
    const label = field?.label ?? t('widgetAdd.inputsUnavailable');
    const session = field?.selectedLabel ?? field?.label ?? t('widgetAdd.thisSession');
    const missing = resolution.status === 'selection_required';
    const title = repair.kind === 'connect' ? t('widgetAdd.connectionNeeded', { field: field?.label ?? t('settings.connectedServices') })
        : repair.kind === 'session_denied' ? t('widgetAdd.sessionDenied', { session })
        : repair.kind === 'session_unavailable' ? t('widgetAdd.sessionUnavailable', { session })
        // An input whose type is gone names that input; with no input it is the widget's own plugin that is missing.
        : repair.kind === 'type_unavailable' ? (field ? t('widgetAdd.typeUnavailable', { field: field.label }) : t('sessionBoard.item.pluginUnavailable.title'))
        : missing && field ? t('widgetAdd.stillNeeded', { field: label })
        : field?.selectedLabel ? t('widgetAdd.valueNotFound', { value: field.selectedLabel })
        : field ? t('widgetAdd.inputUnavailable', { field: label })
        : resolution.status === 'invalid' ? t('widgetAdd.inputsInvalid') : t('widgetAdd.inputsUnavailable');
    // Why a pinned value stopped resolving; a missing input or a type needs no cause line.
    const reason = repair.kind === 'input' && !missing && field ? t('widgetAdd.invalidReason')
        : repair.kind === 'type_unavailable' && !field ? t('sessionBoard.item.pluginUnavailable.reason') : undefined;
    const repairLabel = !field ? t('widgetAdd.editInputs')
        : missing ? t('widgetAdd.chooseField', { field: field.label })
        : t('widgetAdd.chooseAnother', { field: field.label });
    const action = repair.kind === 'connect' && repair.connection ? {
        label: t('connectedServicesSettings.connect'),
        onPress: (event?: unknown) => {
            const request = repair.connection!;
            void presentConnectSheet({ intent: 'link', purposeRequest: request, purpose: request.purpose, scope: request.scope,
                purposeSettlement: 'resourceDefault', anchor: resolvePressTriggerAnchor(event) });
        },
        testID: `${props.testID}-connect`,
    } : repair.kind === 'type_unavailable' && props.onManagePlugin ? {
        label: t('sessionBoard.item.actions.managePlugin'),
        onPress: props.onManagePlugin,
        testID: `${props.testID}-manage-plugin`,
    } : onRepairInputs && repair.kind !== 'type_unavailable' && repair.kind !== 'connect' ? {
        label: repairLabel,
        onPress: () => onRepairInputs(repair),
        testID: `${props.testID}-inputs-repair`,
    } : undefined;
    // Sized by the frame it sits in: a card on Home or a Board, one line in a column (W-3).
    return <SurfaceStateCard
        testID={`${props.testID}-state`}
        {...(stateSize ? {} : { size: 'line' as const })}
        kind={resolution.status === 'denied' ? 'denied' : 'warning'}
        title={title}
        {...(reason ? { reason } : {})}
        diagnosticCode={resolution.reasonCode}
        accessibilitySemantics="status"
        {...(action ? { action } : {})}
    />;
}

const styles = StyleSheet.create((theme) => ({
    /** The fact sits on the inset fill, so it reads as the widget's place rather than a page notice (lab `.pj-ua`). */
    fact: {
        alignSelf: 'stretch',
        borderRadius: theme.borderRadius.lg,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
    },
}));
