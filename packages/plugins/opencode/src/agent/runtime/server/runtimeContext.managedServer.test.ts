import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntimeContext,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { resolveOpenCodeManagedServerDialect } from './managedServerDialect.js';
import { createOpenCodeRuntimeContext } from './runtimeContext.js';

describe('OpenCode managed-service runtime context', () => {
  it('keeps the host version probe reachable through the real runtime projection', async () => {
    const managedServices = {
      dependencies: {},
      supervise: vi.fn(),
    };
    const context = {
      signal: new AbortController().signal,
      services: {
        managedServices,
        exec: {
          systemTools: { resolve: async () => ({ executablePath: '/managed/opencode', executable: { kind: 'systemTool', id: 'opencode-cli' } }) },
          run: async () => ({ termination: { observed: { kind: 'exit', exitCode: 0 } }, stdout: new TextEncoder().encode('opencode v2.2.5\n') }),
        },
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        storage: {
          daemonSession: {
            get: vi.fn(),
            set: vi.fn(),
          },
        },
        interactions: {
          askQuestions: vi.fn(),
          requestApproval: vi.fn(),
        },
      },
    } as unknown as AgentRuntimeContext;
    const request = {
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/repo',
    } satisfies AgentSessionOpenRequest;

    const runtime = createOpenCodeRuntimeContext(request, context);
    expect(runtime.managedServices).toBe(managedServices);
    // R1112A: projecting only systemTools silently selected V1 against native V2,
    // so POST /session failed with 405 before any inference request.
    await expect(resolveOpenCodeManagedServerDialect({ exec: runtime.exec, systemToolId: 'opencode-cli' }))
      .resolves.toEqual({ dialect: 'v2', healthPath: '/api/info' });
  });
});
