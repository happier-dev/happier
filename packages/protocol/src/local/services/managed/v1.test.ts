import { describe, expect, it } from 'vitest';

import {
  HAPPIER_LOCAL_SERVICE_ENV,
  LocalServiceManagedDeclarationV1Schema,
  LocalServiceManagedRuntimeStateV1Schema,
} from './v1.js';

describe('LocalServiceManagedDeclarationV1Schema', () => {
  it('supports run-as-is detection, assign/inject, and external registration modes', () => {
    const detectAfterLaunch = LocalServiceManagedDeclarationV1Schema.parse({
      v: 1,
      id: 'plugin-a:web',
      owner: { kind: 'plugin', pluginId: 'plugin-a' },
      launch: { kind: 'binary', executablePath: '/bin/sh', args: ['-lc', 'npm run dev'] },
      launchMode: { kind: 'detectAfterLaunch', minimumConfidence: 'medium' },
      hostPolicy: { kind: 'loopback' },
      name: { strategy: 'derived', base: 'plugin-a-web' },
      healthCheck: { kind: 'none' },
      restart: { kind: 'never' },
      cleanup: { staleAfterMs: 30_000 },
    });
    const assignAndInject = LocalServiceManagedDeclarationV1Schema.parse({
      ...detectAfterLaunch,
      launchMode: {
        kind: 'assignAndInject',
        portPolicy: { kind: 'allocated', preferredPort: 5173, onCollision: 'fallback' },
        environment: { inject: ['PORT', 'HOST'] },
      },
    });
    const externalRegistered = LocalServiceManagedDeclarationV1Schema.parse({
      ...detectAfterLaunch,
      launchMode: {
        kind: 'externalRegistered',
        inventoryId: 'machine-a:tcp:127.0.0.1:5173',
        minimumConfidence: 'high',
      },
    });

    expect(detectAfterLaunch.launchMode.kind).toBe('detectAfterLaunch');
    expect(assignAndInject.launchMode.kind).toBe('assignAndInject');
    expect(externalRegistered.launchMode.kind).toBe('externalRegistered');
  });

  it('keeps public URL injection out of the managed-service contract', () => {
    const result = LocalServiceManagedDeclarationV1Schema.safeParse({
      v: 1,
      id: 'plugin-a:web',
      owner: { kind: 'plugin', pluginId: 'plugin-a' },
      launch: { kind: 'binary', executablePath: '/bin/sh' },
      launchMode: {
        kind: 'assignAndInject',
        portPolicy: { kind: 'allocated' },
        environment: { inject: ['PORT', 'HAPPIER_PUBLIC_URL'] },
      },
      hostPolicy: { kind: 'loopback' },
      name: { strategy: 'derived', base: 'plugin-a-web' },
      healthCheck: { kind: 'none' },
      restart: { kind: 'never' },
      cleanup: { staleAfterMs: 30_000 },
    });

    expect(result.success).toBe(false);
  });

  it('rejects non-loopback hosts for loopback managed services', () => {
    const result = LocalServiceManagedDeclarationV1Schema.safeParse({
      v: 1,
      id: 'plugin-a:web',
      owner: { kind: 'plugin', pluginId: 'plugin-a' },
      launch: { kind: 'binary', executablePath: '/bin/sh' },
      launchMode: { kind: 'detectAfterLaunch' },
      hostPolicy: { kind: 'loopback', host: '0.0.0.0' },
      name: { strategy: 'derived', base: 'plugin-a-web' },
      healthCheck: { kind: 'none' },
      restart: { kind: 'never' },
      cleanup: { staleAfterMs: 30_000 },
    });

    expect(result.success).toBe(false);
  });
});

describe('LocalServiceManagedRuntimeStateV1Schema', () => {
  it('keeps correlation diagnostics explicit before claiming a detected port', () => {
    const state = LocalServiceManagedRuntimeStateV1Schema.parse({
      v: 1,
      id: 'plugin-a:web',
      owner: { kind: 'plugin', pluginId: 'plugin-a' },
      phase: 'detecting',
      launchMode: 'detectAfterLaunch',
      process: { pid: 123, startedAt: 10 },
      routeName: 'plugin-a-web',
      diagnostics: [{ code: 'correlation_pending', message: 'Waiting for local service inventory' }],
    });

    expect(state.port).toBeUndefined();
    expect(state.diagnostics[0]?.code).toBe('correlation_pending');
  });

  it('publishes assigned environment variable constants from one owner', () => {
    expect(HAPPIER_LOCAL_SERVICE_ENV.PORT).toBe('PORT');
    expect(HAPPIER_LOCAL_SERVICE_ENV.HOST).toBe('HOST');
    expect(HAPPIER_LOCAL_SERVICE_ENV.PRIVATE_URL).toBe('HAPPIER_URL');
    expect(HAPPIER_LOCAL_SERVICE_ENV.PREVIEW_URL).toBe('HAPPIER_PREVIEW_URL');
  });
});
