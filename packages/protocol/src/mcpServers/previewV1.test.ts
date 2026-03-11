import { describe, expect, it } from 'vitest';

import { DaemonMcpServersPreviewRequestSchema, DaemonMcpServersPreviewResponseSchema } from './previewV1.js';

describe('DaemonMcpServersPreview schemas', () => {
  it('accepts a preview request with a session selection override', () => {
    const parsed = DaemonMcpServersPreviewRequestSchema.parse({
      machineId: 'machine-1',
      directory: '/repo',
      agentId: 'codex',
      selection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-a'],
        forceExcludeServerIds: ['server-b'],
      },
    });

    expect(parsed.agentId).toBe('codex');
    expect(parsed.selection?.forceIncludeServerIds).toEqual(['server-a']);
  });

  it('accepts a successful preview response with built-in, managed, and detected entries', () => {
    const parsed = DaemonMcpServersPreviewResponseSchema.parse({
      ok: true,
      builtIn: [
        {
          key: 'built-in:happier',
          name: 'happier',
          transport: 'stdio',
          authMode: 'none',
          selected: true,
          selectable: false,
          availability: 'active',
          sourceKind: 'builtIn',
          scopeKind: 'builtIn',
        },
      ],
      managed: [
        {
          key: 'managed:server-a',
          serverId: 'server-a',
          name: 'playwright',
          transport: 'stdio',
          authMode: 'none',
          selected: true,
          selectable: true,
          availability: 'active',
          sourceKind: 'managed',
          scopeKind: 'machine',
          reasonCode: 'active_by_default',
          portability: 'portable',
          defaultSelected: true,
        },
      ],
      detected: [
        {
          key: 'detected:codex:context7',
          name: 'context7',
          transport: 'stdio',
          authMode: 'unknown',
          selected: true,
          selectable: false,
          availability: 'readOnly',
          sourceKind: 'detected',
          scopeKind: 'providerUser',
          provider: 'codex',
          envKeyCount: 0,
          headerKeyCount: 0,
          enabled: true,
          sourcePath: '/Users/test/.codex/config.toml',
        },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error('expected preview success');
    }
    expect(parsed.builtIn[0]?.name).toBe('happier');
    expect(parsed.managed[0]?.reasonCode).toBe('active_by_default');
    expect(parsed.detected[0]?.provider).toBe('codex');
  });
});
