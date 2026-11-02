import { describe, expect, it } from 'vitest';

import {
  createTailscaleEnsureReadyTaskSpec,
  createTailscaleSecureAccessTaskSpec,
  TAILSCALE_ENSURE_READY_SYSTEM_TASK_KIND,
  TAILSCALE_ENSURE_READY_SYSTEM_TASK_STEP_IDS,
} from './index.js';

describe('createTailscaleSecureAccessTaskSpec', () => {
  it('preserves the selected method and defaults only the local target and native options', () => {
    expect(createTailscaleSecureAccessTaskSpec({
      upstreamUrl: ' http://127.0.0.1:3005 ',
      providerId: 'tailscaleServe',
    })).toEqual({
      kind: 'secureAccess.tailscale.v1',
      params: {
        target: { kind: 'local' },
        upstreamUrl: 'http://127.0.0.1:3005',
        providerId: 'tailscaleServe',
        servePath: '/',
        installPolicy: 'skip',
        loginPolicy: 'interactive',
        mode: 'normalUser',
      },
    });
  });

  it.each([undefined, 'lan', 'tailscaleFunel'])('refuses a missing or invalid native method (%s) instead of selecting Serve', (providerId) => {
    expect(() => Reflect.apply(createTailscaleSecureAccessTaskSpec, undefined, [{
      upstreamUrl: 'http://127.0.0.1:3005', providerId,
    }])).toThrow();
  });

  it('preserves an explicit tailscaleFunnel provider id', () => {
    expect(createTailscaleSecureAccessTaskSpec({
      upstreamUrl: 'http://127.0.0.1:3005',
      providerId: 'tailscaleFunnel',
      servePath: '/relay',
    })).toEqual({
      kind: 'secureAccess.tailscale.v1',
      params: {
        target: { kind: 'local' },
        upstreamUrl: 'http://127.0.0.1:3005',
        providerId: 'tailscaleFunnel',
        servePath: '/relay',
        installPolicy: 'skip',
        loginPolicy: 'interactive',
        mode: 'normalUser',
      },
    });
  });

  it('preserves an explicit ssh target', () => {
    expect(createTailscaleSecureAccessTaskSpec({
      upstreamUrl: 'http://127.0.0.1:3005',
      providerId: 'tailscaleServe',
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
    })).toEqual({
      kind: 'secureAccess.tailscale.v1',
      params: {
        upstreamUrl: 'http://127.0.0.1:3005',
        providerId: 'tailscaleServe',
        servePath: '/',
        installPolicy: 'skip',
        loginPolicy: 'interactive',
        mode: 'normalUser',
        target: {
          kind: 'ssh',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
      },
    });
  });

  it('preserves an explicit SSH relay host target', () => {
    expect(createTailscaleSecureAccessTaskSpec({
      upstreamUrl: 'http://127.0.0.1:3005',
      providerId: 'tailscaleFunnel',
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
    })).toEqual({
      kind: 'secureAccess.tailscale.v1',
      params: {
        upstreamUrl: 'http://127.0.0.1:3005',
        providerId: 'tailscaleFunnel',
        servePath: '/',
        installPolicy: 'skip',
        loginPolicy: 'interactive',
        mode: 'normalUser',
        target: {
          kind: 'ssh',
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
        },
      },
    });
  });
});

describe('createTailscaleEnsureReadyTaskSpec', () => {
  it('exports the canonical task kind and step ids', () => {
    expect(TAILSCALE_ENSURE_READY_SYSTEM_TASK_KIND).toBe('tailscale.ensureReady.v1');
    expect(TAILSCALE_ENSURE_READY_SYSTEM_TASK_STEP_IDS).toEqual([
      'tailscale.detect',
      'tailscale.install',
      'tailscale.login',
    ]);
  });

  it('normalizes params and fills readiness defaults', () => {
    expect(createTailscaleEnsureReadyTaskSpec({
      installPolicy: 'installIfMissing',
    })).toEqual({
      kind: 'tailscale.ensureReady.v1',
      params: {
        installPolicy: 'installIfMissing',
        loginPolicy: 'interactive',
        mode: 'normalUser',
      },
    });
  });

});
