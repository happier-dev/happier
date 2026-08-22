import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
      expect(skill).toContain('do not run `happier plugins author install .` first');
      expect(skill).toContain('running Happier CLI');
      expect(skill).toContain('prepublication SDK version resolves automatically');
      expect(skill).toContain('managed author commands');
      expect(skill).toContain('author-owned `pnpm-workspace.yaml`');
      expect(skill).not.toContain('release-authorized `--sdk-registry` origin');
      expect(skill).toContain('examples/advanced-package-root');
      expect(skill).toContain('happier plugins author typecheck .');
      expect(skill).toContain('happier plugins author build .');
      expect(skill).toContain('happier plugins test . --packed');
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

      expect(skill).toContain('[cross-plugin contribution guide](/plugins/guides/cross-plugin-contributions)');
      expect(skill).toContain('This beginner scaffold does not declare a feature integration.');
      expect(skill).not.toContain('@happier-dev/channels-protocol');
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
