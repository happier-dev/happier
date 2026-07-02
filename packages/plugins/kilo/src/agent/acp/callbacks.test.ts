import { describe, expect, it } from 'vitest';

import { buildKiloAcpEnv } from './callbacks.js';

describe('Kilo ACP callbacks', () => {
  it('injects permission-mode-aware OPENCODE_PERMISSION without mutating host env', () => {
    const env = buildKiloAcpEnv({
      cwd: '/workspace',
      env: { DEBUG: 'transport-debug' },
      permissionMode: 'read-only',
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
