import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';
import { collectBundledPrepublicationAuthorPackageNames } from '@happier-dev/cli-common/workspaceRuntimeDependencies';
import { describe, expect, it } from 'vitest';
import { scaffoldLocalPlugin } from './scaffold';

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path,
  'utf8')) as T;
}

describe('scaffoldLocalPlugin',
  () => {
  it('packages locale JSON Resources for generated UI translations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-i18n-'));
    try {
      const targetDir = join(root, 'plugin');
      const result = await scaffoldLocalPlugin({ targetDir, pluginId: 'acme.copy', displayName: 'Copy', ui: 'declarative' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const source = await readFile(result.sourceEntryPath, 'utf8');
      expect(source).toContain("resourceId: 'i18n-en'");
      expect(source).not.toContain('messages:');
      const pkg = await readJsonFile<{ files: string[] }>(result.packageJsonPath);
      expect(pkg.files).toContain('assets');
      expect(await readJsonFile(join(targetDir, 'assets/i18n/fr.json'))).toMatchObject({
        'scaffold.main.greeting': 'Bonjour de Copy',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('scaffolds a working tree under any syntactically valid id, including the reserved namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-reserved-'));
    try {
      const reserved = await scaffoldLocalPlugin({
        targetDir: join(root, 'reserved-plugin'),
        pluginId: 'happier.agent.codex',
        displayName: 'Codex',
      });
      expect(reserved).toEqual(expect.objectContaining({ ok: true }));

      const malformed = await scaffoldLocalPlugin({
        targetDir: join(root, 'malformed-plugin'),
        pluginId: 'Not A Plugin Id',
        displayName: 'Malformed',
      });
      expect(malformed).toEqual(expect.objectContaining({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'plugin_scaffold_invalid_input' })],
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('derives every generated dependency and compatibility fact from the public toolchain packet',
  async () => {
    const root = await mkdtemp(join(tmpdir(),
  'happier-plugin-scaffold-packed-author-'));
    const targetDir = join(root,
  'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
  pluginId: 'acme.packed-author',
  displayName: 'Acme Packed Author',
  });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const packageJson = await readJsonFile<{
      scripts?: Record<string,
  string>;
      dependencies?: Record<string,
  string>;
      devDependencies?: Record<string,
  string>;
    }>(result.packageJsonPath);
    expect(packageJson.dependencies).toMatchObject({
      '@happier-dev/plugin-sdk': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-sdk'],
    });
    expect(packageJson.dependencies?.['@happier-dev/plugin-sdk']).not.toMatch(/^(?:file:|workspace:|link:|portal:)/u);
    expect(collectBundledPrepublicationAuthorPackageNames(packageJson)).toEqual(['@happier-dev/plugin-sdk']);
    expect(packageJson.devDependencies).toMatchObject({
      '@types/node': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@types/node'],
      '@typescript/native': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.devDependencies['@typescript/native'],
    });
    expect(packageJson.devDependencies).not.toHaveProperty('typescript');
    expect(packageJson.scripts).toMatchObject({
      build: 'happier plugins dev build .',
  typecheck: 'happier plugins dev typecheck .',
  test: 'happier plugins test .',
  'pack:plugin': 'happier plugins pack .',
  });
    expect(Object.values(packageJson.scripts ?? {})).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/(^|\s)(?:tsc|npx|npm|pnpm|yarn|bunx)(?:\s|$)/u)]),
  );
  });

  it('generates an external authoring skill from the public SDK packet instead of copied host contracts',
  async () => {
    const root = await mkdtemp(join(tmpdir(),
  'happier-plugin-scaffold-authoring-skill-'));
    const targetDir = join(root,
  'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
  pluginId: 'acme.authoring-skill',
  displayName: 'Acme Authoring Skill',
  });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const skill = await readFile(join(targetDir,
  '.agents',
  'skills',
  'happier-plugin-authoring',
  'SKILL.md'), 'utf8');
    const sdkVersion = PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-sdk'];
    expect(skill).toContain(`@happier-dev/plugin-sdk@${sdkVersion}`);
    expect(skill).toContain('node_modules/@happier-dev/plugin-sdk/API.md');
    expect(skill).toContain('node_modules/@happier-dev/plugin-sdk/capability-matrix.json');
    expect(skill).toContain('happier plugins dev');
    expect(skill).toContain('happier plugins change status <pendingChangeId>');
    expect(skill).toContain('same daemon lifetime');
    expect(skill).toContain('outcome_unknown');
    expect(skill).toContain('node_modules/@happier-dev/plugin-sdk/examples/public-authoring/');
    expect(skill).toContain('node_modules/@happier-dev/plugin-sdk/examples/advanced-package-root/');
    expect(skill).toContain('does not create product availability');
    expect(skill).not.toContain('operation-only-channel-provider');
    expect(skill).not.toContain('externally supported author product remains operation-only');
    expect(skill).not.toContain('first-party Preview product');
    expect(skill).not.toContain('defineContributionProtocol');
    expect(skill).not.toContain('protocol.operations');
    expect(skill).not.toMatch(/(?:^|[^A-Za-z])(?:apps|packages)\//mu);
    expect(skill).not.toContain("from '@/");
  });

  it('writes the final code-defined TypeScript dev-loop plugin template',
  async () => {
    const root = await mkdtemp(join(tmpdir(),
  'happier-plugin-scaffold-'));
    const targetDir = join(root,
  'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
  pluginId: 'acme.template',
  displayName: 'Acme Template',
  });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await expect(readFile(join(targetDir, '.happier-plugin', 'plugin.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(targetDir, '.happier-plugin', 'plugin.schema.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const source = await readFile(result.sourceEntryPath,
  'utf8');
    expect(result.sourceEntryPath).toBe(join(targetDir,
  'src',
  'index.ts'));
    expect(source).toContain("import { definePlugin } from '@happier-dev/plugin-sdk';");
    expect(source).toContain("import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';");
    expect(source).toContain('export const { manifest, activate } = definePlugin({');
    expect(source).toContain("'save-note': {");
    expect(source).toContain('inputSchema: defineProtocolObject({');
    expect(source).toContain('note: defineProtocolString()');
    expect(source).toContain('async run(input) {');
    expect(source).toContain('return { note: input.note };');
    expect(source).not.toContain('engines: { happier:');
    expect(source).not.toMatch(/@happier-dev\/plugin-sdk\/runtime|export function activate|api\.actions\.register/u);
    const testSource = await readFile(join(targetDir, 'test', 'index.test.mjs'), 'utf8');
    expect(testSource).toContain("from '@happier-dev/plugin-sdk/testing'");
    expect(testSource).not.toContain('replace this placeholder with your first plugin contract');
    expect(testSource).not.toContain('Replace this placeholder test before shipping your plugin.');
    expect(testSource).toContain("test('save-note returns the supplied note'");
    expect(testSource).toContain("invokeAction('save-note', { note: 'hello' })");
    const packageJson = await readJsonFile<Record<string, unknown>>(result.packageJsonPath);
    expect(packageJson).not.toHaveProperty('private');
    expect(packageJson).toMatchObject({
      happier: { manifest: '.happier-plugin/plugin.json' },
      keywords: ['happier-plugin'],
      files: ['.agents/skills/happier-plugin-authoring', 'dist', 'assets'],
      dependencies: {
        '@happier-dev/plugin-sdk': PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.dependencies['@happier-dev/plugin-sdk'],
      },
    });
  });

  it('keeps every shipped UI mode on the same strict daemon declaration', async () => {
    for (const ui of ['hostedWeb', 'reactNative'] as const) {
      const root = await mkdtemp(join(tmpdir(), `happier-plugin-scaffold-activate-${ui}-`));
      const targetDir = join(root, 'template-plugin');

      const result = await scaffoldLocalPlugin({
        targetDir,
        pluginId: 'acme.template',
        displayName: 'Acme Template',
        ui,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const source = await readFile(result.sourceEntryPath, 'utf8');
      expect(source).toContain("entrypoints: { daemon: './dist/index.js', development: './src/index.ts' }");
      expect(source).toContain('export const { manifest, activate } = definePlugin({');
      await expect(readFile(join(targetDir, '.happier-plugin', 'plugin.json'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('rejects scaffold targets outside the provided base directory', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-workspace-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-outside-'));
    const targetDir = join(outsideRoot, 'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
      baseDir: workspaceRoot,
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'plugin_scaffold_invalid_input',
          message: expect.stringMatching(/inside the workspace/i),
        },
      ],
    });
    await expect(readFile(join(targetDir, 'package.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
