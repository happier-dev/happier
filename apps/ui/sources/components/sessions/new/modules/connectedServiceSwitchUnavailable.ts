import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
    isConnectedServiceResumeUnreachableSpawnErrorDetail,
    isConnectedServiceUxDiagnosticSpawnErrorDetail,
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

export type ConnectedServiceSwitchUnavailablePresentation = Readonly<{
    titleKey: ConnectedServiceUxDiagnosticPresentation['titleKey'];
    bodyKey: ConnectedServiceUxDiagnosticPresentation['bodyKey'];
    bodyParams?: ConnectedServiceUxDiagnosticPresentation['bodyParams'];
    actions: ReadonlyArray<ConnectedServiceSwitchUnavailableAction>;
}>;

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
    if (!uxPresentation) return null;
    const uxActions = buildActions(uxPresentation.actions);
    const fallbackActions: ConnectedServiceSwitchUnavailableAction[] = resumeDetail
        ? [
            { kind: 'start_fresh', labelKey: 'newSession.connectedServiceSwitchUnavailable.startFreshAction' },
            { kind: 'dismiss', labelKey: 'common.cancel' },
        ]
        : [
            { kind: 'dismiss', labelKey: 'common.cancel' },
        ];

    return {
        titleKey: uxPresentation.titleKey,
        bodyKey: uxPresentation.bodyKey,
        ...(uxPresentation.bodyParams ? { bodyParams: uxPresentation.bodyParams } : {}),
        actions: uxActions.length > 0
            ? uxActions
            : fallbackActions,
    };
}
