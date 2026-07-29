import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntimeContext,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agent-runtime';

import { createOpenCodeRuntimeContext } from './runtimeContext.js';

describe('OpenCode managed-server runtime context', () => {
  it('launches the manifest-authorized OpenCode tool and authenticates its health probe', async () => {
    const snapshot = {
      id: 'opencode-server',
      instanceId: 'instance-1',
      state: 'healthy' as const,
      mode: 'managedSpawn' as const,
      baseUrl: 'http://127.0.0.1:49152',
      port: 49152,
      pid: 1234,
      startedAtMs: 1,
      lastHealthyAtMs: 2,
    };
    const supervise = vi.fn(async () => ({
      snapshot: () => snapshot,
      waitUntilHealthy: vi.fn(async () => snapshot),
      dispose: vi.fn(async () => undefined),
    }));
    const context = {
      signal: new AbortController().signal,
      services: {
        managed: { servers: { supervise } },
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        storage: {
          session: {
            get: vi.fn(),
            set: vi.fn(),
          },
        },
      },
      ui: {
        askQuestions: vi.fn(),
        requestApproval: vi.fn(),
      },
    } as unknown as AgentRuntimeContext;
    const request = {
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/repo',
    } satisfies AgentSessionOpenRequest;

    await createOpenCodeRuntimeContext(request, context).managedServer.supervise({
      id: 'opencode-server',
      mode: {
        kind: 'managed-spawn',
        credential: {
          envKey: 'OPENCODE_SERVER_PASSWORD',
          value: 'managed-server-password',
          httpHeader: {
            name: 'authorization',
            value: 'Basic managed-server-authorization',
          },
        },
      },
      launch: {
        kind: 'agent-cli',
        agentId: 'opencode',
        args: ['serve'],
      },
      healthCheck: {
        kind: 'http',
        path: '/global/health',
      },
    });

    expect(supervise).toHaveBeenCalledWith(
      expect.objectContaining({
        healthCheck: expect.objectContaining({
          headers: {
            authorization: 'Basic managed-server-authorization',
          },
        }),
        launch: expect.objectContaining({
          executable: { kind: 'systemTool', id: 'opencode-cli' },
          cwd: { root: 'workspace', relativePath: '' },
        }),
      }),
      expect.objectContaining({ signal: context.signal }),
    );
  });

  it('translates external attachment into the typed SVC09 no-launch lifecycle', async () => {
    const snapshot = {
      id: 'opencode-server',
      instanceId: 'instance-external',
      state: 'healthy' as const,
      mode: 'externalAttach' as const,
      baseUrl: 'http://127.0.0.1:49153',
      port: 49153,
      pid: null,
      startedAtMs: null,
      lastHealthyAtMs: 2,
    };
    const supervise = vi.fn(async () => ({
      snapshot: () => snapshot,
      waitUntilHealthy: vi.fn(async () => snapshot),
      dispose: vi.fn(async () => undefined),
    }));
    const context = {
      signal: new AbortController().signal,
      services: {
        managed: { servers: { supervise } },
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        storage: {
          session: {
            get: vi.fn(),
            set: vi.fn(),
          },
        },
      },
      ui: {
        askQuestions: vi.fn(),
        requestApproval: vi.fn(),
      },
    } as unknown as AgentRuntimeContext;
    const request = {
      kind: 'create',
      sessionId: 'session-external',
      cwd: '/repo',
    } satisfies AgentSessionOpenRequest;

    await createOpenCodeRuntimeContext(request, context).managedServer.supervise({
      id: 'opencode-server',
      mode: {
        kind: 'external-attach',
        baseUrl: 'http://127.0.0.1:49153',
      },
      healthCheck: {
        kind: 'http',
        path: '/global/health',
        timeoutMs: 5_000,
      },
    });

    expect(supervise).toHaveBeenCalledWith({
      id: 'opencode-server',
      mode: {
        kind: 'externalAttach',
        baseUrl: 'http://127.0.0.1:49153',
      },
      healthCheck: {
        kind: 'http',
        target: {
          kind: 'serverPath',
          path: '/global/health',
        },
        timeoutMs: 5_000,
      },
    }, {
      signal: context.signal,
    });
  });
});
