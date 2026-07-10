import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/experimental/acp';
import type { AgentRuntimeV1 } from '@happier-dev/plugin-sdk';
import { createAcpBackendEngine, readAcpBackendSpec } from '@happier-dev/plugin-sdk/experimental/acp';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

type QwenBackendRegistration = Readonly<{
  agentId: string;
  create: (ctx: Readonly<{
    agentRuntime: Readonly<{
      acp: Readonly<{
        defineAcpBackend: (spec: AcpBackendSpecV1) => AgentRuntimeV1;
      }>;
    }>;
  }>) => AgentRuntimeV1 | Promise<AgentRuntimeV1>;
}>;

function readRegisteredBackend(registerAgentRuntime: ReturnType<typeof vi.fn>): QwenBackendRegistration {
  const registration = registerAgentRuntime.mock.calls[0]?.[0];
  if (!registration || typeof registration !== 'object') {
    throw new Error('Expected Qwen activation to register a backend engine');
  }
  return registration as QwenBackendRegistration;
}

describe('activate', () => {
  it('registers the Qwen ACP backend through the plugin API', async () => {
    const registerAgentRuntime = vi.fn();

    activate({ registerAgentRuntime });

    const registration = readRegisteredBackend(registerAgentRuntime);
    expect(registration.agentId).toBe('qwen');

    const engine = await registration.create({
      agentRuntime: {
        acp: {
          defineAcpBackend: createAcpBackendEngine,
        },
      },
    });
    expect(readAcpBackendSpec(engine)).toMatchObject({
      backendId: 'qwen',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'agent-cli',
          agentId: 'qwen',
          args: ['--acp'],
        },
      },
      permissionModeArgv: {
        flag: '--approval-mode',
        map: {
          default: null,
          'safe-yolo': 'auto-edit',
          yolo: 'yolo',
        },
      },
      sessionIdHeaderName: 'qwenSessionId',
      mcp: { policy: 'pass_through' },
    });
  });
});
