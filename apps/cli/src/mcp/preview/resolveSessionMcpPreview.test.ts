import { describe, expect, it } from 'vitest';

import { resolveSessionMcpPreview } from './resolveSessionMcpPreview';

describe('resolveSessionMcpPreview detection warnings', () => {
  it('renders a detection warning that no Agent owns without an undefined Agent id', () => {
    const preview = resolveSessionMcpPreview({
      settings: { v: 1, strictMode: false, servers: [], bindings: [] },
      machineId: 'machine-1',
      directory: '/tmp/project',
      agentId: 'gemini',
      detectedServers: [],
      detectedWarnings: [
        { provider: 'gemini', code: 'parse_failed', path: '/tmp/project/.gemini/mcp.json' },
        { code: 'unsupported', path: 'plugin:config' },
      ],
    });

    expect(preview.warnings).toEqual([
      'gemini:parse_failed:/tmp/project/.gemini/mcp.json',
      'unattributed:unsupported:plugin:config',
    ]);
  });
});
