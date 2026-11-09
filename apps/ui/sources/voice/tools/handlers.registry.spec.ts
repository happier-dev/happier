import { describe, expect, it } from 'vitest';

import { listVoiceClientToolNames } from '@happier-dev/protocol/actions/actionSpecs';

import { createVoiceToolHandlers } from './handlers';

describe('voice tool handlers registry alignment', () => {
  it('omits port-dependent and bridge-dependent ActionSpecs until their canonical owner is available', async () => {
    const handlers = createVoiceToolHandlers({ resolveSessionId: () => 's1' });

    for (const toolName of listVoiceClientToolNames()) {
      expect(typeof handlers[toolName]).toBe(
        ['invokeAction', 'readCurrentUiContext', 'invokeCurrentUiCommand'].includes(toolName)
          ? 'undefined'
          : 'function',
      );
    }
  });
});
