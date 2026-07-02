import { describe, expect, it } from 'vitest';

import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './bundledAgentDefinitions.js';

describe('bundledAgentDefinitions', () => {
  it('keeps Claude generated runtime facts under the agentCliRuntime vocabulary', () => {
    const claudeDefinition = BUNDLED_AGENT_DEFINITIONS_BY_ID.claude as Readonly<Record<string, unknown>>;

    expect(claudeDefinition.agentCliRuntime).toEqual(expect.objectContaining({
      id: 'claude',
      title: 'Claude Code CLI',
      binaryName: 'claude',
      managedInstall: null,
      manualInstallKind: 'vendor_recipe',
    }));
    expect(claudeDefinition).not.toHaveProperty('providerCliRuntime');
  });

  it('keeps Codex generated runtime facts under the agentCliRuntime vocabulary', () => {
    const codexDefinition = BUNDLED_AGENT_DEFINITIONS_BY_ID.codex as Readonly<Record<string, unknown>>;

    expect(codexDefinition.agentCliRuntime).toEqual(expect.objectContaining({
      id: 'codex',
      title: 'codex CLI',
      binaryName: 'codex',
      managedInstall: null,
      manualInstallKind: 'none',
    }));
    expect(codexDefinition).not.toHaveProperty('providerCliRuntime');
  });

  it('keeps OpenCode generated runtime facts under the agentCliRuntime vocabulary', () => {
    const opencodeDefinition = BUNDLED_AGENT_DEFINITIONS_BY_ID.opencode as Readonly<Record<string, unknown>>;

    expect(opencodeDefinition.agentCliRuntime).toEqual(expect.objectContaining({
      id: 'opencode',
      title: 'OpenCode CLI',
      binaryName: 'opencode',
      managedInstall: null,
      manualInstallKind: 'vendor_recipe',
    }));
    expect(opencodeDefinition).not.toHaveProperty('providerCliRuntime');
  });

  it('keeps Cursor and Qwen generated runtime facts under the agentCliRuntime vocabulary', () => {
    const cursorDefinition = BUNDLED_AGENT_DEFINITIONS_BY_ID.cursor as Readonly<Record<string, unknown>>;
    const qwenDefinition = BUNDLED_AGENT_DEFINITIONS_BY_ID.qwen as Readonly<Record<string, unknown>>;

    expect(cursorDefinition.agentCliRuntime).toEqual(expect.objectContaining({
      id: 'cursor',
      title: 'Cursor Agent CLI',
      binaryName: 'cursor-agent',
      managedInstall: null,
      manualInstallKind: 'vendor_recipe',
    }));
    expect(cursorDefinition).not.toHaveProperty('providerCliRuntime');

    expect(qwenDefinition.agentCliRuntime).toEqual(expect.objectContaining({
      id: 'qwen',
      title: 'Qwen CLI',
      binaryName: 'qwen',
      managedInstall: expect.objectContaining({
        kind: 'managed_package',
        packageName: '@qwen-code/qwen-code',
      }),
      manualInstallKind: 'command',
    }));
    expect(qwenDefinition).not.toHaveProperty('providerCliRuntime');
  });

  it('keeps OhMyPi generated prep runtime facts under the agentCliRuntime vocabulary', () => {
    const ohMyPiDefinition = BUNDLED_AGENT_DEFINITIONS_BY_ID.ohMyPi as Readonly<Record<string, unknown>>;

    expect(ohMyPiDefinition.agentCliRuntime).toEqual(expect.objectContaining({
      id: 'ohMyPi',
      title: 'oh-my-pi CLI',
      binaryName: 'omp',
      managedInstall: expect.objectContaining({
        kind: 'github_release_binary',
        githubRepo: 'can1357/oh-my-pi',
      }),
      manualInstallKind: 'vendor_recipe',
    }));
    expect(ohMyPiDefinition).not.toHaveProperty('providerCliRuntime');
  });
});
