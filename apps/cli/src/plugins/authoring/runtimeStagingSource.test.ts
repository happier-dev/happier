import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { evaluatePluginAuthorRuntimeStagingSource } from './runtimeStagingSource';

const ANTIGRAVITY_PLUGIN_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/plugins/antigravity',
);

async function createSessionRunnerFixture(input: Readonly<{
  pluginId: string;
  localAgentId?: string;
}>): Promise<Readonly<{
  rootPath: string;
  entryPath: string;
  dispose(): Promise<void>;
}>> {
  const rootPath = await mkdtemp(join(tmpdir(), 'happier-runtime-staging-authority-'));
  const sourceRoot = join(rootPath, 'src');
  await mkdir(sourceRoot, { recursive: true });
  const localAgentId = input.localAgentId ?? 'claude';
  const entryPath = join(sourceRoot, 'index.ts');
  await writeFile(entryPath, [
    "import { createClaudeAgentRuntime } from './runner';",
    'export const manifest = {',
    '  schemaVersion: 2,',
    `  id: ${JSON.stringify(input.pluginId)},`,
    "  version: '1.0.0',",
    "  displayName: 'Runtime staging fixture',",
    "  engines: { happier: '^0.2.0' },",
    '  runtime: { apiVersion: 1 },',
    "  entrypoints: { daemon: './dist/index.js' },",
    '  contributes: { agents: [{',
    `    id: ${JSON.stringify(localAgentId)},`,
    "    title: 'Fixture Agent',",
    "    runtime: { kind: 'custom' },",
    "    primary: 'sessions',",
    '    capabilities: { sessions: {',
    "      open: ['create', 'resume', 'fork'],",
    "      delivery: ['newTurn'],",
    '      cancel: true,',
    '    } },',
    '  }] },',
    '};',
    'export function activate(api: any) {',
    `  api.agents.register(${JSON.stringify(localAgentId)}, createClaudeAgentRuntime, {`,
    '    sessionRunnerFactory: {',
    "      module: './runner',",
    "      export: 'createClaudeAgentRuntime',",
    '      runtimeApiVersion: 1,',
    '    },',
    '  });',
    '}',
    '',
  ].join('\n'), 'utf8');
  await writeFile(join(sourceRoot, 'runner.ts'), [
    'export function createClaudeAgentRuntime() {',
    '  return { sessions: { open() { throw new Error("unused"); } } };',
    '}',
    '',
  ].join('\n'), 'utf8');
  return Object.freeze({
    rootPath,
    entryPath,
    dispose: async () => await rm(rootPath, { recursive: true, force: true }),
  });
}

describe('plugin author runtime staging authority', () => {
  it('stages Antigravity with the exact External Sessions companion exported by its runner leaf', async () => {
    const staged = await evaluatePluginAuthorRuntimeStagingSource({
      locator: join(ANTIGRAVITY_PLUGIN_ROOT, 'src', 'index.ts'),
      rootPath: ANTIGRAVITY_PLUGIN_ROOT,
      immutableGenerationId: 'bundled-antigravity-companion-positive',
      authority: {
        kind: 'bundled_first_party',
        pluginId: 'happier.agent.antigravity',
        packageRootPath: ANTIGRAVITY_PLUGIN_ROOT,
      },
    });

    expect(staged.sessionRunnerFactories).toEqual([expect.objectContaining({
      localAgentId: 'antigravity',
      normalizedModulePath: 'src/agent/runtime/factory.ts',
      loadMode: 'source-ts',
      locator: {
        module: './agent/runtime/factory',
        export: 'createAntigravityAgentRuntime',
        runtimeApiVersion: 1,
        externalSessionsExport: 'antigravityExternalSessionsContribution',
      },
    })]);
  });

  it('admits the exact bundled Claude source root through normal activation validation', async () => {
    const fixture = await createSessionRunnerFixture({
      pluginId: 'happier.agent.claude',
    });
    try {
      const staged = await evaluatePluginAuthorRuntimeStagingSource({
        locator: fixture.entryPath,
        rootPath: fixture.rootPath,
        immutableGenerationId: 'bundled-claude-staging-positive',
        authority: {
          kind: 'bundled_first_party',
          pluginId: 'happier.agent.claude',
          packageRootPath: fixture.rootPath,
        },
      });

      expect(staged.sessionRunnerFactories).toEqual([expect.objectContaining({
        localAgentId: 'claude',
        normalizedModulePath: 'src/runner.ts',
        loadMode: 'source-ts',
        locator: expect.objectContaining({
          module: './runner',
          export: 'createClaudeAgentRuntime',
        }),
      })]);
      expect(staged.sessionRunnerFactories[0]).not.toHaveProperty(
        'workflowRunRecordSessionOpen',
      );
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects bundled authority whose plugin identity or source root is not exact', async () => {
    const fixture = await createSessionRunnerFixture({
      pluginId: 'happier.agent.claude',
    });
    try {
      await expect(evaluatePluginAuthorRuntimeStagingSource({
        locator: fixture.entryPath,
        rootPath: fixture.rootPath,
        immutableGenerationId: 'bundled-claude-staging-wrong-id',
        authority: {
          kind: 'bundled_first_party',
          pluginId: 'happier.agent.codex',
          packageRootPath: fixture.rootPath,
        },
      })).rejects.toThrow(/bundled.*identity/iu);

      await expect(evaluatePluginAuthorRuntimeStagingSource({
        locator: fixture.entryPath,
        rootPath: fixture.rootPath,
        immutableGenerationId: 'bundled-claude-staging-wrong-root',
        authority: {
          kind: 'bundled_first_party',
          pluginId: 'happier.agent.claude',
          packageRootPath: tmpdir(),
        },
      })).rejects.toThrow(/bundled.*source root/iu);
    } finally {
      await fixture.dispose();
    }
  });

  it('ignores the Claude-named companion for an ordinary external plugin', async () => {
    const fixture = await createSessionRunnerFixture({
      pluginId: 'example.external-agent',
    });
    try {
      const staged = await evaluatePluginAuthorRuntimeStagingSource({
        locator: fixture.entryPath,
        rootPath: fixture.rootPath,
        immutableGenerationId: 'external-companion-ignored',
      });

      expect(staged.sessionRunnerFactories).toHaveLength(1);
      expect(staged.sessionRunnerFactories[0]).not.toHaveProperty(
        'workflowRunRecordSessionOpen',
      );
    } finally {
      await fixture.dispose();
    }
  });
});
