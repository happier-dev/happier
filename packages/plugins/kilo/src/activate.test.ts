import type { AcpBackendSpecV1 } from '@happier-dev/plugin-sdk/acp';
import type { BackendEngineV1 } from '@happier-dev/plugin-sdk';
import { createAcpBackendEngine, readAcpBackendSpec } from '@happier-dev/plugin-sdk/acp';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

type KiloBackendRegistration = Readonly<{
  backendId: string;
  create: (ctx: Readonly<{
    acp: Readonly<{
      defineAcpBackend: (spec: AcpBackendSpecV1) => BackendEngineV1;
    }>;
  }>) => BackendEngineV1 | Promise<BackendEngineV1>;
}>;

function readRegisteredBackend(registerBackendEngine: ReturnType<typeof vi.fn>): KiloBackendRegistration {
  const registration = registerBackendEngine.mock.calls[0]?.[0];
  if (!registration || typeof registration !== 'object') {
    throw new Error('Expected Kilo activation to register a backend engine');
  }
  return registration as KiloBackendRegistration;
}

describe('Kilo activate', () => {
  it('registers the Kilo ACP backend through the plugin API', async () => {
    const registerBackendEngine = vi.fn();

    activate({ registerBackendEngine });

    const registration = readRegisteredBackend(registerBackendEngine);
    expect(registration.backendId).toBe('kilo');

    const engine = await registration.create({
      acp: {
        defineAcpBackend: createAcpBackendEngine,
      },
    });
    expect(readAcpBackendSpec(engine)).toMatchObject({
      backendId: 'kilo',
      transport: {
        kind: 'stdio',
        launch: {
          kind: 'agent-cli',
          agentId: 'kilo',
          args: ['acp'],
        },
      },
      sessionIdHeaderName: 'kiloSessionId',
      mcp: { policy: 'pass_through' },
    });
  });
});
