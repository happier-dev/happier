import type { ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol';

import {
    resolveConnectedServiceUxDiagnosticPresentation,
} from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import {
    buildConnectedServiceUxDiagnosticAlertButtons,
    type ConnectedServiceUxDiagnosticAlertActionHandlers,
} from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnosticAlertActions';
import type { AlertButton } from '@/modal';
import type { TranslationKey } from '@/text';

export type SessionUsageLimitRecoveryOperationFailureResult = Readonly<{
    ok: false;
    status?: string;
    error?: string;
    errorCode?: string;
    uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
}>;

export type SessionUsageLimitRecoveryOperationFailureAlert = Readonly<{
    title: string;
    body: string;
    buttons?: AlertButton[];
}>;

export type SessionUsageLimitRecoveryOperationFailureAlertActions = ConnectedServiceUxDiagnosticAlertActionHandlers;

type Translate = (key: TranslationKey, params?: Readonly<Record<string, unknown>>) => string;

export function buildSessionUsageLimitRecoveryOperationFailureAlert(params: Readonly<{
    result: SessionUsageLimitRecoveryOperationFailureResult;
    fallbackMessage: string;
    translate: Translate;
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
        body: params.translate(presentation.bodyKey),
        buttons: buildConnectedServiceUxDiagnosticAlertButtons({
            actions: presentation.actions,
            handlers: params.actions,
            translate: params.translate,
        }),
    };
}
