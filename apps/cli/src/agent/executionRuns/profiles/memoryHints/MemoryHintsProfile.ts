import type { ExecutionRunIntentProfile } from '../ExecutionRunIntentProfile';

export const MemoryHintsProfile: ExecutionRunIntentProfile = {
  intent: 'memory_hints',
  transcriptMaterialization: 'none',
  buildPrompt: (params) => params.instructions,
  onBoundedComplete: ({ rawText }) => ({
    status: 'succeeded',
    summary: 'Memory hints generated.',
    toolResultOutput: rawText,
  }),
};
