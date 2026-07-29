import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
    isConnectedServiceResumeUnreachableSpawnErrorDetail,
    isConnectedServiceUxDiagnosticSpawnErrorDetail,
    type ConnectedServiceUxDiagnosticV1,
    type SpawnSessionResult,
} from '@happier-dev/protocol';

import {
    resolveConnectedServiceUxDiagnosticPresentation,
    type ConnectedServiceUxDiagnosticPresentation,
} from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import type { TranslationKey } from '@/text';

/**
 * D2 — "switch unavailable" recognition + explanation.
 *
 * When a connected-service auth switch fail-closes because the resumed session could not be proven
 * reachable under the new account (the daemon's K1 §2 gate), the spawn error carries a STRUCTURED
 * `errorDetail` (NOT just a message string). This module recognizes that detail PROGRAMMATICALLY and
 * builds a presentation descriptor the UI renders as a dedicated dialog that:
 *   - explains WHY the switch could not continue (the concrete machine-readable `reason` + agent), and
 *   - offers a clear "start fresh under the new account" action.
 *
 * Recognition is by the structured detail only — never by parsing `errorMessage` copy.
 */

export type ConnectedServiceSwitchUnavailableActionKind = 'start_fresh' | 'dismiss';

export type ConnectedServiceSwitchUnavailableAction = Readonly<{
    kind: ConnectedServiceSwitchUnavailableActionKind;
    labelKey: TranslationKey;
}>;

/**
 * The explanatory body is a parameterized translation; type its key as the specific literal so the
 * `t(key, params)` generic can infer the interpolation params (a broad `TranslationKey` collapses the
 * params to `never`, which forbids passing params).
 */
type ConnectedServiceSwitchUnavailableBodyKey = 'newSession.connectedServiceSwitchUnavailable.body';

export type ConnectedServiceSwitchUnavailablePresentation = Readonly<{
    titleKey: Extract<TranslationKey, 'newSession.connectedServiceSwitchUnavailable.title'>;
    bodyKey: Extract<TranslationKey, ConnectedServiceSwitchUnavailableBodyKey>;
    /** Interpolation params for the explanatory body so the user sees WHY it could not continue. */
    bodyParams: Readonly<{ reason: string; agentId: string }>;
    /** The concrete machine-readable reason mirrored from the daemon's reachability probe. */
    reason: string;
    /** The catalog agent id whose resume was unreachable (e.g. `pi`, `codex`). */
    agentId: string;
    actions: ReadonlyArray<ConnectedServiceSwitchUnavailableAction>;
}>;

function readDiagnosticReason(diagnostic: ConnectedServiceUxDiagnosticV1): string {
    const reason = diagnostic.diagnostics?.reason;
    return typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : diagnostic.code;
}

function readDiagnosticAgentId(diagnostic: ConnectedServiceUxDiagnosticV1): string {
    return diagnostic.agentId ?? 'agent';
}

function buildActions(
    actions: ConnectedServiceUxDiagnosticPresentation['actions'],
): ConnectedServiceSwitchUnavailableAction[] {
    const uxActions: ConnectedServiceSwitchUnavailableAction[] = [];
    for (const action of actions ?? []) {
        if (action.kind === CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount) {
            uxActions.push({ kind: 'start_fresh', labelKey: action.labelKey });
        }
        if (action.kind === CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.dismiss) {
            uxActions.push({ kind: 'dismiss', labelKey: action.labelKey });
        }
    }
    if (uxActions.some((action) => action.kind === 'start_fresh')
        && !uxActions.some((action) => action.kind === 'dismiss')) {
        uxActions.push({ kind: 'dismiss', labelKey: 'common.cancel' });
    }
    return uxActions;
}

/**
 * Returns a structured presentation when (and only when) the spawn result is a recognized
 * connected-service resume-unreachable failure; otherwise `null`.
 */
export function resolveConnectedServiceSwitchUnavailablePresentation(
    result: SpawnSessionResult,
): ConnectedServiceSwitchUnavailablePresentation | null {
    if (result.type !== 'error') return null;
    const detail = result.errorDetail;
    const resumeDetail = isConnectedServiceResumeUnreachableSpawnErrorDetail(detail) ? detail : null;
    const diagnosticDetail = isConnectedServiceUxDiagnosticSpawnErrorDetail(detail) ? detail : null;
    if (!resumeDetail && !diagnosticDetail) return null;

    const diagnostic = resumeDetail?.uxDiagnostic ?? diagnosticDetail?.uxDiagnostic;
    if (!diagnostic) return null;
    const uxPresentation = resolveConnectedServiceUxDiagnosticPresentation(diagnostic);
    const reason = uxPresentation?.bodyParams?.reason
        ?? resumeDetail?.reason
        ?? readDiagnosticReason(diagnostic);
    const agentId = uxPresentation?.bodyParams?.agentId
        ?? resumeDetail?.agentId
        ?? readDiagnosticAgentId(diagnostic);
    const actions = buildActions(uxPresentation?.actions ?? []);
    const fallbackActions: ConnectedServiceSwitchUnavailableAction[] = resumeDetail
        ? [
            { kind: 'start_fresh', labelKey: 'newSession.connectedServiceSwitchUnavailable.startFreshAction' },
            { kind: 'dismiss', labelKey: 'common.cancel' },
        ]
        : [
            { kind: 'dismiss', labelKey: 'common.cancel' },
        ];

    return {
        titleKey: 'newSession.connectedServiceSwitchUnavailable.title',
        bodyKey: 'newSession.connectedServiceSwitchUnavailable.body',
        bodyParams: {
            reason,
            agentId,
        },
        reason,
        agentId,
        actions: actions.length > 0
            ? actions
            : fallbackActions,
    };
}
