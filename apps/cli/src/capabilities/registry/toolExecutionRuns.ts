import type { Capability } from '../service';

export const executionRunsCapability: Capability = {
  descriptor: { id: 'tool.executionRuns', kind: 'tool', title: 'Execution runs' },
  detect: async () => {
    return {
      available: true,
      intents: ['review', 'plan', 'delegate', 'voice_agent'],
    };
  },
};

