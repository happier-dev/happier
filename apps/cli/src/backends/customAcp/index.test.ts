import { describe, expect, it } from 'vitest';

import { agent } from './index';

describe('backends/customAcp/index', () => {
  it('keeps customAcp behind an explicit compat-only backend entrypoint', async () => {
    expect(agent.id).toBe('customAcp');
    expect(agent.cliSubcommand).toBe('customAcp');
    expect(agent.getAcpBackendFactory).toBeTypeOf('function');
    expect(agent.getRuntimeCore).toBeTypeOf('function');
    expect(agent.vendorResumeSupport).toBe('unsupported');
    await expect(agent.getCliCommandHandler?.()).resolves.toBeTypeOf('function');
  });
});
