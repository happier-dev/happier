import { describe, expect, it } from 'vitest';

import { BUNDLED_AGENT_DEFINITIONS_BY_ID } from './bundledAgentDefinitions.js';
import { readFileSync } from 'node:fs';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { getAgentCore } from '../manifest.js';

describe('bundledAgentDefinitions', () => {
  it('publishes the manifest-owned skills declaration for offline capability edits', () => {
    const manifest = PluginManifestV2Schema.parse(JSON.parse(readFileSync(new URL('../../../../apps/cli/assets/bundled-plugin-manifests/codex.json', import.meta.url), 'utf8')));
    const declaration = manifest.contributes?.agents?.find(agent => agent.id === 'codex')?.capabilities?.skills;
    expect(declaration).toBeDefined();
    expect(getAgentCore('codex')).toHaveProperty('skills', declaration);
  });
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
          assetNameByPlatform: expect.objectContaining({
            win32: {
              arm64: 'codex-package-aarch64-pc-windows-msvc.tar.gz',
              x64: 'codex-package-x86_64-pc-windows-msvc.tar.gz',
            },
          }),
          archiveEntriesByPlatform: expect.objectContaining({
            win32: expect.arrayContaining([
              { archivePath: 'bin/codex.exe', destinationPath: 'bin/codex.exe' },
              { archivePath: 'bin/codex-code-mode-host.exe', destinationPath: 'bin/codex-code-mode-host.exe' },
            ]),
          }),
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
          packageName: '@opencode/cli',
          allowBuild: true,
        }),
        manual: { kind: 'command' },
      }),
    }));
    expect(opencodeDefinition).not.toHaveProperty('agentCliRuntime');
  });
});
