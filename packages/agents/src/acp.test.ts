import { describe, expect, it } from 'vitest';

import { AGENT_PROVIDER_IDS_V1 } from '@happier-dev/protocol';

import {
  BUILT_IN_ACP_CONFIG,
  getBuiltInAcpConfig,
  hasBuiltInAcpConfig,
  isAcpSessionListingDeclared,
} from './acp.js';
import { getProviderCliRuntimeSpec } from './providers/providerCliRuntime.js';
import { getAgentSessionCapability } from './sessionControls/sessionCapabilities.js';
import { getAgentToolsCapability } from './tools.js';
import { AGENT_IDS, type AgentId } from './types.js';

const devinAgentId = 'devin' as AgentId;

describe('built-in ACP config', () => {
  it('keeps the built-in ACP allowlist explicit and drift-free', () => {
    expect(Object.keys(BUILT_IN_ACP_CONFIG).sort()).toEqual(['agy', 'codebuddy', 'customAcp', 'devin', 'droid', 'fx', 'kimi', 'kiro']);
  });

  it('declares CodeBuddy Code through its probed `--acp` contract and native permission modes', () => {
    expect(getBuiltInAcpConfig('codebuddy')).toEqual({
      agentId: 'codebuddy',
      launcher: { command: 'codebuddy', args: ['--acp'] },
      transportProfile: 'generic',
      supportsLoadSession: true,
      supportsModes: 'yes',
      supportsModels: 'yes',
      promptImageSupport: 'yes',
      mcpServers: 'pass',
      permissionModeMapping: {
        default: null,
        'read-only': 'dontAsk',
        'safe-yolo': 'auto',
        yolo: 'bypassPermissions',
        plan: 'plan',
      },
    });
    expect(isAcpSessionListingDeclared('codebuddy')).toBe(false);
  });

  it('declares FX and Factory Droid through provider-advertised generic ACP controls', () => {
    expect(getBuiltInAcpConfig('fx')).toMatchObject({
      launcher: { command: 'fx', args: ['acp'] },
      supportsLoadSession: true,
      supportsModes: 'yes',
      supportsModels: 'yes',
      mcpServers: 'pass',
    });
    expect(getBuiltInAcpConfig('droid')).toMatchObject({
      launcher: { command: 'droid', args: ['exec', '--output-format', 'acp'] },
      supportsLoadSession: true,
      supportsModes: 'yes',
      supportsModels: 'yes',
      mcpServers: 'pass',
    });
  });

  it('declares Agy through negotiated generic ACP controls without a permission override', () => {
    expect(getBuiltInAcpConfig('agy')).toEqual({
      agentId: 'agy',
      launcher: { command: 'agy', args: [] },
      transportProfile: 'generic',
      supportsLoadSession: true,
      supportsModes: 'auto',
      supportsModels: 'auto',
      promptImageSupport: 'auto',
      mcpServers: 'pass',
    });
  });

  it('declares current Kimi Code through standard negotiated ACP controls', () => {
    expect(getBuiltInAcpConfig('kimi')).toMatchObject({
      launcher: { command: 'kimi', args: ['acp'] },
      supportsLoadSession: true,
      supportsModes: 'no',
      supportsModels: 'yes',
      mcpServers: 'pass',
    });
    expect(getBuiltInAcpConfig('kimi')).not.toHaveProperty('permissionModeMapping');
  });

  it('keeps first-class Grok provider wiring out of the generic ACP catalog', () => {
    expect(hasBuiltInAcpConfig('grok')).toBe(false);
    expect(getBuiltInAcpConfig('grok')).toBeNull();
  });

  it('exposes Custom ACP as a built-in generic ACP agent family', () => {
    expect(hasBuiltInAcpConfig('customAcp')).toBe(true);
    expect(getBuiltInAcpConfig('customAcp')).toMatchObject({
      agentId: 'customAcp',
      launcher: {
        command: getProviderCliRuntimeSpec('customAcp').binaryName,
        args: [],
      },
      transportProfile: 'generic',
      supportsLoadSession: true,
      supportsModes: 'auto',
      supportsModels: 'auto',
      promptImageSupport: 'auto',
    });
  });

  it('exposes Kiro as a built-in generic ACP agent', () => {
    expect(hasBuiltInAcpConfig('kiro')).toBe(true);
    expect(getBuiltInAcpConfig('kiro')).toMatchObject({
      agentId: 'kiro',
      launcher: {
        command: getProviderCliRuntimeSpec('kiro').binaryName,
        args: ['acp'],
      },
      transportProfile: 'kiro',
      supportsLoadSession: true,
      supportsModes: 'yes',
      supportsModels: 'yes',
      promptImageSupport: 'yes',
    });
  });

  it('exposes Devin with its probed ACP contract and provider-default permission behavior', () => {
    expect(hasBuiltInAcpConfig(devinAgentId)).toBe(true);
    expect(getBuiltInAcpConfig(devinAgentId)).toMatchObject({
      agentId: 'devin',
      launcher: {
        command: getProviderCliRuntimeSpec(devinAgentId).binaryName,
        args: ['acp'],
      },
      transportProfile: 'generic',
      supportsLoadSession: true,
      supportsModes: 'yes',
      supportsModels: 'yes',
      promptImageSupport: 'yes',
      mcpServers: 'drop',
      permissionModeMapping: {
        default: null,
        'read-only': 'normal',
        'safe-yolo': 'accept-edits',
        yolo: 'dangerous',
        plan: null,
      },
    });
  });

  it('does not mark non-ACP shell-bridge providers as built-in ACP', () => {
    expect(hasBuiltInAcpConfig('gemini')).toBe(false);
    expect(hasBuiltInAcpConfig('pi')).toBe(false);
  });

  /**
   * The runner resolves Happier/custom MCP servers only for `native_mcp` delivery, then the
   * ACP backend decides whether those descriptors ride `session/new`/`session/load`. An agent
   * that declares ACP pass-through while declaring shell-bridge delivery therefore reaches the
   * provider with an empty MCP map — the declaration promises tools the runner never resolves.
   */
  it('never declares ACP MCP pass-through for an agent whose tools delivery is not native MCP', () => {
    const inconsistent = Object.values(BUILT_IN_ACP_CONFIG)
      .filter((config) => config !== undefined && config.mcpServers !== 'drop')
      .filter((config) => getAgentToolsCapability(config.agentId).delivery !== 'native_mcp')
      .map((config) => config.agentId);
    expect(inconsistent).toEqual([]);
  });

  it('keeps Kimi Code on native MCP delivery so its ACP pass-through carries real servers', () => {
    expect(getBuiltInAcpConfig('kimi')?.mcpServers).toBe('pass');
    expect(getAgentToolsCapability('kimi').delivery).toBe('native_mcp');
  });
});

