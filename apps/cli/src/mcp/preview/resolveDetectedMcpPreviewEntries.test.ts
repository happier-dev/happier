import { describe, expect, it } from 'vitest';

import type { DetectedMcpServerV1 } from '@happier-dev/protocol';

import { resolveDetectedMcpPreviewEntries } from './resolveDetectedMcpPreviewEntries';

function createDetected(overrides: Partial<DetectedMcpServerV1>): DetectedMcpServerV1 {
  return {
    provider: 'codex',
    name: 'context7',
    transport: 'stdio',
    stdio: { command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] },
    envKeys: [],
    enabled: true,
    source: { kind: 'user', path: '/Users/test/.codex/config.toml' },
    ...overrides,
  };
}

describe('resolveDetectedMcpPreviewEntries', () => {
  it('returns read-only preview entries for the selected native backend', () => {
    const entries = resolveDetectedMcpPreviewEntries({
      agentId: 'codex',
      servers: [createDetected({})],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: 'codex',
      sourceKind: 'detected',
      availability: 'readOnly',
      scopeKind: 'providerUser',
      selected: true,
      selectable: false,
      headerKeyCount: 0,
      envKeyCount: 0,
    });
  });

  it('uses the higher-precedence project config when multiple detected entries share a name', () => {
    const entries = resolveDetectedMcpPreviewEntries({
      agentId: 'claude',
      servers: [
        createDetected({
          provider: 'claude',
          name: 'playwright',
          source: { kind: 'user', path: '/Users/test/.claude/settings.json' },
          enabled: true,
        }),
        createDetected({
          provider: 'claude',
          name: 'playwright',
          source: { kind: 'project', path: '/repo/.claude/settings.local.json' },
          enabled: false,
        }),
      ],
    });

    expect(entries).toEqual([]);
  });
});
