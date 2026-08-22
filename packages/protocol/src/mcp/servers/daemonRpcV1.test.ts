import { describe, expect, it } from 'vitest';

import {
  DaemonMcpServersDetectRequestSchema,
  DaemonMcpServersDetectWarningV1Schema,
  DetectedMcpServerV1Schema,
  McpDetectedProviderV1Schema,
} from './daemonRpcV1';

/**
 * Every Agent id the host bundles today, plus an externally contributed one.
 * MCP detection identity is Agent identity: it is open by contract, so no
 * static protocol enum may decide which Agents are allowed to be detected.
 */
const INSTALLED_AGENT_IDS = [
  'claude',
  'codex',
  'opencode',
  'antigravity',
  'gemini',
  'grok',
  'auggie',
  'qwen',
  'kimi',
  'kilo',
  'kiro',
  'cursor',
  'ohMyPi',
  'pi',
  'copilot',
  'coderabbit',
  'deepsec',
  'acme.cli',
] as const;

function remoteServer(provider: string) {
  return {
    provider,
    name: 'docs',
    transport: 'http',
    remote: { url: 'https://mcp.example.test/http', headers: [] },
    envKeys: [],
    enabled: null,
    source: { kind: 'user', path: 'plugin:config' },
  };
}

describe('MCP detection Agent identity on the V1 wire', () => {
  it('admits every installed Agent id, bundled or externally contributed', () => {
    for (const agentId of INSTALLED_AGENT_IDS) {
      expect(McpDetectedProviderV1Schema.parse(agentId)).toBe(agentId);
      expect(DetectedMcpServerV1Schema.safeParse(remoteServer(agentId)).success).toBe(true);
      expect(DaemonMcpServersDetectWarningV1Schema.safeParse({
        provider: agentId,
        code: 'parse_failed',
      }).success).toBe(true);
    }

    expect(DaemonMcpServersDetectRequestSchema.safeParse({
      machineId: 'machine-1',
      providers: [...INSTALLED_AGENT_IDS],
    }).success).toBe(true);
  });

  it('still rejects an unusable Agent id rather than accepting any string', () => {
    expect(McpDetectedProviderV1Schema.safeParse('').success).toBe(false);
    expect(McpDetectedProviderV1Schema.safeParse(' claude ').success).toBe(false);
    expect(McpDetectedProviderV1Schema.safeParse('a'.repeat(129)).success).toBe(false);
    expect(McpDetectedProviderV1Schema.safeParse(7).success).toBe(false);
  });

  it('carries a detection warning that no Agent owns so an unresolvable source stays visible', () => {
    const parsed = DaemonMcpServersDetectWarningV1Schema.safeParse({
      code: 'unsupported',
      path: 'plugin:acme.config',
      detail: 'Plugin MCP discovery source declares no Agent id',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.provider).toBeUndefined();
  });
});
