import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAgentsSkillPromptAssetAdapter } from './createAgentsSkillPromptAssetAdapter';

describe('createAgentsSkillPromptAssetAdapter', () => {
  it('returns a committed digest that can be used to delete the just-written skill', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-agents-skill-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-agents-skill-home-'));
    try {
      const adapter = createAgentsSkillPromptAssetAdapter({
        homedir: () => homeDir,
      });
      const bundleBody = {
        v: 1 as const,
        entries: [
          {
            path: 'SKILL.md',
            contentBase64: Buffer.from('# Writer skill\n', 'utf8').toString('base64'),
            contentKind: 'utf8' as const,
          },
          {
            path: 'notes.txt',
            contentBase64: Buffer.from('remember me\n', 'utf8').toString('base64'),
            contentKind: 'utf8' as const,
          },
        ],
        createdAtMs: 1,
        updatedAtMs: 2,
      };

      const committed = await adapter.writeBundle({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        targetName: 'writer',
        title: 'Writer',
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody,
        previewOnly: false,
        expectedDigest: null,
      });

      expect(committed.ok).toBe(true);
      if (!committed.ok) {
        throw new Error(`expected commit to succeed: ${committed.error}`);
      }

      const skillDir = join(homeDir, '.agents', 'skills', 'writer');
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toBe('# Writer skill\n');

      const deleted = await adapter.delete({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        externalRef: { skillName: 'writer' },
        previewOnly: false,
        expectedDigest: committed.digest,
      });

      expect(deleted).toMatchObject({ ok: true });
      expect(() => readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('supports symlink installs through a managed materialization directory', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-agents-skill-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-agents-skill-home-'));
    const happierHomeDir = mkdtempSync(join(tmpdir(), 'happier-home-'));
    try {
      const adapter = createAgentsSkillPromptAssetAdapter({
        homedir: () => homeDir,
        happierHomeDir: () => happierHomeDir,
      });
      const bundleBody = {
        v: 1 as const,
        entries: [
          {
            path: 'SKILL.md',
            contentBase64: Buffer.from('# Writer skill\n', 'utf8').toString('base64'),
            contentKind: 'utf8' as const,
          },
          {
            path: 'notes.txt',
            contentBase64: Buffer.from('remember me\n', 'utf8').toString('base64'),
            contentKind: 'utf8' as const,
          },
        ],
        createdAtMs: 1,
        updatedAtMs: 2,
      };

      const committed = await adapter.writeBundle({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        targetName: 'writer',
        title: 'Writer',
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody,
        installMode: 'symlink',
        previewOnly: false,
        expectedDigest: null,
      });

      expect(committed.ok).toBe(true);
      if (!committed.ok) {
        throw new Error(`expected commit to succeed: ${committed.error}`);
      }

      const skillDir = join(homeDir, '.agents', 'skills', 'writer');
      expect(lstatSync(skillDir).isSymbolicLink()).toBe(true);
      expect(realpathSync(skillDir).startsWith(realpathSync(happierHomeDir))).toBe(true);
      expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toBe('# Writer skill\n');

      const discovered = await adapter.discover({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
      });
      expect(discovered).toEqual([
        expect.objectContaining({
          title: 'writer',
          externalRef: { skillName: 'writer' },
        }),
      ]);

      const read = await adapter.read({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        externalRef: { skillName: 'writer' },
      });
      expect(read.ok).toBe(true);
      if (read.ok && read.item.libraryKind === 'bundle') {
        expect(read.item.bundleBody.entries.map((entry: { path: string }) => entry.path)).toEqual(['SKILL.md', 'notes.txt']);
      } else {
        throw new Error('expected bundle read result');
      }

      const deleted = await adapter.delete({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        externalRef: { skillName: 'writer' },
        previewOnly: false,
        expectedDigest: committed.digest,
      });
      expect(deleted).toMatchObject({ ok: true });
      expect(() => lstatSync(skillDir)).toThrow();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(happierHomeDir, { recursive: true, force: true });
    }
  });

  it('reapplies stored unix modes when writing supporting files', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-agents-skill-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-agents-skill-home-'));
    try {
      const adapter = createAgentsSkillPromptAssetAdapter({
        homedir: () => homeDir,
      });
      const bundleBody = {
        v: 1 as const,
        entries: [
          {
            path: 'SKILL.md',
            contentBase64: Buffer.from('# Writer skill\n', 'utf8').toString('base64'),
            contentKind: 'utf8' as const,
            unixMode: 0o644,
          },
          {
            path: 'bin/run.sh',
            contentBase64: Buffer.from('#!/bin/sh\necho ok\n', 'utf8').toString('base64'),
            contentKind: 'utf8' as const,
            unixMode: 0o755,
          },
        ],
        createdAtMs: 1,
        updatedAtMs: 2,
      };

      const committed = await adapter.writeBundle({
        assetTypeId: 'agents.skill',
        scope: 'user',
        directory: workspace,
        targetName: 'writer',
        title: 'Writer',
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody,
        previewOnly: false,
        expectedDigest: null,
      });

      expect(committed.ok).toBe(true);
      if (!committed.ok) {
        throw new Error(`expected commit to succeed: ${committed.error}`);
      }

      const scriptPath = join(homeDir, '.agents', 'skills', 'writer', 'bin', 'run.sh');
      expect(statSync(scriptPath).mode & 0o7777).toBe(0o755);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
