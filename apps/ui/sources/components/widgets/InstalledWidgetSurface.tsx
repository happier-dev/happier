import * as React from 'react';

import type {
    PluginUiInstanceKeyV1,
    PluginUiLaunchInputV1,
} from '@happier-dev/protocol/plugins/ui';

import { PluginInlineSurfaceHost } from '@/components/plugins/surfaces';
import { resolvePluginSurfaceDescriptorRenderGate } from '@/components/plugins/surfaces/PluginSurfaceHost';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { useSessionPluginPolicyContext } from '@/components/sessions/plugins/useSessionPluginPolicyContext';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
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
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildConnectedAccountPurposeSetupRoute } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';

import {
    resolveInstalledWidgetMount,
    type InstalledWidgetMount,
    type InstalledWidgetSource,
} from './installedWidgetMount';

/**
 * The installed-plugin arm of every widget host. Physical Home, Board and
 * Companion placements all support app and Session targets. Each host keeps its
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
    | Readonly<{ kind: 'app' }>;

export type InstalledWidgetSurfaceProps = Readonly<{
    target: InstalledWidgetTarget;
    /** The host record's revision; changing it retires the prior executable lifetime. */
    recordRevision: string;
    source: InstalledWidgetSource;
    /** The item's persisted bounded launch input, forwarded unchanged. */
    input?: PluginUiLaunchInputV1;
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

export function UnavailableInstalledWidget(props: Readonly<{
    unresolved: NonNullable<InstalledWidgetMount['unresolved']>;
    testID: string;
    onManagePlugin?: () => void;
}>): React.ReactElement {
    // One factual result, one centralized presentation projection. This adds no
    // widget-local availability enum and no widget-specific error copy.
    const presentation = resolvePluginSurfaceStatePresentation({
        state: props.unresolved.state,
        reasonCode: props.unresolved.reasonCode,
    });
    // Only `loading` and `unavailable` reach this component, and both produce a
    // replacement card. The fallback keeps a truthful state on screen rather
    // than an empty frame if that ever stops being true.
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

type MountedWidgetProps = Readonly<{
    mount: InstalledWidgetMount;
    runtime: PluginUiProjectionCurrentness;
    isCurrent?: () => boolean;
    input?: PluginUiLaunchInputV1;
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

function MountedAppWidget(props: MountedWidgetProps): React.ReactElement | null {
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
    const gate = resolvePluginSurfaceDescriptorRenderGate(placement, props.policyContext);
    if (!gate.canRender) return <ConfiguredWidgetRefusal resolution={{ status: 'unavailable', reasonCode: gate.reason,
        repair: { kind: 'type_unavailable' } }} testID={props.testID} onManagePlugin={props.onManagePlugin} />;
    return <>{props.reference}</>;
}

function SessionInstalledWidgetReference(props: InstalledWidgetSurfaceProps & Readonly<{ mount: InstalledWidgetMount; session: Session }>): React.ReactElement {
    const policyContext = useSessionPluginPolicyContext({ session: props.session, runtime: props.runtime });
    return <InstalledWidgetReference {...props} policyContext={policyContext} reference={props.reference} />;
}

export function InstalledWidgetSurface(props: InstalledWidgetSurfaceProps): React.ReactElement {
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
                unresolved={{ state, reasonCode: `widget_runtime_${props.runtime.phase}` }}
                testID={`${props.testID}-runtime-${props.runtime.phase}`}
            />
        );
    }
    // The projection owner's occurrence is the physical installed-plugin
    // lifetime. Aggregate snapshot and managed-package generations are
    // transport/custody metadata and must not remount an unchanged slot.
    const lifetimeKey = stableJsonStringify([
        props.recordRevision,
        props.runtime.serverId,
        props.runtime.machineId,
        props.target.kind,
        props.target.kind === 'session' ? props.target.sessionId : null,
        mount.placement?.occurrenceId ?? null,
    ]);
    const mountedProps: MountedWidgetProps = {
        mount,
        runtime: props.runtime,
        isCurrent: props.isCurrent,
        input: props.input,
        ...(props.onIntrinsicHeightChange ? { onIntrinsicHeightChange: props.onIntrinsicHeightChange } : {}),
        ...(props.onManagePlugin ? { onManagePlugin: props.onManagePlugin } : {}),
    };

    if (props.target.kind === 'app') {
        if (props.reference !== undefined) return <InstalledWidgetReference {...props} mount={mount}
            policyContext={{ platform: props.runtime.platform }} reference={props.reference} />;
        return <MountedAppWidget key={lifetimeKey} {...mountedProps} />;
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
export function ConfiguredInstalledWidgetSurface(props: Omit<InstalledWidgetSurfaceProps, 'target' | 'runtime' | 'input'> & Readonly<{
    resolution: ConfiguredWidgetTargetResolution;
    onRepairInputs?: (outcome: WidgetInputRepairOutcome) => void;
}>): React.ReactElement {
    const { resolution, onRepairInputs, ...mounted } = props;
    if (resolution.status !== 'ready') return <ConfiguredWidgetRefusal resolution={resolution} testID={props.testID} onRepairInputs={onRepairInputs} onManagePlugin={props.onManagePlugin} />;
    if (resolution.target.kind === 'workspace') return <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: 'widget_type_unavailable' }} testID={props.testID} />;
    return <InstalledWidgetSurface {...mounted} target={resolution.target} runtime={resolution.runtime} input={resolution.input} />;
}

