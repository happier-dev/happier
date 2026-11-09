import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { evaluatePluginAuthorSource } from '../authoring/sourceModule';
import { scaffoldLocalPlugin } from './scaffold';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const quickstartPath = join(
  repositoryRoot,
  'apps',
  'docs',
  'content',
  'docs',
  'plugins',
  'quickstart.mdx',
);
/** Directories before files, each group sorted — the shape the page prints. */
async function renderTree(dir: string, indent: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((entry) => !entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const directory of directories) {
    lines.push(`${indent}${directory.name}/`);
    lines.push(...await renderTree(join(dir, directory.name), `${indent}  `));
  }
  for (const file of files) lines.push(`${indent}${file.name}`);
  return lines;
}

/** The single fenced block of `language` on the page, without its fences. */
function readFencedBlock(markdown: string, language: string): string {
  const blocks = [...markdown.matchAll(new RegExp(`^\`\`\`${language}\\n([\\s\\S]*?)^\`\`\`$`, 'gmu'))]
    .map((match) => match[1] ?? '');
  expect(blocks, `expected exactly one \`\`\`${language} block in quickstart.mdx`).toHaveLength(1);
  return blocks[0]!;
}

/**
 * The quickstart is the page an author reads before they have a workspace, so
 * a tree that omits a generated file or a snippet that trims declared fields
 * is not a cosmetic drift: it is the first thing they compare their own output
 * against. Both are generated here rather than transcribed.
 */
describe('plugin quickstart documentation', () => {
  it('documents the generated scaffold and runs its untouched Action contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-quickstart-docs-'));
    try {
      const targetDir = join(root, 'my-plugin');
      const scaffold = await scaffoldLocalPlugin({
        targetDir,
        pluginId: 'com.example.my-plugin',
        displayName: 'My plugin',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const quickstart = await readFile(quickstartPath, 'utf8');
      const generatedTree = ['my-plugin/', ...await renderTree(targetDir, '  ')].join('\n');
      expect(readFencedBlock(quickstart, 'text').trimEnd()).toBe(generatedTree);

      const generatedEntry = await readFile(join(targetDir, 'src', 'index.ts'), 'utf8');
      expect(readFencedBlock(quickstart, 'ts')).toBe(generatedEntry);

      // The documented untouched scaffold has a passing first contract. Exercise
      // its real source loader and public testkit rather than policing prose.
      const evaluated = await evaluatePluginAuthorSource({ locator: scaffold.sourceEntryPath });
      const parsed = parsePluginManifest(evaluated.manifest);
      if (!parsed.ok) throw new Error('Generated scaffold must satisfy the public SDK manifest policy');
      const plugin = await createPluginTestkit({ manifest: parsed.manifest, module: evaluated.module });
      try {
        await expect(plugin.invokeAction('save-note', { note: 'hello' })).resolves.toEqual({ note: 'hello' });
      } finally {
        await plugin.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  // Match sourceModule's real workspace-evaluation test budget now that this
  // case also cold-loads the SDK; this is not an activation deadline.
  }, 120_000);
});
