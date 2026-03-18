import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from '../types.js';
import {
  getProviderCliRuntimeSpec,
  PROVIDER_CLI_RUNTIME_SPECS,
} from './providerCliRuntime.js';
import {
  getProviderCliInstallGuideUrl,
  getProviderCliManualInstallSummaryLines,
} from './providerCliInstallGuidance.js';

describe('PROVIDER_CLI_RUNTIME_SPECS', () => {
  it('covers every built-in provider', () => {
    expect(Object.keys(PROVIDER_CLI_RUNTIME_SPECS).sort()).toEqual([...AGENT_IDS].sort());
  });

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
    expect(JSON.stringify(getProviderCliRuntimeSpec('kimi'))).toContain('code.kimi.com/install.sh');
  });

  it('keeps provider-specific setup guide links on the runtime catalog when they differ from general docs', () => {
    expect(getProviderCliRuntimeSpec('claude').installGuideUrl).toBe('https://code.claude.com/docs/en/setup');
    expect(getProviderCliRuntimeSpec('opencode').installGuideUrl).toBe('https://opencode.ai/docs');
    expect(getProviderCliRuntimeSpec('kimi').installGuideUrl).toBe('https://kimi.moonshot.cn/docs/cli');
    expect(getProviderCliRuntimeSpec('qwen').installGuideUrl).toBe('https://qwenlm.github.io/qwen-code-docs/');
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
      knownUserBinDirSuffixes: ['.opencode/bin'],
    });
    expect(getProviderCliRuntimeSpec('codex').knownUserBinDirSuffixes).toBeNull();
  });

  it('does not keep legacy manual install recipes for managed-install providers', () => {
    expect(getProviderCliRuntimeSpec('codex').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('gemini').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('auggie').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('kilo').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('pi').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('copilot').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('qwen').manualInstallRecipes).toBeNull();
  });
});

describe('provider CLI install guidance', () => {
  it('exposes the canonical install guide URL for providers with a dedicated guide', () => {
    expect(getProviderCliInstallGuideUrl('claude')).toBe('https://code.claude.com/docs/en/setup');
    expect(getProviderCliInstallGuideUrl('opencode')).toBe('https://opencode.ai/docs');
    expect(getProviderCliInstallGuideUrl('pi')).toBe('https://github.com/badlogic/pi-mono');
  });

  it('falls back to the provider docs URL when there is no dedicated guide', () => {
    expect(getProviderCliInstallGuideUrl('codex')).toBe('https://github.com/openai/codex');
  });

  it('summarizes multi-platform manual install commands', () => {
    const summaryLines = getProviderCliManualInstallSummaryLines('claude');
    expect(summaryLines).toContain('  macOS/Linux: curl -fsSL https://claude.ai/install.sh | bash');
    expect(summaryLines).toContain('  Windows (PowerShell): irm https://claude.ai/install.ps1 | iex');
  });
});