/** All widget definitions retain the same factual inputs-repair presentation. */
export function ConfiguredWidgetRefusal(props: Readonly<{
    resolution: Exclude<ConfiguredWidgetTargetResolution, { status: 'ready' }>;
    testID: string;
    onRepairInputs?: (outcome: WidgetInputRepairOutcome) => void;
    onManagePlugin?: () => void;
}>): React.ReactElement {
    const { resolution, onRepairInputs } = props;
    const router = useRouter();
    const stateSize = useSurfaceStateCardSize();
    if (resolution.status === 'loading') {
        return <UnavailableInstalledWidget unresolved={{ state: 'loading', reasonCode: resolution.reasonCode }} testID={props.testID} />;
    }
    if (resolution.status === 'unavailable' && (resolution.reasonCode === 'widget_projection_establishing'
        || resolution.reasonCode === 'widget_session_hydrating')) {
        return <UnavailableInstalledWidget unresolved={{ state: 'loading', reasonCode: resolution.reasonCode }} testID={props.testID} />;
    }
    const repair = resolution.repair;
    if (!repair || resolution.reasonCode === 'widget_viewer_purpose_authority_unavailable') {
        return <UnavailableInstalledWidget unresolved={{ state: 'unavailable', reasonCode: resolution.reasonCode }} testID={props.testID} />;
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
        : repair.kind === 'type_unavailable' ? t('widgetAdd.typeUnavailable', { field: field?.label ?? t('widgetFrame.appearanceTitle') })
        : missing && field ? t('widgetAdd.stillNeeded', { field: label })
        : field?.selectedLabel ? t('widgetAdd.valueNotFound', { value: field.selectedLabel })
        : field ? t('widgetAdd.inputUnavailable', { field: label })
        : resolution.status === 'invalid' ? t('widgetAdd.inputsInvalid') : t('widgetAdd.inputsUnavailable');
    // Why a pinned value stopped resolving; a missing input or a type needs no cause line.
    const reason = repair.kind === 'input' && !missing && field ? t('widgetAdd.invalidReason') : undefined;
    const repairLabel = !field ? t('widgetAdd.editInputs')
        : missing ? t('widgetAdd.chooseField', { field: field.label })
        : t('widgetAdd.chooseAnother', { field: field.label });
    const action = repair.kind === 'connect' && repair.connection ? {
        label: t('connectedServicesSettings.connect'),
        onPress: () => router.push(buildConnectedAccountPurposeSetupRoute(repair.connection!)),
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
