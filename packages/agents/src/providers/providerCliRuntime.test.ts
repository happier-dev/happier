import { describe, expect, it } from 'vitest';

import * as providerCliRuntimeModule from './providerCliRuntime.js';
import { AGENT_IDS, CANONICAL_AGENT_IDS } from '../types.js';
import { LEGACY_CONFIGURED_BACKEND_SENTINEL_ID } from '../compat/legacyConfiguredBackend.js';
import {
  CANONICAL_PROVIDER_CLI_RUNTIME_SPECS,
  getProviderCliRuntimeSpec,
  getProviderCliSetupRecommendedIds,
  getProviderCliSetupSupportedIds,
  PROVIDER_CLI_RUNTIME_SPECS,
} from './providerCliRuntime.js';
import { legacyCustomAcpCompat } from '../index.js';
import { getProviderCliRuntimeSpecForLookupId } from './providerCliRuntimeLookup.js';

describe('PROVIDER_CLI_RUNTIME_SPECS', () => {
  it('marks backend CLIs as system-first by default', () => {
    expect(getProviderCliRuntimeSpec('codex').sourcePreferenceDefault).toBe('system-first');
    expect(getProviderCliRuntimeSpec('gemini').sourcePreferenceDefault).toBe('system-first');
    expect(getProviderCliRuntimeSpec('claude').sourcePreferenceDefault).toBe('system-first');
  });

  it('declares managed binary sources for binary-backed CLIs', () => {
    expect(getProviderCliRuntimeSpec('codex')).toMatchObject({
      sourcePreferenceDefault: 'system-first',
      managedInstall: {
        kind: 'github_release_binary',
        binaryName: 'codex',
        githubRepo: 'openai/codex',
      },
    });
    expect(getProviderCliRuntimeSpec('ohMyPi')).toMatchObject({
      sourcePreferenceDefault: 'system-first',
      managedInstall: {
        kind: 'github_release_binary',
        binaryName: 'omp',
        githubRepo: 'can1357/oh-my-pi',
      },
    });
  });

  it('declares managed package sources for package-backed CLIs', () => {
    expect(getProviderCliRuntimeSpec('gemini')).toMatchObject({
      managedInstall: {
        kind: 'managed_package',
        packageName: '@google/gemini-cli',
        binaryName: 'gemini',
      },
    });
    expect(getProviderCliRuntimeSpec('qwen')).toMatchObject({
      managedInstall: {
        kind: 'managed_package',
        packageName: '@qwen-code/qwen-code',
        binaryName: 'qwen',
      },
    });
  });

  it('keeps vendor-recipe providers without managed installation metadata', () => {
    expect(getProviderCliRuntimeSpec('claude')).toMatchObject({
      title: 'Claude Code CLI',
      managedInstall: null,
      manualInstallKind: 'vendor_recipe',
      manualInstallRecipes: {
        darwin: [expect.objectContaining({ cmd: 'bash' })],
      },
      acceptsJavaScriptFileOverride: true,
      installGuideUrl: 'https://code.claude.com/docs/en/setup',
    });
    expect(getProviderCliRuntimeSpec('ohMyPi')).toMatchObject({
      acceptsJavaScriptFileOverride: true,
    });
    expect(getProviderCliRuntimeSpec('qwen')).toMatchObject({
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
    expect(JSON.stringify(getProviderCliRuntimeSpec('claude'))).toContain('claude.ai/install.sh');
    expect(JSON.stringify(getProviderCliRuntimeSpec('opencode'))).toContain('opencode.ai/install');
    expect(JSON.stringify(getProviderCliRuntimeSpec('opencode'))).toContain('npm install -g opencode-ai');
    expect(JSON.stringify(getProviderCliRuntimeSpec('kimi'))).toContain('code.kimi.com/install.sh');
  });

  it('keeps provider-specific setup guide links on the runtime catalog when they differ from general docs', () => {
    expect(getProviderCliRuntimeSpec('claude').installGuideUrl).toBe('https://code.claude.com/docs/en/setup');
    expect(getProviderCliRuntimeSpec('opencode').installGuideUrl).toBe('https://opencode.ai/docs');
    expect(getProviderCliRuntimeSpec('kimi').installGuideUrl).toBe('https://kimi.moonshot.cn/docs/cli');
    expect(getProviderCliRuntimeSpec('qwen').installGuideUrl).toBe('https://qwenlm.github.io/qwen-code-docs/');
    expect(getProviderCliRuntimeSpec('ohMyPi').installGuideUrl).toBe('https://github.com/can1357/oh-my-pi#via-bun-recommended');
    expect(getProviderCliRuntimeSpec('pi').installGuideUrl).toBe('https://github.com/badlogic/pi-mono');
    expect(getProviderCliRuntimeSpec('codex').installGuideUrl).toBeNull();
  });

  it('captures vendor-specific user bin directories on the runtime catalog', () => {
    expect(getProviderCliRuntimeSpec('claude')).toMatchObject({
      knownUserBinDirSuffixes: ['.local/bin'],
    });
    expect(getProviderCliRuntimeSpec('kimi')).toMatchObject({
      knownUserBinDirSuffixes: ['.local/bin'],
    });
    expect(getProviderCliRuntimeSpec('opencode')).toMatchObject({
      knownUserBinDirSuffixes: ['.opencode/bin', 'AppData/Roaming/npm'],
    });
    expect(getProviderCliRuntimeSpec('ohMyPi')).toMatchObject({
      knownUserBinDirSuffixes: ['.bun/bin'],
    });
    expect(getProviderCliRuntimeSpec('codex').knownUserBinDirSuffixes).toBeNull();
  });

  it('keeps manual-install metadata only when the provider intentionally exposes user-facing guidance', () => {
    expect(getProviderCliRuntimeSpec('codex').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('gemini').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('auggie').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('kilo').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('pi').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('copilot').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('qwen').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('ohMyPi')).toMatchObject({
      manualInstallKind: 'vendor_recipe',
      manualInstallRecipes: {
        darwin: [expect.objectContaining({ cmd: 'bun' })],
        linux: [expect.objectContaining({ cmd: 'bun' })],
        win32: [expect.objectContaining({ cmd: 'bun' })],
      },
    });
    expect(getProviderCliRuntimeSpec('opencode')).toMatchObject({
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

  it('keeps the shared provider CLI runtime artifact map canonical-only', () => {
    expect(Object.keys(PROVIDER_CLI_RUNTIME_SPECS).sort()).toEqual([...CANONICAL_AGENT_IDS].sort());
  });

  it('keeps customAcp out of the canonical provider CLI runtime specs while preserving explicit compat lookup', () => {
    expect(Object.keys(CANONICAL_PROVIDER_CLI_RUNTIME_SPECS).sort()).toEqual(
      [...AGENT_IDS].filter((agentId) => agentId !== LEGACY_CONFIGURED_BACKEND_SENTINEL_ID).sort(),
    );
    expect(CANONICAL_PROVIDER_CLI_RUNTIME_SPECS).not.toHaveProperty(LEGACY_CONFIGURED_BACKEND_SENTINEL_ID);
    expect('LEGACY_CUSTOM_ACP_PROVIDER_CLI_RUNTIME_SPEC' in providerCliRuntimeModule).toBe(false);
    expect(legacyCustomAcpCompat.getLegacyCustomAcpProviderCliRuntimeSpec()).toMatchObject({
      id: LEGACY_CONFIGURED_BACKEND_SENTINEL_ID,
      title: 'Custom ACP',
      binaryName: 'custom-acp',
      sourcePreferenceDefault: 'system-first',
      managedInstall: null,
      manualInstallKind: 'none',
      acceptsJavaScriptFileOverride: false,
      docsUrl: null,
    });
    expect(getProviderCliRuntimeSpecForLookupId(LEGACY_CONFIGURED_BACKEND_SENTINEL_ID)).toEqual(
      legacyCustomAcpCompat.getLegacyCustomAcpProviderCliRuntimeSpec(),
    );
    expect(getProviderCliRuntimeSpecForLookupId('codex')).toEqual(getProviderCliRuntimeSpec('codex'));
  });

  it('derives the setup-supported provider list from installable runtime specs', () => {
    expect(getProviderCliSetupSupportedIds()).toEqual([
      'claude',
      'codex',
      'opencode',
      'gemini',
      'auggie',
      'qwen',
      'kimi',
      'kilo',
      'kiro',
      'ohMyPi',
      'pi',
      'copilot',
    ]);
    expect(getProviderCliSetupSupportedIds()).not.toContain('customAcp');
  });

  it('derives the recommended setup provider list as an ordered subset of the supported providers', () => {
    expect(getProviderCliSetupRecommendedIds()).toEqual([
      'claude',
      'codex',
      'gemini',
      'opencode',
    ]);
    expect(getProviderCliSetupRecommendedIds().every((providerId) =>
      getProviderCliSetupSupportedIds().includes(providerId),
    )).toBe(true);
  });
});
