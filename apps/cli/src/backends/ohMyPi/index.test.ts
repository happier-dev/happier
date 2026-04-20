import { describe, expect, it } from 'vitest';

import { agent } from './index';

describe('backends/ohMyPi/index', () => {
  it('owns the provider-specific execution-surface hooks for the built-in ACP entry', () => {
    expect(agent.id).toBe('ohMyPi');
    expect(agent.cliSubcommand).toBe('ohMyPi');
    expect(agent.vendorResumeSupport).toBe('supported');
    expect(agent.getDirectSessionProviderOps).toBeTypeOf('function');
    expect(agent.getConnectedServicesMaterializer).toBeTypeOf('function');
    expect(agent.getTerminalRuntimeOps).toBeTypeOf('function');
    expect(agent.getBindings).toBeTypeOf('function');
  });
});
