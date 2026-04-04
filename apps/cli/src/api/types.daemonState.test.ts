import { describe, expect, it } from 'vitest';

import { DaemonStateSchema } from './types';

describe('DaemonStateSchema', () => {
  it('preserves transfer runtime capability metadata', () => {
    const result = DaemonStateSchema.safeParse({
      status: 'running',
      pid: 12345,
      httpPort: 43210,
      startedAt: 1_700_000_000_000,
      transfer: {
        supported: {
          import: false,
          export: true,
        },
        listenerClasses: {
          loopback_http: {
            enabled: true,
            configured: true,
            active: false,
          },
          lan_http: {
            enabled: false,
            configured: false,
            active: false,
          },
          tailscale_serve_https: {
            enabled: false,
            configured: false,
            active: false,
            available: false,
          },
        },
        lifecycle: {
          mode: 'lazy_idle_shutdown',
          version: 1,
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw result.error;
    }

    expect(result.data.transfer).toEqual({
      supported: {
        import: false,
        export: true,
      },
      listenerClasses: {
        loopback_http: {
          enabled: true,
          configured: true,
          active: false,
        },
        lan_http: {
          enabled: false,
          configured: false,
          active: false,
        },
        tailscale_serve_https: {
          enabled: false,
          configured: false,
          active: false,
          available: false,
        },
      },
      lifecycle: {
        mode: 'lazy_idle_shutdown',
        version: 1,
      },
    });
  });
});
