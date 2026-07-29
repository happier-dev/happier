import { describe, expect, it } from 'vitest';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import type { AgentSessionConfigurationSnapshot } from '@happier-dev/plugin-sdk/agent-runtime';

import {
  buildAuggieAcpArgvFromSessionConfiguration,
} from './callbacks.js';
import { AUGGIE_ACP_RUNTIME_DEFINITION } from './definition.js';

describe('Auggie custom ACP parity', () => {
  it('observes one normalized VB4 permission value and scalar indexing option at the plugin leaf', () => {
    const permissionIntent = parsePermissionIntentAlias('workspace_write');
    expect(permissionIntent).toBe('safe-yolo');
    const configuration: AgentSessionConfigurationSnapshot = {
      mode: { value: null, updatedAtMs: 100 },
      model: { value: 'claude-sonnet-4', updatedAtMs: 90 },
      permissionIntent: { value: permissionIntent, updatedAtMs: 110 },
      options: {
        allowIndexing: { value: true, updatedAtMs: 80 },
      },
    };

    const argv = buildAuggieAcpArgvFromSessionConfiguration({
      baseArgs: ['--acp'],
      configuration,
    });

    expect(argv).toContain('--allow-indexing');
    expect(argv).toContain('save-file:allow');
    expect(argv).toContain('web-search:ask-user');
    expect(configuration.model).toEqual({ value: 'claude-sonnet-4', updatedAtMs: 90 });
    expect(Object.keys(configuration)).toEqual(['mode', 'model', 'permissionIntent', 'options']);
  });

  it('keeps static MCP, timeout, stderr, and tool policy in the plugin definition', () => {
    expect(AUGGIE_ACP_RUNTIME_DEFINITION).toMatchObject({
      timeouts: expect.any(Object),
      mcp: { policy: 'pass_through' },
      stderrRules: expect.any(Object),
      toolNameInference: expect.any(Object),
    });
  });
});
