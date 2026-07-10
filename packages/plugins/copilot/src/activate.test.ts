import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/experimental/acp';
import type { AgentRuntimeV1 } from '@happier-dev/plugin-sdk';
import { createAcpBackendEngine, readAcpBackendSpec } from '@happier-dev/plugin-sdk/experimental/acp';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

type CopilotBackendRegistration = Readonly<{
  agentId: string;
  create: (ctx: Readonly<{
    agentRuntime: Readonly<{
      acp: Readonly<{
        defineAcpBackend: (spec: AcpBackendSpecV1) => AgentRuntimeV1;
      }>;
    }>;
  }>) => AgentRuntimeV1 | Promise<AgentRuntimeV1>;
}>;

function readRegisteredBackend(registerAgentRuntime: ReturnType<typeof vi.fn>): CopilotBackendRegistration {
  const registration = registerAgentRuntime.mock.calls[0]?.[0];
  if (!registration || typeof registration !== 'object') {
    throw new Error('Expected Copilot activation to register a backend engine');
  }
  return registration as CopilotBackendRegistration;
}

describe('Copilot activate', () => {
  it('registers the Copilot ACP backend through the plugin API', async () => {
    const registerAgentRuntime = vi.fn();

    activate({ registerAgentRuntime });

    const registration = readRegisteredBackend(registerAgentRuntime);
    expect(registration.agentId).toBe('copilot');

    const engine = await registration.create({
      agentRuntime: {
        acp: {
          defineAcpBackend: createAcpBackendEngine,
        },
      },
    });
    expect(readAcpBackendSpec(engine)).toMatchObject({
      backendId: 'copilot',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'agent-cli',
          agentId: 'copilot',
          args: ['--acp'],
        },
      },
      sessionIdHeaderName: 'copilotSessionId',
      mcp: { policy: 'pass_through' },
    });
  });
});
