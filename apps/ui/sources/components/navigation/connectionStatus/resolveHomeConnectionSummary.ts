import type { HomeAdmissionVerdict } from '@/sync/runtime/connectivity/homeAdmissionReadiness';

import type { ConnectionHealthKind } from './connectionHealthTypes';

/**
 * First-layer Home connection summary. It answers only "can I reach this Home
 * right now, and what can I do about it" — machine, socket, and transport facts
 * stay behind the Details disclosure.
 */
export type HomeConnectionSummaryKind = 'connected' | 'reconnecting' | 'unavailable' | 'sign_in' | 'unknown';

export type HomeConnectionSummaryLabelKey =
    | 'connectionStatus.summary.connected'
    | 'connectionStatus.summary.reconnecting'
    | 'connectionStatus.summary.unavailable'
    | 'connectionStatus.summary.signInAgain'
    | 'status.unknown';

/** Presentation is resolved by the popover's shared status-presentation owner. */
export type HomeConnectionStatusKey = 'connected' | 'connecting' | 'error' | 'action_required' | 'unknown';

export type HomeConnectionSummary = Readonly<{
    kind: HomeConnectionSummaryKind;
    statusLabelKey: HomeConnectionSummaryLabelKey;
    statusKey: HomeConnectionStatusKey;
    /** `restore` re-authenticates this Home; `retry` reconnects it. */
    action: 'none' | 'retry' | 'restore' | 'update';
}>;

const SUMMARY_PRESENTATION: Readonly<Record<HomeConnectionSummaryKind, Readonly<{
    statusLabelKey: HomeConnectionSummaryLabelKey;
    statusKey: HomeConnectionStatusKey;
}>>> = {
    connected: { statusLabelKey: 'connectionStatus.summary.connected', statusKey: 'connected' },
    reconnecting: { statusLabelKey: 'connectionStatus.summary.reconnecting', statusKey: 'connecting' },
    unavailable: { statusLabelKey: 'connectionStatus.summary.unavailable', statusKey: 'error' },
    sign_in: { statusLabelKey: 'connectionStatus.summary.signInAgain', statusKey: 'action_required' },
    unknown: { statusLabelKey: 'status.unknown', statusKey: 'unknown' },
};

function buildSummary(
    kind: HomeConnectionSummaryKind,
    action: HomeConnectionSummary['action'],
): HomeConnectionSummary {
    return { kind, ...SUMMARY_PRESENTATION[kind], action };
}

function resolveSummaryKind(healthKind: ConnectionHealthKind): HomeConnectionSummaryKind {
    switch (healthKind) {
        case 'auth_required':
            return 'sign_in';
        case 'connecting':
        case 'server_restarting':
            return 'reconnecting';
        case 'server_error':
        case 'server_unreachable':
            return 'unavailable';
        case 'healthy':
        case 'no_machine':
        case 'machine_offline':
        case 'machine_unknown':
        case 'machine_not_ready':
            return 'connected';
    }
}

/**
 * The summary state comes from the canonical connection-health owner so the
 * popover never invents a second interpretation of whether the Home is up. Only
 * the offered action additionally consults the last sync error, because
 * retryability and auth-ness are error facts the health kind does not carry.
 */
export function resolveHomeConnectionSummary(params: Readonly<{
    healthKind: ConnectionHealthKind;
    syncErrorKind?: string | null;
    syncErrorRetryable?: boolean | null;
}>): HomeConnectionSummary {
    const kind = resolveSummaryKind(params.healthKind);
    const hasSyncError = params.syncErrorKind != null;
    const action = kind === 'sign_in' || params.syncErrorKind === 'auth'
        ? 'restore'
        : params.syncErrorRetryable === false
            ? 'none'
            : kind === 'reconnecting' || kind === 'unavailable' || hasSyncError
                ? 'retry'
                : 'none';

    return buildSummary(kind, action);
}

/** Before an applied runtime, only the restore's own verdict supplies connection evidence. */
export function resolveHomeAdmissionConnectionSummary(verdict: HomeAdmissionVerdict): HomeConnectionSummary | null {
    switch (verdict.kind) {
        case 'connecting':
        case 'selected':
        case 'ready':
            return null;
        case 'auth_failed':
            return resolveHomeConnectionSummary({ healthKind: 'auth_required' });
        case 'offline':
        case 'unavailable':
        case 'transient':
            return resolveHomeConnectionSummary({ healthKind: 'server_unreachable' });
        case 'update_required':
            return buildSummary('unavailable', 'update');
        case 'fail_closed':
        case 'refused':
            return resolveHomeConnectionSummary({ healthKind: 'server_error', syncErrorRetryable: verdict.retryable });
    }
}

/**
 * Normalizes the connection observations available for any Home target. This
 * keeps secondary projections and the focused socket on the same status
 * vocabulary without claiming that authentication alone proves reachability.
 */
export function resolveHomeTargetSummary(params: Readonly<{
    authStatus: 'signedIn' | 'signedOut' | 'unknown';
    projectionStatus?: 'idle' | 'loading' | 'signedOut' | 'error';
    socketStatus?: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
    pending?: boolean;
}>): HomeConnectionSummary {
    if (params.authStatus === 'signedOut' || params.projectionStatus === 'signedOut') {
        return buildSummary('sign_in', 'restore');
    }
    if (params.pending) return buildSummary('reconnecting', 'none');

    if (params.socketStatus) {
        switch (params.socketStatus) {
            case 'connected':
                return buildSummary('connected', 'none');
            case 'connecting':
                return buildSummary('reconnecting', 'none');
            case 'disconnected':
            case 'error':
                return buildSummary('unavailable', 'none');
            case 'idle':
                return buildSummary('unknown', 'none');
        }
    }

    switch (params.projectionStatus) {
        case 'idle':
            return buildSummary('connected', 'none');
        case 'loading':
            return buildSummary('reconnecting', 'none');
        case 'error':
            return buildSummary('unavailable', 'none');
        case undefined:
            return buildSummary('unknown', 'none');
    }
}