describe('ACP session-listing declaration', () => {
  it('derives the listing declaration from the manifest capability, not a second ACP-local flag', () => {
    const declared = AGENT_IDS.filter((agentId) => isAcpSessionListingDeclared(agentId));
    expect(declared.sort()).toEqual(['auggie', 'copilot', 'devin', 'fx', 'kilo', 'kimi', 'qwen']);
    // Claude lists through its provider-native direct-session owner, not the generic ACP source.
    expect(getAgentSessionCapability('claude', 'sessionListing')).toBe('supported');
    expect(isAcpSessionListingDeclared('claude')).toBe(false);
    // Built-in ACP agent that does not declare listing.
    expect(isAcpSessionListingDeclared('droid')).toBe(false);
  });

  /**
   * The wire enum is transport admission for the direct-sessions RPC family. An agent that declares
   * ACP listing but is missing from it can never reach the daemon, so the surface would be dead.
   */
  it('keeps every ACP-listing agent admitted by the direct-sessions provider id contract', () => {
    const missing = AGENT_IDS
      .filter((agentId) => isAcpSessionListingDeclared(agentId))
      .filter((agentId) => !(AGENT_PROVIDER_IDS_V1 as readonly string[]).includes(agentId));
    expect(missing).toEqual([]);
  });
});
