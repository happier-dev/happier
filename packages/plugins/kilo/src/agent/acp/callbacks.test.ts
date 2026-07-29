import { describe, expect, it } from 'vitest';

import { buildKiloAcpEnv } from './callbacks.js';

describe('Kilo ACP callbacks', () => {
  it('injects canonical-permission-aware OPENCODE_PERMISSION without mutating host env', () => {
    const env = buildKiloAcpEnv({
      launchEnvironment: {
        values: { DEBUG: 'transport-debug' },
        unset: [],
      },
      permissionIntent: 'read-only',
    });

    expect(JSON.parse(env.OPENCODE_PERMISSION)).toMatchObject({
      '*': 'deny',
      read: 'allow',
      edit: 'deny',
      bash: 'deny',
      external_directory: 'deny',
    });
    expect(env).not.toHaveProperty('DEBUG');
  });
});
