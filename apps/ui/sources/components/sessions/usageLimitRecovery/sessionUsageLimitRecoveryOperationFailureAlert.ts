import type { ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol';

import {
    resolveConnectedServiceUxDiagnosticPresentation,
    translateConnectedServiceUxDiagnosticBody,
    type ConnectedServiceUxDiagnosticTranslate,
} from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import {
    buildConnectedServiceUxDiagnosticAlertButtons,
    type ConnectedServiceUxDiagnosticAlertActionHandlers,
} from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnosticAlertActions';
import type { AlertButton } from '@/modal';

export type SessionUsageLimitRecoveryOperationFailureResult = Readonly<{
    ok: false;
    status?: string;
    error: string;
    errorCode?: string;
    retryAfterMs?: number;
    uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
    diagnostics?: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type SessionUsageLimitRecoveryOperationFailureAlert = Readonly<{
    title: string;
    body: string;
    buttons?: AlertButton[];
}>;

export type SessionUsageLimitRecoveryOperationFailureAlertActions = ConnectedServiceUxDiagnosticAlertActionHandlers;

export function buildSessionUsageLimitRecoveryOperationFailureAlert(params: Readonly<{
    result: SessionUsageLimitRecoveryOperationFailureResult;
    fallbackMessage: string;
    translate: ConnectedServiceUxDiagnosticTranslate;
    actions: SessionUsageLimitRecoveryOperationFailureAlertActions;
}>): SessionUsageLimitRecoveryOperationFailureAlert {
    const presentation = resolveConnectedServiceUxDiagnosticPresentation(params.result.uxDiagnostic);
    if (!presentation) {
        return {
            title: params.translate('common.error'),
            body: params.fallbackMessage,
            buttons: undefined,
        };
    }

    return {
        title: params.translate(presentation.titleKey),
        body: translateConnectedServiceUxDiagnosticBody({
            presentation,
            translate: params.translate,
        }),
        buttons: buildConnectedServiceUxDiagnosticAlertButtons({
            actions: presentation.actions,
            handlers: params.actions,
            translate: params.translate,
        }),
    };
}
