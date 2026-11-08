import * as React from 'react';

import type { SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import type { PluginMachineExecutionOriginStateV1 } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { t } from '@/text';
import { resolvePluginExecutionOriginReasonDetail } from '@/sync/domains/surfaces/copy';

/**
 * Whether the plugin surface around this point is live (`true`) or a retained read-only snapshot
 * (`false`, its runtime is offline). Provided by `PluginSurfaceInteractionBoundary`; host chrome a
 * plugin places inside its own tree reads it to stay usable while the plugin's content is inert.
 */
export const PluginSurfaceInteractionAvailabilityContext = React.createContext(true);

export function usePluginSurfaceInteractionAvailable(): boolean {
    return React.useContext(PluginSurfaceInteractionAvailabilityContext);
}

/**
 * A companion surface (a plugin page's own shell column) shown beside the page it belongs to. The page
 * states an offline machine once; its companion stays quiet rather than repeating the same card. A
 * column peeked over another page is not a companion: it says so itself.
 */
export const PluginSurfaceCompanionContext = React.createContext(false);

/**
 * The page identity (its header: title, mark and the page's own controls) a plugin page route keeps above
 * a surface that has loaded nothing. A live plugin page draws its own header; a page that never loaded has
 * no plugin content to draw it, so the boundary shows this one above its cold state instead of leaving the
 * page nameless. The boundary clears it for the surfaces inside, so only the page's own surface uses it.
 * `loadingFrame` is the frame the loaded page will fill: the page column, or the whole content area for a page
 * that is a Collection under its own toolbar, so the loading state already stands where the page will.
 */
export type PluginSurfacePageIdentity = Readonly<{
    header: React.ReactNode;
    loadingFrame: 'column' | 'collection';
}>;

export const PluginSurfacePageHeaderContext = React.createContext<PluginSurfacePageIdentity | null>(null);

/** Machine-owner recovery presented outside the surface's inert snapshot. */
export const PluginSurfaceMachineRecoveryContext = React.createContext<Readonly<{
    retry?: SurfaceStateAction;
    chooseMachine?: SurfaceStateAction;
}> | null>(null);

/**
 * Why a machine-backed surface is not live yet, when the cause is not the machine's presence:
 * `unavailable` (the chosen or only source is gone, changed or refused), `required` (several sources could
 * run it and none is chosen) or `connecting` (a source is chosen and admitted; its view has not answered
 * yet). `null` leaves the machine as the stated cause.
 */
type PluginSurfacePreciseSourceCause = 'home_unreachable' | 'release_unavailable' | 'non_portable' | 'source_not_ready'
    | 'daemon_unsupported' | 'daemon_invalid_response' | 'daemon_unavailable' | 'activation_refused' | 'no_materialization' | 'unknown';
export type PluginSurfaceSourceCause = 'unavailable' | 'required' | 'connecting' | PluginSurfacePreciseSourceCause;

/**
 * Whether the execution-origin selection says this surface's Machine is offline, which is what offers the Machine
 * recovery (Retry, Choose another) and announces the surface as offline. Only a settled selection says so: while it
 * still resolves (its chip reads "Loading…"), interim refusals from other candidates are not this surface's state.
 */
export function isPluginSurfaceSelectionOffline(selection: Readonly<{
    state: PluginMachineExecutionOriginStateV1;
    loading: boolean;
}>): boolean {
    return !selection.loading && selection.state.kind === 'unavailable' && selection.state.reasons.includes('offline');
}

/** Provided by the mount that owns the execution-origin selection; read by the cold state below. */
export const PluginSurfaceSourceCauseContext = React.createContext<PluginSurfaceSourceCause | null>(null);

/**
 * Keep factual presence separate from Home routing, source preparation and daemon refusals.
 */
export function resolvePluginSurfaceSourceCause(
    state: PluginMachineExecutionOriginStateV1,
): PluginSurfaceSourceCause | null {
    switch (state.kind) {
        // A chosen source the resolver admitted is not offline: until its view answers, it is connecting.
        case 'selected': return 'connecting';
        case 'selectionRequired':
        case 'conflict': return 'required';
        case 'unavailable':
            // Without one shared cause, each candidate explains its own refusal in Run on.
            for (const reason of state.reasons.length === 1 ? state.reasons : []) {
                switch (reason) {
                    case 'home_unreachable':
                    case 'release_unavailable':
                    case 'non_portable':
                    case 'source_not_ready':
                    case 'daemon_unsupported':
                    case 'daemon_invalid_response':
                    case 'daemon_unavailable':
                    case 'activation_refused':
                    case 'no_materialization':
                    case 'unknown': return reason;
                }
            }
            return state.reasons.some(reason => reason !== 'offline' && reason !== 'stale')
                ? 'unavailable'
                : null;
    }
}

/**
 * What an offline plugin surface says about itself. Content that was live or that its renderer has
 * already loaded stays as the read-only snapshot. Without either fact, the cold state says nothing
 * has loaded rather than announcing a snapshot. Content readiness never admits effects.
 */
export function useOfflineSurfaceNotice(available: boolean, snapshotTitle: string, hasContent = false): Readonly<{
    /** Only the nothing-loaded state shows a title; a retained snapshot is announced by its reason line. */
    title: string;
    /** A chosen source still connecting is a pending state, not a failure. */
    kind: 'unavailable' | 'loading';
    reason: string;
    /** Absent when there is no snapshot to announce; the visible reason is then the announcement. */
    accessibilityLabel: string | undefined;
    /**
     * Offline since its first paint: there is no snapshot, only the plugin's own placeholder, so the
     * boundary shows the offline state in its place instead of an inert placeholder that never resolves.
     */
    nothingLoaded: boolean;
}> {
    const [wasLoaded, setWasLoaded] = React.useState(available || hasContent);
    const sourceCause = React.useContext(PluginSurfaceSourceCauseContext);
    const preciseCause = sourceCause !== null && sourceCause !== 'connecting' && sourceCause !== 'required' && sourceCause !== 'unavailable'
        ? sourceCause : null;
    const preciseReason = preciseCause
        ? `${resolvePluginExecutionOriginReasonDetail(preciseCause)} ${t('pluginSurfaces.originReason.recovery')}` : undefined;
    if ((available || hasContent) && !wasLoaded) setWasLoaded(true);
    return wasLoaded
        ? {
            title: sourceCause === 'unknown'
                ? t('pluginSurfaces.state.sourceUnavailable.title')
                : t('pluginSurfaces.state.offline.title'),
            reason: preciseReason ?? t('pluginSurfaces.state.offline.reason'),
            accessibilityLabel: t('pluginSurfaces.offlineSnapshot.accessibilityLabel', { title: snapshotTitle }),
            nothingLoaded: false,
            kind: 'unavailable',
        }
        : sourceCause === 'connecting' ? {
            title: t('pluginSurfaces.state.connecting.title'),
            reason: t('pluginSurfaces.state.connecting.reason'),
            accessibilityLabel: undefined,
            nothingLoaded: !available,
            kind: 'loading',
        }
        : sourceCause === 'unavailable' || preciseCause ? {
            // A Home that cannot route to the machine is not a missing source: the title names what is true.
            title: preciseCause === 'home_unreachable'
                ? t('pluginSurfaces.state.unreachable.title')
                : t('pluginSurfaces.state.sourceUnavailable.title'),
            reason: preciseReason ?? t('pluginSurfaces.state.sourceUnavailable.reason'),
            accessibilityLabel: undefined,
            nothingLoaded: !available,
            kind: 'unavailable',
        }
        : sourceCause === 'required' ? {
            title: t('pluginSurfaces.state.sourceRequired.title'),
            reason: t('pluginSurfaces.state.sourceRequired.reason'),
            accessibilityLabel: undefined,
            nothingLoaded: !available,
            kind: 'unavailable',
        }
        : {
            title: t('pluginSurfaces.state.offline.titleNothingLoaded'),
            reason: t('pluginSurfaces.state.offline.reasonNothingLoaded'),
            accessibilityLabel: undefined,
            nothingLoaded: !available,
            kind: 'unavailable',
        };
}
