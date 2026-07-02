import { CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS } from '@happier-dev/protocol';

import type { AlertButton } from '@/modal';
import type { TranslationKey } from '@/text';

import type { ConnectedServiceUxDiagnosticPresentationAction } from './connectedServiceUxDiagnostics';

export type ConnectedServiceUxDiagnosticAlertActionHandlers = Readonly<{
    retry?: () => void;
    startFreshUnderSelectedAccount?: () => void;
    resumeCurrentAccount?: () => void;
    openConnectedAccounts?: () => void;
    reconnectProfile?: () => void;
    enableStateSharing?: () => void;
    viewLatestFork?: () => void;
    viewNativeFork?: () => void;
    dismiss: () => void;
}>;

export type ConnectedServiceUxDiagnosticAlertActionTranslate = (
    key: TranslationKey,
    params?: Readonly<Record<string, unknown>>,
) => string;

function pushActionButton(
    buttons: AlertButton[],
    action: ConnectedServiceUxDiagnosticPresentationAction,
    onPress: (() => void) | undefined,
    translate: ConnectedServiceUxDiagnosticAlertActionTranslate,
    options?: Readonly<{ cancel?: boolean }>,
): boolean {
    if (!onPress) return false;
    buttons.push({
        text: translate(action.labelKey),
        ...(options?.cancel ? { style: 'cancel' as const } : {}),
        onPress,
    });
    return true;
}

export function buildConnectedServiceUxDiagnosticAlertButtons(params: Readonly<{
    actions: ReadonlyArray<ConnectedServiceUxDiagnosticPresentationAction>;
    handlers: ConnectedServiceUxDiagnosticAlertActionHandlers;
    translate: ConnectedServiceUxDiagnosticAlertActionTranslate;
}>): AlertButton[] {
    const buttons: AlertButton[] = [];
    const seen = new Set<string>();
    let hasCancelishAction = false;

    for (const action of params.actions) {
        if (seen.has(action.kind)) continue;
        seen.add(action.kind);
        switch (action.kind) {
            case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry:
                pushActionButton(buttons, action, params.handlers.retry, params.translate);
                break;
            case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount:
                pushActionButton(buttons, action, params.handlers.startFreshUnderSelectedAccount, params.translate);
                break;
            case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount:
                if (pushActionButton(buttons, action, params.handlers.resumeCurrentAccount, params.translate)) {
                    hasCancelishAction = true;
                }
                break;
            case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts:
                pushActionButton(buttons, action, params.handlers.openConnectedAccounts, params.translate);
                break;
            case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile:
                pushActionButton(buttons, action, params.handlers.reconnectProfile, params.translate);
                break;
            case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.enableStateSharing:
                pushActionButton(buttons, action, params.handlers.enableStateSharing, params.translate);
                break;
            case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.viewLatestFork:
                pushActionButton(buttons, action, params.handlers.viewLatestFork, params.translate);
                break;
            case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.viewNativeFork:
                pushActionButton(buttons, action, params.handlers.viewNativeFork, params.translate);
                break;
            case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.dismiss:
                if (pushActionButton(buttons, action, params.handlers.dismiss, params.translate, { cancel: true })) {
                    hasCancelishAction = true;
                }
                break;
            default:
                break;
        }
    }

    if (!hasCancelishAction) {
        buttons.push({
            text: params.translate('common.cancel'),
            style: 'cancel',
            onPress: params.handlers.dismiss,
        });
    }

    return buttons;
}
