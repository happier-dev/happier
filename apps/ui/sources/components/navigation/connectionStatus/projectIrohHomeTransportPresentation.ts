import type { DoctorSnapshotHomeTransportDiagnostics } from '@happier-dev/protocol/diagnostics/doctorSnapshot';

import { isIrohHomeTransportDiagnosticsCurrent } from '@/sync/runtime/irohHomeTransportDiagnostics';

import type { HomeConnectionSummaryLabelKey } from './resolveHomeConnectionSummary';

type IrohTransportObservation = NonNullable<DoctorSnapshotHomeTransportDiagnostics['current']>;

export type IrohHomeTransportPathPresentation = Readonly<{
    role: 'current' | 'last_known';
    observation: IrohTransportObservation;
}>;

/**
 * How a transport state reads, in the same vocabulary and status keys as the
 * Home connection summary (`resolveHomeConnectionSummary`).
 */
export type IrohHomeTransportStatus = Readonly<{
    labelKey: HomeConnectionSummaryLabelKey | 'status.connected' | 'status.connecting' | 'status.disconnected';
    statusKey: 'connected' | 'connecting' | 'disconnected' | 'error' | 'unknown';
}>;

const HISTORICAL_TRANSPORT_STATUS: IrohHomeTransportStatus = { labelKey: 'status.unknown', statusKey: 'unknown' };

function resolveTransportStatus(
    state: DoctorSnapshotHomeTransportDiagnostics['state'] | null,
): IrohHomeTransportStatus | null {
    switch (state) {
        case 'connected': return { labelKey: 'status.connected', statusKey: 'connected' };
        case 'connecting': return { labelKey: 'status.connecting', statusKey: 'connecting' };
        case 'reconnecting': return { labelKey: 'connectionStatus.summary.reconnecting', statusKey: 'connecting' };
        case 'unavailable': return { labelKey: 'connectionStatus.summary.unavailable', statusKey: 'error' };
        case 'disconnected': return { labelKey: 'status.disconnected', statusKey: 'disconnected' };
        case 'unknown':
        case null:
            return null;
    }
}

/**
 * One UI-only interpretation of Iroh diagnostics. The diagnostics registry
 * retains observations independently of the focused Home's effective carrier;
 * consumers must not turn those retained observations into live Iroh state.
 */
export type IrohHomeTransportPresentation = Readonly<{
    effectiveCarrier: 'https' | 'iroh' | null;
    heading: 'current' | 'history';
    /** Retained facts under a known HTTPS-effective carrier, never a live status. */
    isHistorical: boolean;
    isEffectiveIroh: boolean;
    /** A known HTTPS-effective Home never exposes an Iroh retry. */
    permitsRetry: boolean;
    /** HTTPS-effective retained facts never supply a live diagnostic state. */
    transportState: DoctorSnapshotHomeTransportDiagnostics['state'] | null;
    /**
     * The transport state's label and status key; historical facts read as
     * unknown, and `null` means no transport state is known (the endpoint decides).
     */
    transportStatus: IrohHomeTransportStatus | null;
    primaryPath: IrohHomeTransportPathPresentation | null;
    detailPaths: readonly IrohHomeTransportPathPresentation[];
}>;

function observationsMatch(left: IrohTransportObservation, right: IrohTransportObservation): boolean {
    return left.carrier === right.carrier && left.observedPath === right.observedPath;
}

/**
 * Projects the focused Home's effective carrier together with retained Iroh
 * facts. It deliberately does not mutate the diagnostics producer state.
 */
export function projectIrohHomeTransportPresentation(input: Readonly<{
    effectiveCarrier: 'https' | 'iroh' | null | undefined;
    diagnostics: DoctorSnapshotHomeTransportDiagnostics | null | undefined;
}>): IrohHomeTransportPresentation {
    const diagnostics = input.diagnostics ?? null;
    const effectiveCarrier = input.effectiveCarrier ?? null;
    const isEffectiveIroh = effectiveCarrier === 'iroh';
    const current = diagnostics?.current;
    const lastKnown = diagnostics?.lastKnown;

    if (effectiveCarrier === 'https') {
        const retained = lastKnown ?? current ?? null;
        const paths = retained ? [{ role: 'last_known' as const, observation: retained }] : [];
        return {
            effectiveCarrier,
            heading: 'history',
            isHistorical: diagnostics !== null,
            isEffectiveIroh: false,
            permitsRetry: false,
            transportState: null,
            transportStatus: diagnostics !== null ? HISTORICAL_TRANSPORT_STATUS : null,
            primaryPath: paths[0] ?? null,
            detailPaths: paths,
        };
    }

    const paths: IrohHomeTransportPathPresentation[] = [];
    if (current) paths.push({ role: 'current', observation: current });
    if (lastKnown && (!current || !observationsMatch(lastKnown, current))) {
        paths.push({ role: 'last_known', observation: lastKnown });
    }
    const isCurrent = isIrohHomeTransportDiagnosticsCurrent(diagnostics)
        && diagnostics?.current?.carrier === 'iroh';
    return {
        effectiveCarrier,
        heading: isCurrent ? 'current' : 'history',
        isHistorical: false,
        isEffectiveIroh,
        permitsRetry: true,
        transportState: diagnostics?.state ?? null,
        transportStatus: resolveTransportStatus(diagnostics?.state ?? null),
        primaryPath: paths[0] ?? null,
        detailPaths: paths,
    };
}
