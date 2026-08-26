import { describe, expect, it } from 'vitest';

import { resolvePiSessionRuntimePreferences } from './launchEnvironment.js';

describe('resolvePiSessionRuntimePreferences', () => {
  it('lets the Pi Agent setting override the shared ambient vendor key', () => {
    expect(resolvePiSessionRuntimePreferences({
      settings: { piAgentDir: '~/isolated/pi' },
      environment: {
        HOME: '/home/alice',
        PI_CODING_AGENT_DIR: '/ambient/shared',
      },
    })).toMatchObject({
      environmentVariables: { PI_CODING_AGENT_DIR: '/home/alice/isolated/pi' },
    });
  });
});
