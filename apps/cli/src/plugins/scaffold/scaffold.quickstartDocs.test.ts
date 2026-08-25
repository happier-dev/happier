import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
const reactNativeGuidePath = join(
  repositoryRoot,
  'apps',
  'docs',
  'content',
  'docs',
  'plugins',
  'ui',
  'react-native.mdx',
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
  it('prints the tree and entry module the scaffold actually generates', async () => {
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('links React Native authors to the shipped Plugin UI API inventory', async () => {
    const guide = await readFile(reactNativeGuidePath, 'utf8');
    expect(guide).toContain('node_modules/@happier-dev/plugin-ui/API.md');
    expect(guide).toContain('Plugin UI API inventory');
  });
});
