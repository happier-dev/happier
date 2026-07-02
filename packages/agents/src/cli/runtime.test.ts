import { describe, expect, it } from 'vitest';

import * as agentCliRuntimeModule from './runtime.js';
import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from '../generated/bundledAgentDefinitions.js';
import { AGENT_IDS, AGENT_PROVIDER_IDS } from '../types.js';
import { LEGACY_CONFIGURED_BACKEND_SENTINEL_ID } from '../compat/legacyConfiguredBackend.js';
import {
  CANONICAL_AGENT_CLI_RUNTIME_SPECS,
  getAgentCliRuntimeSpec,
  getAgentCliSetupRecommendedIds,
  getAgentCliSetupSupportedIds,
  type AgentCliRuntimeSpec,
  AGENT_CLI_RUNTIME_SPECS,
} from './runtime.js';
import { legacyCustomAcpCompat } from '../index.js';
import { getAgentCliRuntimeSpecForLookupId } from './runtimeLookup.js';

describe('AGENT_CLI_RUNTIME_SPECS', () => {
  it('sources extracted Stage E runtime specs from generated plugin facts', () => {
    for (const providerId of ['auggie', 'kimi', 'kilo', 'copilot'] as const) {
      expect(getAgentCliRuntimeSpec(providerId)).toBe(
        BUNDLED_AGENT_DEFINITIONS_BY_ID[providerId].agentCliRuntime,
      );
    }
  });

  it('marks backend CLIs as system-first by default', () => {
    expect(getAgentCliRuntimeSpec('codex').sourcePreferenceDefault).toBe('system-first');
    expect(getAgentCliRuntimeSpec('gemini').sourcePreferenceDefault).toBe('system-first');
    expect(getAgentCliRuntimeSpec('claude').sourcePreferenceDefault).toBe('system-first');
  });

  it('declares managed binary sources for binary-backed CLIs', () => {
    expect(getAgentCliRuntimeSpec('codex')).toMatchObject({
      sourcePreferenceDefault: 'system-first',
      managedInstall: {
        kind: 'github_release_binary',
        binaryName: 'codex',
        githubRepo: 'openai/codex',
      },
    });
    expect(getAgentCliRuntimeSpec('ohMyPi')).toMatchObject({
      sourcePreferenceDefault: 'system-first',
      managedInstall: {
        kind: 'github_release_binary',
        binaryName: 'omp',
        githubRepo: 'can1357/oh-my-pi',
      },
    });
  });

  it('declares managed package sources for package-backed CLIs', () => {
    expect(getAgentCliRuntimeSpec('gemini')).toMatchObject({
      managedInstall: {
        kind: 'managed_package',
        packageName: '@google/gemini-cli',
        binaryName: 'gemini',
      },
    });
    expect(getAgentCliRuntimeSpec('qwen')).toMatchObject({
      managedInstall: {
        kind: 'managed_package',
        packageName: '@qwen-code/qwen-code',
        binaryName: 'qwen',
      },
    });
  });

  it('keeps vendor-recipe providers without managed installation metadata', () => {
    expect(getAgentCliRuntimeSpec('claude')).toMatchObject({
      title: 'Claude Code CLI',
      managedInstall: null,
      manualInstallKind: 'vendor_recipe',
      manualInstallRecipes: {
        darwin: [expect.objectContaining({ cmd: 'bash' })],
      },
      acceptsJavaScriptFileOverride: true,
      installGuideUrl: 'https://code.claude.com/docs/en/setup',
    });
    expect(getAgentCliRuntimeSpec('ohMyPi')).toMatchObject({
      acceptsJavaScriptFileOverride: true,
    });
    expect(getAgentCliRuntimeSpec('qwen')).toMatchObject({
      managedInstall: {
        kind: 'managed_package',
        packageName: '@qwen-code/qwen-code',
        binaryName: 'qwen',
      },
      manualInstallKind: 'command',
      manualInstallRecipes: null,
    });
  });

  it('keeps upstream manual install hints on the runtime catalog for vendor-recipe providers', () => {
    expect(JSON.stringify(getAgentCliRuntimeSpec('claude'))).toContain('claude.ai/install.sh');
    expect(JSON.stringify(getAgentCliRuntimeSpec('opencode'))).toContain('opencode.ai/install');
    expect(JSON.stringify(getAgentCliRuntimeSpec('opencode'))).toContain('npm install -g opencode-ai');
    expect(JSON.stringify(getAgentCliRuntimeSpec('kimi'))).toContain('code.kimi.com/install.sh');
  });

  it('declares Cursor as a system-first vendor CLI with cursor-agent as the primary binary', () => {
    const cursor = (AGENT_CLI_RUNTIME_SPECS as Readonly<Record<string, AgentCliRuntimeSpec>>).cursor;

    expect(cursor).toEqual(expect.objectContaining({
      id: 'cursor',
      title: 'Cursor Agent CLI',
      binaryName: 'cursor-agent',
      knownUserBinDirSuffixes: ['.local/bin'],
      sourcePreferenceDefault: 'system-first',
      managedInstall: null,
      manualInstallKind: 'vendor_recipe',
      acceptsJavaScriptFileOverride: false,
      installGuideUrl: 'https://cursor.com/docs/cli/installation',
      docsUrl: 'https://cursor.com/docs/cli',
    }));
  });

  it('keeps provider-specific setup guide links on the runtime catalog when they differ from general docs', () => {
    expect(getAgentCliRuntimeSpec('claude').installGuideUrl).toBe('https://code.claude.com/docs/en/setup');
    expect(getAgentCliRuntimeSpec('opencode').installGuideUrl).toBe('https://opencode.ai/docs');
    expect(getAgentCliRuntimeSpec('kimi').installGuideUrl).toBe('https://kimi.moonshot.cn/docs/cli');
    expect(getAgentCliRuntimeSpec('qwen').installGuideUrl).toBe('https://qwenlm.github.io/qwen-code-docs/');
    expect(getAgentCliRuntimeSpec('ohMyPi').installGuideUrl).toBe('https://github.com/can1357/oh-my-pi#via-bun-recommended');
    expect(getAgentCliRuntimeSpec('pi').installGuideUrl).toBe('https://github.com/badlogic/pi-mono');
    expect(getAgentCliRuntimeSpec('codex').installGuideUrl).toBeNull();
  });

  it('captures vendor-specific user bin directories on the runtime catalog', () => {
    expect(getAgentCliRuntimeSpec('claude')).toMatchObject({
      knownUserBinDirSuffixes: ['.local/bin'],
    });
    expect(getAgentCliRuntimeSpec('kimi')).toMatchObject({
      knownUserBinDirSuffixes: ['.local/bin'],
    });
    expect(getAgentCliRuntimeSpec('opencode')).toMatchObject({
      knownUserBinDirSuffixes: ['.opencode/bin', 'AppData/Roaming/npm'],
    });
    expect(getAgentCliRuntimeSpec('ohMyPi')).toMatchObject({
      knownUserBinDirSuffixes: ['.bun/bin'],
    });
    expect(getAgentCliRuntimeSpec('codex').knownUserBinDirSuffixes).toBeNull();
  });

  it('keeps manual-install metadata only when the provider intentionally exposes user-facing guidance', () => {
    expect(getAgentCliRuntimeSpec('codex').manualInstallRecipes).toBeNull();
    expect(getAgentCliRuntimeSpec('gemini').manualInstallRecipes).toBeNull();
    expect(getAgentCliRuntimeSpec('auggie').manualInstallRecipes).toBeNull();
    expect(getAgentCliRuntimeSpec('kilo').manualInstallRecipes).toBeNull();
    expect(getAgentCliRuntimeSpec('pi').manualInstallRecipes).toBeNull();
    expect(getAgentCliRuntimeSpec('copilot').manualInstallRecipes).toBeNull();
    expect(getAgentCliRuntimeSpec('qwen').manualInstallRecipes).toBeNull();
    expect(getAgentCliRuntimeSpec('ohMyPi')).toMatchObject({
      manualInstallKind: 'vendor_recipe',
      manualInstallRecipes: {
        darwin: [expect.objectContaining({ cmd: 'bun' })],
        linux: [expect.objectContaining({ cmd: 'bun' })],
        win32: [expect.objectContaining({ cmd: 'bun' })],
      },
    });
    expect(getAgentCliRuntimeSpec('opencode')).toMatchObject({
      manualInstallKind: 'vendor_recipe',
      manualInstallRecipes: {
        win32: [
          {
            cmd: 'cmd.exe',
            args: ['/c', 'npm install -g opencode-ai'],
          },
        ],
      },
    });
  });

  it('keeps the shared agent CLI runtime artifact map canonical-only', () => {
    expect(Object.keys(AGENT_CLI_RUNTIME_SPECS).sort()).toEqual([...AGENT_PROVIDER_IDS].sort());
  });

  it('keeps customAcp out of the canonical agent CLI runtime specs while preserving explicit compat lookup', () => {
    expect(Object.keys(CANONICAL_AGENT_CLI_RUNTIME_SPECS).sort()).toEqual(
      [...AGENT_IDS].filter((agentId) => agentId !== LEGACY_CONFIGURED_BACKEND_SENTINEL_ID).sort(),
    );
    expect(CANONICAL_AGENT_CLI_RUNTIME_SPECS).not.toHaveProperty(LEGACY_CONFIGURED_BACKEND_SENTINEL_ID);
    expect('LEGACY_CUSTOM_ACP_AGENT_CLI_RUNTIME_SPEC' in agentCliRuntimeModule).toBe(false);
    expect(legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec()).toMatchObject({
      id: LEGACY_CONFIGURED_BACKEND_SENTINEL_ID,
      title: 'Custom ACP',
      binaryName: 'custom-acp',
      sourcePreferenceDefault: 'system-first',
      managedInstall: null,
      manualInstallKind: 'none',
      acceptsJavaScriptFileOverride: false,
      docsUrl: null,
    });
    expect(getAgentCliRuntimeSpecForLookupId(LEGACY_CONFIGURED_BACKEND_SENTINEL_ID)).toEqual(
      legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec(),
    );
    expect(getAgentCliRuntimeSpecForLookupId('codex')).toEqual(getAgentCliRuntimeSpec('codex'));
  });

  it('derives the setup-supported provider list from installable runtime specs', () => {
    expect(getAgentCliSetupSupportedIds()).toEqual([
      'claude',
      'codex',
      'opencode',
      'gemini',
      'auggie',
      'qwen',
      'kimi',
      'kilo',
      'kiro',
      'cursor',
      'ohMyPi',
      'pi',
      'copilot',
    ]);
    expect(getAgentCliSetupSupportedIds()).not.toContain('customAcp');
  });

  it('derives the recommended setup provider list as an ordered subset of the supported providers', () => {
    const recommendedFromRuntimeSpecs = getAgentCliSetupSupportedIds()
      .map((providerId) => ({
        providerId,
        order: getAgentCliRuntimeSpec(providerId).setupRecommendation?.order,
      }))
      .filter((entry): entry is { providerId: AgentCliRuntimeSpec['id']; order: number } =>
        typeof entry.order === 'number',
      )
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.providerId);

    expect(getAgentCliSetupRecommendedIds()).toEqual([
      'claude',
      'codex',
      'gemini',
      'opencode',
    ]);
    expect(getAgentCliSetupRecommendedIds()).toEqual(recommendedFromRuntimeSpecs);
    expect(getAgentCliSetupRecommendedIds().every((providerId) =>
      getAgentCliSetupSupportedIds().includes(providerId),
    )).toBe(true);
  });
});
