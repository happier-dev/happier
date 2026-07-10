import type { AgentRuntimeV1 } from '@happier-dev/plugin-sdk';
import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/experimental/acp';
import { createAcpBackendEngine, readAcpBackendSpec } from '@happier-dev/plugin-sdk/experimental/acp';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

type KiroBackendRegistration = Readonly<{
  agentId: string;
  create: (ctx: Readonly<{
    agentRuntime: Readonly<{
      acp: Readonly<{
        defineAcpBackend: (spec: AcpBackendSpecV1) => AgentRuntimeV1;
      }>;
    }>;
  }>) => AgentRuntimeV1 | Promise<AgentRuntimeV1>;
}>;

describe('activate', () => {
  it('registers the Kiro ACP backend through the plugin API', async () => {
    const registerAgentRuntime = vi.fn();

    activate({ registerAgentRuntime });

    expect(registerAgentRuntime).toHaveBeenCalledTimes(1);
    const registration = registerAgentRuntime.mock.calls[0]?.[0] as KiroBackendRegistration | undefined;
    expect(registration?.agentId).toBe('kiro');

    const engine = await registration?.create({
      agentRuntime: {
        acp: {
          defineAcpBackend: createAcpBackendEngine,
        },
      },
    });

    expect(readAcpBackendSpec(engine as AgentRuntimeV1)).toMatchObject({
      backendId: 'kiro',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'agent-cli',
          agentId: 'kiro',
          args: ['acp'],
        },
      },
      auth: {
        config: {
          statusCommand: ['whoami', '--format', 'json'],
          parser: 'kiroWhoamiJson',
        },
      },
      sessionIdHeaderName: 'kiroSessionId',
      stderrRules: {
        suppress: [
          {
            includes: ['error handling notification', '_kiro.dev/', 'method not found'],
          },
        ],
      },
      mcp: { policy: 'pass_through' },
    });
  });
});
