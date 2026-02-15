import { describe, expect, it } from 'vitest';

import { listVoiceClientToolNames } from '@happier-dev/protocol';

import { createVoiceToolHandlers } from './handlers';

describe('voice tool handlers registry alignment', () => {
  it('implements every voice client tool from ActionSpecs', async () => {
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    for (const toolName of listVoiceClientToolNames()) {
      expect(typeof (handlers as any)[toolName]).toBe('function');
    }
  });
});

