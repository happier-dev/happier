import { redactTranscriptSecrets } from '@/api/session/client/transport/transcriptSecretRedaction';

import type { ExecutionRunIntentProfile } from '../ExecutionRunIntentProfile';

export const MemoryHintsProfile: ExecutionRunIntentProfile = {
  intent: 'memory_hints',
  transcriptMaterialization: 'none',
  buildPrompt: (params) => params.instructions,
  computeSidechainStreamText: ({ fullText }) => fullText,
  onBoundedComplete: ({ rawText }) => ({
    status: 'succeeded',
    summary: 'Memory hints generated.',
    toolResultOutput: redactTranscriptSecrets(rawText),
  }),
};
