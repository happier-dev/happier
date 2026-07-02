import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/acp';
import type { BackendEngineV1 } from '@happier-dev/plugin-sdk';
import { createAcpBackendEngine, readAcpBackendSpec } from '@happier-dev/plugin-sdk/acp';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

type CopilotBackendRegistration = Readonly<{
  backendId: string;
  create: (ctx: Readonly<{
    acp: Readonly<{
      defineAcpBackend: (spec: AcpBackendSpecV1) => BackendEngineV1;
    }>;
  }>) => BackendEngineV1 | Promise<BackendEngineV1>;
}>;

function readRegisteredBackend(registerBackendEngine: ReturnType<typeof vi.fn>): CopilotBackendRegistration {
  const registration = registerBackendEngine.mock.calls[0]?.[0];
  if (!registration || typeof registration !== 'object') {
    throw new Error('Expected Copilot activation to register a backend engine');
  }
  return registration as CopilotBackendRegistration;
}

describe('Copilot activate', () => {
  it('registers the Copilot ACP backend through the plugin API', async () => {
    const registerBackendEngine = vi.fn();

    activate({ registerBackendEngine });

    const registration = readRegisteredBackend(registerBackendEngine);
    expect(registration.backendId).toBe('copilot');

    const engine = await registration.create({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
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
