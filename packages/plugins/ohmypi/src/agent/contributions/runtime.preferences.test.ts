import { describe, expect, it } from 'vitest';

import { OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

describe('Oh My Pi session runtime preferences', () => {
  it('lets the Oh My Pi Agent setting override the shared ambient vendor key', async () => {
    const resolve = OH_MY_PI_AGENT_RUNTIME_CONTRIBUTION.sessionRuntimePreferences?.resolve;
    expect(resolve).toBeTypeOf('function');
    expect(await Promise.resolve(resolve?.({
      settings: { ohMyPiAgentDir: '~/isolated/omp' },
      processEnv: {
        HOME: '/home/alice',
        PI_CODING_AGENT_DIR: '/ambient/shared',
      },
      startedBy: 'daemon',
    }))).toEqual({
      environmentVariables: { PI_CODING_AGENT_DIR: '/home/alice/isolated/omp' },
    });
  });
});
