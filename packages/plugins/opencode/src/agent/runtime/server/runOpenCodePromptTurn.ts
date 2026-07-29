import type { OpenCodeRuntimeTurnOperations } from './operations.js';

export async function runOpenCodePromptTurn(params: Readonly<{
  runtime: OpenCodeRuntimeTurnOperations;
  prompt: string;
  turnId: string;
}>): Promise<void> {
  params.runtime.beginTurnLifecycle(params.turnId);
  await params.runtime.sendTurnPrompt(params.prompt);
  await params.runtime.waitForTurnCompletion();
}
