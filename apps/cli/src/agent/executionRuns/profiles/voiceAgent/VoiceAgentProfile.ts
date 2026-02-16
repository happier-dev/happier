import type { ExecutionRunIntentProfile } from '../ExecutionRunIntentProfile';

export const VoiceAgentProfile: ExecutionRunIntentProfile = {
  intent: 'voice_agent',
  transcriptMaterialization: 'none',
  buildPrompt: (params) => params.instructions,
  onBoundedComplete: ({ start, rawText, finishedAtMs }) => {
    const summary = rawText.trim().length > 0 ? rawText.trim() : 'Voice agent completed.';
    return {
      status: 'succeeded',
      summary,
      toolResultOutput: {
        status: 'succeeded',
        summary,
        runId: start.runId,
        callId: start.callId,
        sidechainId: start.sidechainId,
        backendId: start.backendId,
        intent: start.intent,
        startedAtMs: start.startedAtMs,
        finishedAtMs,
      },
    };
  },
};
