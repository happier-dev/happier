import { describe, expect, it } from 'vitest';

import { AUGGIE_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

describe('Auggie agent runtime contribution', () => {
  it('exports provider-owned model preflight controls', () => {
    expect(AUGGIE_AGENT_RUNTIME_CONTRIBUTION).toMatchObject({
      agentId: 'auggie',
      preflightSessionControls: {
        failureCacheStrategy: 'cooldown',
        cliModelsCommandArgs: ['model', 'list', '--json'],
        probeModelsRaw: expect.any(Function),
      },
    });
  });
});
