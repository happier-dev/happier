import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scaffoldLocalPlugin } from './scaffold';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('scaffoldLocalPlugin authoring guidance', () => {
  it('keeps the repository authoring skill byte-identical to the scaffolded source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-repository-authoring-skill-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.repository-authoring-skill',
        displayName: 'Repository authoring skill',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const [scaffoldedSkill, repositorySkill] = await Promise.all([
        readFile(join(
          root,
          'plugin',
          '.agents',
          'skills',
          'happier-plugin-authoring',
          'SKILL.md',
        ), 'utf8'),
        readFile(join(
          repositoryRoot,
          'skills',
          'happier-plugin-authoring',
          'SKILL.md',
        ), 'utf8'),
      ]);

      expect(repositorySkill).toBe(scaffoldedSkill);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('teaches the normal create-to-dev loop, diagnostics, examples, and the supported registry option', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-guidance-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.authoring-guidance',
        displayName: 'Authoring guidance',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const skill = await readFile(join(
        root,
        'plugin',
        '.agents',
        'skills',
        'happier-plugin-authoring',
        'SKILL.md',
      ), 'utf8');
      expect(skill).toContain('happier plugins dev');
      expect(skill).toContain('happier plugins doctor .');
      expect(skill).toContain('node_modules/@happier-dev/plugin-sdk/examples');
      expect(skill).toContain('--sdk-registry <origin>');
      expect(skill).toContain('prepares declared dependencies automatically');
      expect(skill).toContain('do not run `happier plugins dev install .` first');
      expect(skill).toContain('running Happier CLI');
      expect(skill).toContain('prepublication SDK version resolves automatically');
      expect(skill).toContain('managed author commands');
      expect(skill).toContain('author-owned `pnpm-workspace.yaml`');
      expect(skill).not.toContain('release-authorized `--sdk-registry` origin');
      expect(skill).toContain('examples/advanced-package-root');
      expect(skill).toContain('happier plugins dev typecheck .');
      expect(skill).toContain('happier plugins dev build .');
      expect(skill).toContain('happier plugins pack .');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('only points the author at SDK paths that exist in the package they install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-references-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.authoring-references',
        displayName: 'Authoring references',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const skill = await readFile(join(
        root,
        'plugin',
        '.agents',
        'skills',
        'happier-plugin-authoring',
        'SKILL.md',
      ), 'utf8');

      // A root-relative Markdown target resolves against a documentation site,
      // not against the author project this file is written into.
      expect(skill).not.toMatch(/\]\(\/[^)]*\)/u);

      const sdkRoot = join(repositoryRoot, 'packages', 'plugin-sdk');
      const published: readonly string[] = JSON.parse(
        await readFile(join(sdkRoot, 'package.json'), 'utf8'),
      ).files;
      const references = [...new Set(
        [...skill.matchAll(/node_modules\/@happier-dev\/plugin-sdk\/([^\s`'")]+)/gu)]
          .map((match) => match[1]!.replace(/\/+$/u, '')),
      )];
      expect(references.length).toBeGreaterThan(0);

      for (const reference of references) {
        await expect(
          stat(join(sdkRoot, reference)).then(() => reference),
          `${reference} is missing from packages/plugin-sdk`,
        ).resolves.toBe(reference);
        const inPackedInventory = published.some((entry) => {
          const normalized = entry.replace(/\/+$/u, '');
          return normalized === reference
            || normalized.startsWith(`${reference}/`)
            || reference.startsWith(`${normalized}/`);
        });
        expect(inPackedInventory, `${reference} is not in the plugin-sdk files inventory`).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('directs React Native authors to the shipped Plugin UI API inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-plugin-ui-inventory-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.plugin-ui-inventory',
        displayName: 'Plugin UI inventory',
        ui: 'reactNative',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const skill = await readFile(join(
        root,
        'plugin',
        '.agents',
        'skills',
        'happier-plugin-authoring',
        'SKILL.md',
      ), 'utf8');
      expect(skill).toContain('node_modules/@happier-dev/plugin-ui/API.md');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('links cross-plugin contributors to the generic guide without teaching feature-specific ceremony', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-contributions-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.authoring-contributions',
        displayName: 'Authoring contributions',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok) return;

      const skill = await readFile(join(
        root,
        'plugin',
        '.agents',
        'skills',
        'happier-plugin-authoring',
        'SKILL.md',
      ), 'utf8');

      expect(skill).toContain('node_modules/@happier-dev/plugin-sdk/examples/operation-only-channel-provider/');
      expect(skill).toContain('@happier-dev/channels-protocol/v1');
      expect(skill).toContain('does not declare a target, descriptor, or surface');
      expect(skill).toContain('the same public contracts serve external and bundled plugins');
      expect(skill).not.toContain('first-party Preview product');
      expect(skill).toContain('This beginner scaffold does not declare a feature integration.');
      expect(skill).not.toContain('defineTargetedContributionProtocol');
      expect(skill).not.toContain('defineTargetedContributionPoint');
      expect(skill).not.toContain('defineContributionProtocol');
      expect(skill).not.toContain('defineContributionPoint');
      expect(skill).not.toContain('`.point()`');
      expect(skill).not.toContain('`.contribute()`');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
