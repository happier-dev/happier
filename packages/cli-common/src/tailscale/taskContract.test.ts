import { describe, expect, it } from 'vitest';

import {
  createTailscaleSecureAccessTaskSpec,
  TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_KIND,
  TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_STEP_IDS,
} from './taskContract.js';

describe('TAILSCALE secure access task contract', () => {
  it('defines the stable task kind and ordered step ids', () => {
    expect(TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_KIND).toBe('secureAccess.tailscale.v1');
    expect(TAILSCALE_SECURE_ACCESS_SYSTEM_TASK_STEP_IDS).toEqual([
      'detect',
      'install',
      'login',
      'serve enable',
      'verify url',
    ]);
  });

  it('creates a UI-safe task spec with defaults for optional fields', () => {
    expect(
      createTailscaleSecureAccessTaskSpec({
        upstreamUrl: 'http://127.0.0.1:3005',
      }),
    ).toEqual({
      kind: 'secureAccess.tailscale.v1',
      params: {
        installPolicy: 'skip',
        loginPolicy: 'interactive',
        mode: 'normalUser',
        servePath: '/',
        upstreamUrl: 'http://127.0.0.1:3005',
      },
    });
  });
});
