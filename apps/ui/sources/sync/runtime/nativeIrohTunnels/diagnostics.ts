import { sanitizeBugReportUrl } from '@happier-dev/protocol/bugs/reports/sanitize';
import { sanitizeDoctorDiagnosticErrorCode, sanitizeDoctorDiagnosticErrorMessage, type DoctorSnapshotHomeTransportDiagnostics } from '@happier-dev/protocol/diagnostics/doctorSnapshot';
import type { IrohRelayPolicy } from '@happier-dev/iroh-native';

type IrohDiagnosticsLifecycleEvent = Readonly<{
    type: 'ready' | 'path_changed' | 'degraded' | 'closed' | 'error';
    observedPath?: string;
    errorCode?: string;
    atMs: number;
}>;

type InitialIrohHomeTransportDiagnosticsInput = Readonly<{
    homeServerIdentityId: string;
    remoteEndpointId: string;
    policy: IrohRelayPolicy;
    relayUrls?: readonly string[];
    directAddresses?: readonly string[];
    atMs: number;
}>;

function sanitizeRelayUrl(url: string): string {
    return (sanitizeBugReportUrl(url) ?? '').replace(/\/+$/u, '');
}

export function createInitialIrohHomeTransportDiagnostics(
    input: InitialIrohHomeTransportDiagnosticsInput,
): DoctorSnapshotHomeTransportDiagnostics {
    const relayUrls = input.relayUrls ?? [];
    const copiedRelayUrls = relayUrls.slice(0, 16).map(sanitizeRelayUrl).filter(Boolean);
    return {
        homeServerIdentityId: input.homeServerIdentityId,
        remoteEndpointId: input.remoteEndpointId,
        state: 'connecting',
        effectiveConfiguration: {
            policy: input.policy,
            relayUrls: copiedRelayUrls,
            relayUrlCount: relayUrls.length,
            relayUrlsTruncated: copiedRelayUrls.length < relayUrls.length,
            directAddressCount: input.directAddresses?.length ?? 0,
        },
        lastTransitionAtMs: input.atMs,
    };
}

export function projectIrohHomeTransportDiagnosticsReady(
    diagnostics: DoctorSnapshotHomeTransportDiagnostics,
    input: Readonly<{ observedPath: 'direct' | 'relay' | 'unknown'; atMs: number }>,
): DoctorSnapshotHomeTransportDiagnostics {
    const observation = {
        carrier: 'iroh' as const,
        ...(input.observedPath === 'direct' || input.observedPath === 'relay'
            ? { observedPath: input.observedPath }
            : {}),
    };
    return {
        ...diagnostics,
        state: 'connected',
        current: observation,
        lastKnown: input.observedPath === 'direct' || input.observedPath === 'relay'
            ? observation
            : diagnostics.lastKnown ?? observation,
        lastTransitionAtMs: input.atMs,
        diagnosticError: undefined,
    };
}

export function projectIrohHomeTransportDiagnosticsFailure(
    diagnostics: DoctorSnapshotHomeTransportDiagnostics,
    input: Readonly<{ code: string; message?: string; atMs: number }>,
): DoctorSnapshotHomeTransportDiagnostics {
    return {
        ...diagnostics,
        state: 'unavailable',
        current: undefined,
        lastTransitionAtMs: input.atMs,
        diagnosticError: {
            code: sanitizeDoctorDiagnosticErrorCode(input.code),
            ...(input.message ? { message: sanitizeDoctorDiagnosticErrorMessage(input.message) } : {}),
            atMs: input.atMs,
        },
    };
}

export function projectIrohHomeTransportDiagnosticsEvent(
    diagnostics: DoctorSnapshotHomeTransportDiagnostics,
    event: IrohDiagnosticsLifecycleEvent,
): DoctorSnapshotHomeTransportDiagnostics {
    if (event.type === 'ready' || event.type === 'path_changed') {
        return projectIrohHomeTransportDiagnosticsReady(diagnostics, {
            observedPath: event.observedPath === 'direct' || event.observedPath === 'relay'
                ? event.observedPath
                : 'unknown',
            atMs: event.atMs,
        });
    }
    const state = event.type === 'degraded'
        ? 'reconnecting' as const
        : event.type === 'closed'
            ? 'disconnected' as const
            : 'unavailable' as const;
    return {
        ...diagnostics,
        state,
        current: undefined,
        lastTransitionAtMs: event.atMs,
        ...(event.errorCode
            ? {
                diagnosticError: {
                    code: sanitizeDoctorDiagnosticErrorCode(event.errorCode),
                    atMs: event.atMs,
                },
            }
            : {}),
    };
}
