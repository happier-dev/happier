import { getNextWizardStepId, getPreviousWizardStepId, isWizardStepVisible } from './wizardSelectors';
import type { WizardAction, WizardState, WizardStepId } from './wizardTypes';

function dedupeHistory(history: readonly WizardStepId[], nextStepId: WizardStepId): WizardStepId[] {
    return [...history.filter((stepId) => stepId !== nextStepId), nextStepId];
}

export function createWizardState(initialState: WizardState): WizardState {
    return {
        ...initialState,
        history: [...initialState.history],
    };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
    switch (action.type) {
        case 'wizard/advance': {
            const nextStepId = getNextWizardStepId(state.context, state.currentStepId);
            if (!nextStepId) return state;
            return {
                ...state,
                currentStepId: nextStepId,
                history: dedupeHistory(state.history, state.currentStepId),
            };
        }
        case 'wizard/back': {
            if (state.history.length > 0) {
                const nextHistory = [...state.history];
                while (nextHistory.length > 0) {
                    const candidate = nextHistory.pop()!;
                    if (isWizardStepVisible(state.context, candidate)) {
                        return {
                            ...state,
                            currentStepId: candidate,
                            history: nextHistory,
                        };
                    }
                }
            }

            const previousStepId = getPreviousWizardStepId(state.context, state.currentStepId);
            if (!previousStepId) return state;
            return {
                ...state,
                currentStepId: previousStepId,
                history: state.history.slice(0, -1),
            };
        }
        case 'wizard/goToStep':
            return {
                ...state,
                currentStepId: action.stepId,
                history: dedupeHistory(state.history, state.currentStepId),
            };
        case 'wizard/setResumeState':
            return {
                ...state,
                resumeState: action.resumeState,
            };
        case 'wizard/setParsedScanPayload':
            return {
                ...state,
                parsedScanPayload: action.parsedScanPayload,
            };
        case 'wizard/setRelaySelection':
            return {
                ...state,
                context: {
                    ...state.context,
                    relaySelection: action.relaySelection,
                },
            };
        case 'wizard/setRelayLockConfirmationPending':
            return {
                ...state,
                context: {
                    ...state.context,
                    relayLockConfirmationPending: action.pending,
                },
            };
        case 'wizard/setRelaySwitchConfirmationPending':
            return {
                ...state,
                context: {
                    ...state.context,
                    relaySwitchConfirmationPending: action.pending,
                },
            };
        case 'wizard/setAuthIntent':
            return {
                ...state,
                context: {
                    ...state.context,
                    authIntent: action.authIntent,
                },
            };
        case 'wizard/setSetupAction':
            return {
                ...state,
                context: {
                    ...state.context,
                    setupAction: action.setupAction,
                },
            };
        case 'wizard/setScanStepEnabled':
            return {
                ...state,
                context: {
                    ...state.context,
                    scanStepEnabled: action.enabled,
                },
            };
        default:
            return state;
    }
}
