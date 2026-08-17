import { describe, expect, it, vi } from 'vitest';

import {
  registerOpenCodeMcpServers,
} from './mcpRegistration.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';

function createRegistrationHarness() {
  const debug = vi.fn();
  const mcpAdd = vi.fn<OpenCodeServerClient['mcpAdd']>(async () => ({ status: 'connected' }));
  return {
    ctx: {
      logger: { debug },
    } as unknown as OpenCodeRuntimeContext,
    client: { mcpAdd } as unknown as OpenCodeServerClient,
    debug,
    mcpAdd,
  };
}

describe('registerOpenCodeMcpServers', () => {
  it('settles required Happier readiness after an earlier optional registration finishes', async () => {
    const harness = createRegistrationHarness();
    let resolveOptional!: () => void;
    harness.mcpAdd.mockImplementation(async ({ name }) => {
      if (name === 'slow_custom') {
        await new Promise<void>((resolve) => {
          resolveOptional = resolve;
        });
      }
      return { status: 'connected' as const };
    });

    const registration = registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpServers: {
        slow_custom: { command: '/bin/custom' },
        happier: { command: '/bin/happier-mcp' },
      },
    });

    await Promise.resolve();
    expect(harness.mcpAdd).toHaveBeenCalledTimes(1);

    resolveOptional();

    await expect(registration).resolves.toEqual({
      requiredHappier: { status: 'ready' },
    });
    expect(harness.mcpAdd).toHaveBeenNthCalledWith(2, {
      directory: '/repo',
      name: 'happier',
      config: {
        type: 'local',
        enabled: true,
        command: ['/bin/happier-mcp'],
      },
    });
  });

  it('keeps optional failures non-fatal but reports a required Happier failure', async () => {
    const optionalFailureHarness = createRegistrationHarness();
    optionalFailureHarness.mcpAdd
      .mockResolvedValueOnce({ status: 'disabled' })
      .mockResolvedValueOnce({ status: 'connected' });

    await expect(registerOpenCodeMcpServers({
      ctx: optionalFailureHarness.ctx,
      client: optionalFailureHarness.client,
      directory: '/repo',
      mcpServers: {
        optional: { command: '/bin/optional' },
        happier: { command: '/bin/happier-mcp' },
      },
    })).resolves.toEqual({ requiredHappier: { status: 'ready' } });

    const requiredFailureHarness = createRegistrationHarness();
    const requiredError = new Error('required add failed');
    requiredFailureHarness.mcpAdd.mockRejectedValueOnce(requiredError);

    await expect(registerOpenCodeMcpServers({
      ctx: requiredFailureHarness.ctx,
      client: requiredFailureHarness.client,
      directory: '/repo',
      mcpServers: {
        happier: { command: '/bin/happier-mcp' },
      },
    })).resolves.toEqual({
      requiredHappier: { status: 'failed', error: requiredError },
    });
  });

  it('reports an HTTP-200 non-connected Happier status as a required failure', async () => {
    const harness = createRegistrationHarness();
    harness.mcpAdd.mockResolvedValueOnce({
      status: 'failed',
      error: 'bridge tools unavailable',
    } as never);

    const result = await registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpServers: {
        happier: { command: '/bin/happier-mcp' },
      },
    });

    expect(result.requiredHappier).toMatchObject({
      status: 'failed',
      error: expect.objectContaining({
        message: expect.stringMatching(/bridge tools unavailable/iu),
      }),
    });
  });

  it('reports missing required Happier configuration as a settled failure', async () => {
    const harness = createRegistrationHarness();

    await expect(registerOpenCodeMcpServers({
      ctx: harness.ctx,
      client: harness.client,
      directory: '/repo',
      mcpServers: undefined,
    })).resolves.toMatchObject({
      requiredHappier: {
        status: 'failed',
        error: expect.objectContaining({
          message: 'required Happier MCP server configuration is missing',
        }),
      },
    });
    expect(harness.mcpAdd).not.toHaveBeenCalled();
  });
});
