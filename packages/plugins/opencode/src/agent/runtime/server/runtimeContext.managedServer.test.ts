import { describe, expect, it, vi } from 'vitest';
import type {
  AgentRuntimeContext,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { createOpenCodeRuntimeContext } from './runtimeContext.js';

describe('OpenCode managed-service runtime context', () => {
  it('forwards the exact public ManagedServices owner without a local spec or handle adapter', () => {
    const managedServices = {
      dependencies: {},
      supervise: vi.fn(),
    };
    const context = {
      signal: new AbortController().signal,
      services: {
        managedServices,
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

    expect(createOpenCodeRuntimeContext(request, context).managedServices)
      .toBe(managedServices);
  });
});
