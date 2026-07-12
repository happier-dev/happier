import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from '../types.js';
import type { AgentId } from '../types.js';
import {
  getProviderCliBinaryNames,
  getProviderCliRuntimeSpec,
  PROVIDER_CLI_RUNTIME_SPECS,
} from './providerCliRuntime.js';

const cursorAgentId = 'cursor' as AgentId;

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
  });

  it('declares managed package sources for package-backed CLIs', () => {
    expect(getProviderCliRuntimeSpec('opencode')).toMatchObject({
      managedInstall: {
        kind: 'managed_package',
        packageName: 'opencode-ai',
        binaryName: 'opencode',
        packageBinarySetup: { kind: 'opencode_platform_binary' },
      },
    });
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

  it('captures ordered provider CLI fallback candidates on the runtime catalog', () => {
    expect(getProviderCliRuntimeSpec('claude').knownCommandCandidates).toEqual([
      { kind: 'homeBinDir', relativeDir: '.local/bin' },
      { kind: 'homeVersionedDir', relativeDir: '.local/share/claude/versions' },
      { kind: 'homePath', relativePath: '.claude/local/cli.js' },
      { kind: 'absolutePath', path: '/opt/homebrew/bin/claude' },
      { kind: 'absolutePath', path: '/usr/local/bin/claude' },
      { kind: 'absolutePath', path: '/home/linuxbrew/.linuxbrew/bin/claude' },
      { kind: 'homePath', relativePath: '.bun/bin/claude' },
      { kind: 'homePath', relativePath: 'AppData/Local/Claude/claude.exe' },
      { kind: 'homeVersionedDir', relativeDir: 'AppData/Local/Claude/versions' },
      { kind: 'homePath', relativePath: '.claude/claude.exe' },
      { kind: 'homeVersionedDir', relativeDir: '.claude/versions' },
      { kind: 'homePath', relativePath: '.local/bin/claude.exe' },
    ]);
    expect(getProviderCliRuntimeSpec('kimi').knownCommandCandidates).toEqual([
      { kind: 'homeBinDir', relativeDir: '.local/bin' },
    ]);
    expect(getProviderCliRuntimeSpec('opencode').knownCommandCandidates).toEqual([
      { kind: 'homeBinDir', relativeDir: '.opencode/bin' },
      { kind: 'homePath', relativePath: 'AppData/Roaming/npm/opencode.cmd' },
    ]);
    expect(getProviderCliRuntimeSpec('codex').knownCommandCandidates).toBeNull();
    expect(getProviderCliRuntimeSpec('grok').knownCommandCandidates).toEqual([
      { kind: 'homeBinDir', relativeDir: '.grok/bin' },
      { kind: 'homePath', relativePath: '.grok/bin/grok.exe' },
      { kind: 'homeBinDir', relativeDir: '.local/bin' },
      { kind: 'absolutePath', path: '/opt/homebrew/bin/grok' },
      { kind: 'absolutePath', path: '/usr/local/bin/grok' },
    ]);
  });

  it('keeps Grok on the official vendor-install contract without an agent binary fallback', () => {
    expect(getProviderCliRuntimeSpec('grok')).toMatchObject({
      title: 'Grok Build CLI',
      binaryName: 'grok',
      sourcePreferenceDefault: 'system-first',
      managedInstall: null,
      manualInstallKind: 'vendor_recipe',
      acceptsJavaScriptFileOverride: false,
      installGuideUrl: 'https://x.ai/cli',
    });
    expect(getProviderCliRuntimeSpec('grok').alternativeBinaryNames).toBeUndefined();
    expect(JSON.stringify(getProviderCliRuntimeSpec('grok').manualInstallRecipes)).toContain('x.ai/cli/install.sh');
    expect(JSON.stringify(getProviderCliRuntimeSpec('grok').manualInstallRecipes)).toContain('x.ai/cli/install.ps1');
  });

  it('declares Cursor as a system-first CLI with identity-checked fallback candidates', () => {
    expect(getProviderCliRuntimeSpec(cursorAgentId)).toMatchObject({
      id: 'cursor',
      title: 'Cursor Agent CLI',
      binaryName: 'cursor-agent',
      sourcePreferenceDefault: 'system-first',
      managedInstall: null,
      manualInstallKind: 'vendor_recipe',
      acceptsJavaScriptFileOverride: false,
      installGuideUrl: 'https://cursor.com/docs/cli/installation',
      docsUrl: 'https://cursor.com/docs/cli',
      alternativeBinaryIdentityProbe: {
        args: ['about', '--format', 'json'],
        timeoutMs: 2000,
        stdoutJsonStringField: 'cliVersion',
      },
      knownCommandCandidates: [
        { kind: 'homeBinDir', relativeDir: '.local/bin' },
        { kind: 'homeVersionedDir', relativeDir: '.local/share/cursor-agent/versions' },
        { kind: 'homePath', relativePath: 'AppData/Local/Programs/cursor-agent/cursor-agent.exe' },
      ],
      alternativeBinaryNames: ['agent'],
    });
  });

  it('filters Cursor fallback binary aliases when the fallback env var is disabled', () => {
    expect(getProviderCliBinaryNames(cursorAgentId, {
      HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED: '0',
    })).toEqual(['cursor-agent']);
    expect(getProviderCliBinaryNames(cursorAgentId, {
      HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED: '1',
    })).toEqual(['cursor-agent', 'agent']);
  });

  it('does not keep a system npm install recipe for OpenCode', () => {
    expect(getProviderCliRuntimeSpec('opencode')).toMatchObject({
      managedInstall: {
        kind: 'managed_package',
        packageName: 'opencode-ai',
        binaryName: 'opencode',
        packageBinarySetup: { kind: 'opencode_platform_binary' },
      },
      manualInstallKind: 'command',
      manualInstallRecipes: null,
    });
  });

  it('does not keep legacy manual install recipes for managed-install providers', () => {
    expect(getProviderCliRuntimeSpec('codex').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('gemini').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('auggie').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('kilo').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('opencode').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('pi').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('copilot').manualInstallRecipes).toBeNull();
    expect(getProviderCliRuntimeSpec('qwen').manualInstallRecipes).toBeNull();
  });

  it('covers every built-in provider', () => {
    expect(Object.keys(PROVIDER_CLI_RUNTIME_SPECS).sort()).toEqual([...AGENT_IDS].sort());
  });
});
