import { describe, expect, it } from 'vitest';

import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './bundledAgentDefinitions.js';

describe('bundledAgentDefinitions', () => {
  it('keeps native Agent CLI metadata as the generated authority', () => {
    const claudeDefinition = BUNDLED_AGENT_DEFINITIONS_BY_ID.claude as Readonly<Record<string, unknown>>;

    expect(claudeDefinition.cli).toEqual(expect.objectContaining({
      displayName: 'Claude Code CLI',
      executable: expect.objectContaining({
        binaryName: 'claude',
        sourcePreference: 'system-first',
      }),
      install: expect.objectContaining({
        managed: null,
        manual: expect.objectContaining({ kind: 'vendor_recipe' }),
      }),
      auth: expect.objectContaining({
        support: 'login_terminal',
      }),
    }));
    expect(claudeDefinition).not.toHaveProperty('agentCliRuntime');
  });

  it('keeps managed installation facts under native CLI metadata', () => {
    const codexDefinition = BUNDLED_AGENT_DEFINITIONS_BY_ID.codex as Readonly<Record<string, unknown>>;

    expect(codexDefinition.cli).toEqual(expect.objectContaining({
      displayName: 'OpenAI Codex CLI',
      executable: expect.objectContaining({ binaryName: 'codex' }),
      install: expect.objectContaining({
        managed: expect.objectContaining({
          kind: 'github_release_binary',
          githubRepo: 'openai/codex',
          binaryName: 'codex',
        }),
        manual: { kind: 'command' },
      }),
    }));
    expect(codexDefinition).not.toHaveProperty('agentCliRuntime');
  });

  it('keeps package installation setup under native CLI metadata', () => {
    const opencodeDefinition = BUNDLED_AGENT_DEFINITIONS_BY_ID.opencode as Readonly<Record<string, unknown>>;

    expect(opencodeDefinition.cli).toEqual(expect.objectContaining({
      displayName: 'OpenCode CLI',
      executable: expect.objectContaining({ binaryName: 'opencode' }),
      install: expect.objectContaining({
        managed: expect.objectContaining({
          kind: 'managed_package',
          packageName: 'opencode-ai',
          packageBinarySetup: { kind: 'opencode_platform_binary' },
        }),
        manual: { kind: 'command' },
      }),
    }));
    expect(opencodeDefinition).not.toHaveProperty('agentCliRuntime');
  });
});
