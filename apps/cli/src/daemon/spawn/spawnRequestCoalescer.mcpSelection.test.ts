import { describe, expect, it } from 'vitest';
import { computeDaemonSpawnRequestKey } from './spawnRequestCoalescer';

describe('spawn MCP tool delivery identity', () => {
  it('keeps distinct Team model resources distinct in the admitted request identity', () => {
    const modelSelection = { v: 2 as const, updatedAt: 1, ref: { source: 'team_resource' as const,
      teamId: 'team', resourceId: 'first', expectedResourceRevision: 1, deliveryMode: 'direct' as const,
      agentTargetKey: 'backend:claude', modelId: 'model' } };
    const first = computeDaemonSpawnRequestKey({ directory: '/project', modelSelection });
    const other = computeDaemonSpawnRequestKey({ directory: '/project', modelSelection: {
      ...modelSelection, ref: { ...modelSelection.ref, resourceId: 'other' },
    } });
    expect(first.key).not.toBe(other.key);
  });

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
