import { describe, expect, it } from 'vitest';
import { computeDaemonSpawnRequestKey } from './spawnRequestCoalescer';

describe('spawn MCP tool delivery identity', () => {
  it('keeps built-in opt-out distinct while preserving the enabled default', () => {
    const options = { directory: '/tmp/project', capabilitySelection: { mcp: {
      v: 1 as const, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [],
    } } };
    const implicit = computeDaemonSpawnRequestKey(options);
    const explicit = computeDaemonSpawnRequestKey({ ...options, capabilitySelection: {
      mcp: { ...options.capabilitySelection.mcp, happierToolsEnabled: true },
    } });
    const disabled = computeDaemonSpawnRequestKey({ ...options, capabilitySelection: {
      mcp: { ...options.capabilitySelection.mcp, happierToolsEnabled: false },
    } });
    expect(explicit.key).toBe(implicit.key);
    expect(disabled.key).not.toBe(implicit.key);
  });
});
