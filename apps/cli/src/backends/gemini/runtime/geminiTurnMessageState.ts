import { hasChangeTitleInstruction } from '../utils/promptUtils';

export type GeminiTurnMessageState = {
  thinking: boolean;
  accumulatedResponse: string;
  isResponseInProgress: boolean;
  hadToolCallInTurn: boolean;
  pendingChangeTitle: boolean;
  changeTitleCompleted: boolean;
  taskStartedSent: boolean;
};

export function createGeminiTurnMessageState(): GeminiTurnMessageState {
  return {
    thinking: false,
    accumulatedResponse: '',
    isResponseInProgress: false,
    hadToolCallInTurn: false,
    pendingChangeTitle: false,
    changeTitleCompleted: false,
    taskStartedSent: false,
  };
}

export function resetGeminiTurnMessageStateForPrompt(
  state: GeminiTurnMessageState,
  prompt: string,
): void {
  state.accumulatedResponse = '';
  state.isResponseInProgress = false;
  state.hadToolCallInTurn = false;
  state.taskStartedSent = false;
  state.pendingChangeTitle = hasChangeTitleInstruction(prompt);
  state.changeTitleCompleted = false;
}

export function resetGeminiTurnMessageStateAfterTurn(
  state: GeminiTurnMessageState,
): void {
  state.hadToolCallInTurn = false;
  state.pendingChangeTitle = false;
  state.changeTitleCompleted = false;
  state.taskStartedSent = false;
  state.thinking = false;
}
