import { describe, expect, it } from 'vitest';

import { resolveConfiguredAgentRuntimeKindFromUiBehavior } from '@/agents/registry/registryUiBehavior';
import { resolveIdleCompactionDeclaration } from './AgentIdleCompactionRows';

/**
 * Claude's runtime choice is its own Account plugin setting. The rows feed that snapshot through the
 * real registry interpreter, so the unified terminal (native: size only) never offers a cache window.
 */
function windowHonoured(unifiedTerminal: boolean | undefined): boolean {
  const configuredRuntimeKind = resolveConfiguredAgentRuntimeKindFromUiBehavior(
    {
      agentId: 'claude',
      settings: {},
      pluginSettings:
        unifiedTerminal === undefined
          ? null
          : { account: { claudeUnifiedTerminalEnabled: unifiedTerminal } },
    },
  );
  const declaration = resolveIdleCompactionDeclaration({
    bundledAgentId: 'claude',
    configuredRuntimeKind,
    projectedCompaction: null,
  });
  return declaration?.configured?.mode === 'host';
}

describe('Claude cache window follows the configured runtime', () => {
  it('hides the window under the unified terminal', () => {
    expect(windowHonoured(true)).toBe(false);
  });

  it('offers it on the Agent SDK, explicitly chosen or by default', () => {
    expect(windowHonoured(false)).toBe(true);
    expect(windowHonoured(undefined)).toBe(true);
  });
});
