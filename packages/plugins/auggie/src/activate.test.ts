import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/experimental/acp';
import type { AgentRuntimeV1 } from '@happier-dev/plugin-sdk';
import { createAcpBackendEngine, readAcpBackendSpec } from '@happier-dev/plugin-sdk/experimental/acp';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

type AuggieBackendRegistration = Readonly<{
  agentId: string;
  create: (ctx: Readonly<{
    agentRuntime: Readonly<{
      acp: Readonly<{
        defineAcpBackend: (spec: AcpBackendSpecV1) => AgentRuntimeV1;
      }>;
    }>;
  }>) => AgentRuntimeV1 | Promise<AgentRuntimeV1>;
}>;

function readRegisteredBackend(registerAgentRuntime: ReturnType<typeof vi.fn>): AuggieBackendRegistration {
  const registration = registerAgentRuntime.mock.calls[0]?.[0];
  if (!registration || typeof registration !== 'object') {
    throw new Error('Expected Auggie activation to register a backend engine');
  }
  return registration as AuggieBackendRegistration;
}

describe('activate', () => {
  it('registers the Auggie ACP backend through the plugin API', async () => {
    const registerAgentRuntime = vi.fn();

    activate({ registerAgentRuntime });

    const registration = readRegisteredBackend(registerAgentRuntime);
    expect(registration.agentId).toBe('auggie');

    const engine = await registration.create({
      agentRuntime: {
        acp: {
          defineAcpBackend: createAcpBackendEngine,
        },
      },
    });
    const spec = readAcpBackendSpec(engine);

    expect(spec).toMatchObject({
      backendId: 'auggie',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'agent-cli',
          agentId: 'auggie',
          args: ['--acp'],
        },
      },
      sessionIdHeaderName: 'auggieSessionId',
      mcp: { policy: 'pass_through' },
      stderrRules: {
        statusErrors: expect.arrayContaining([
          expect.objectContaining({
            detail: 'Authentication error. Run `auggie login` or set AUGMENT_SESSION_AUTH in your environment.',
          }),
        ]),
      },
    });
    expect(spec.transport.timeouts).toMatchObject({
      initMs: 60_000,
      toolCallMs: 120_000,
      investigationToolCallMs: 600_000,
      toolKindTimeouts: {
        think: 30_000,
      },
    });
    expect(spec.toolNameInference).toMatchObject({
      investigationToolIdPatterns: ['investigat', 'index', 'search'],
      investigationToolKinds: ['investigation'],
    });
    expect(spec.callbacks?.argvBuilder).toBeTypeOf('function');
  });

  it('preserves Auggie allow-indexing and permission argv behavior in the ACP callback', async () => {
    const registerAgentRuntime = vi.fn();
    activate({ registerAgentRuntime });
    const registration = readRegisteredBackend(registerAgentRuntime);
    const engine = await registration.create({
      agentRuntime: {
        acp: {
          defineAcpBackend: createAcpBackendEngine,
        },
      },
    });
    const spec = readAcpBackendSpec(engine);
    const buildArgv = spec.callbacks?.argvBuilder;

    expect(buildArgv).toBeTypeOf('function');
    const argv = await Promise.resolve(buildArgv?.({
      baseArgs: ['--acp'],
      cwd: '/workspace',
      env: { HAPPIER_AUGGIE_ALLOW_INDEXING: '1' },
      permissionMode: 'read-only',
    }));

    expect(argv).toEqual(expect.arrayContaining([
      '--acp',
      '--allow-indexing',
      '--ask',
      '--permission',
      'launch-process:deny',
      '--permission',
      'write-process:deny',
      '--permission',
      'save-file:deny',
    ]));
  });
});
