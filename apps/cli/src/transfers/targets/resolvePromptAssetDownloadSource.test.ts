import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPromptAssetAdapterRegistry } from '@/promptAssets/createPromptAssetAdapterRegistry';

describe('resolvePromptAssetDownloadSource', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('packages a bundle prompt asset into a transferable temp file', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-home-'));
    const happierHomeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-happier-home-'));
    tempDirs.push(homeDir, happierHomeDir);

    mkdirSync(join(homeDir, '.agents', 'skills', 'reviewer'), { recursive: true });
    writeFileSync(join(homeDir, '.agents', 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');
    writeFileSync(join(homeDir, '.agents', 'skills', 'reviewer', 'notes.txt'), 'Remember this\n', 'utf8');

    const { resolvePromptAssetDownloadSource } = await import('./resolvePromptAssetDownloadSource');
    const registry = createPromptAssetAdapterRegistry({
      homedir: () => homeDir,
      happierHomeDir: () => happierHomeDir,
    });

    const result = await resolvePromptAssetDownloadSource({
      adapterRegistry: registry,
      request: {
        assetTypeId: 'agents.skill',
        scope: 'user',
        externalRef: { skillName: 'reviewer' },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`expected success: ${result.error}`);
    }

    expect(result.source.deleteFileOnClose).toBe(true);
    expect(result.source.name).toBe('reviewer.prompt-asset.json');

    const payloadText = await import('node:fs/promises').then(({ readFile }) => readFile(result.source.filePath, 'utf8'));
    const parsedPayload = JSON.parse(payloadText);
    expect(parsedPayload).toMatchObject({
      assetTypeId: 'agents.skill',
      scope: 'user',
      libraryKind: 'bundle',
      title: 'reviewer',
      bundleSchemaId: 'skills.skill_md_v1',
    });
    expect(parsedPayload.bundleBody.entries.map((entry: { path: string }) => entry.path)).toEqual(['SKILL.md', 'notes.txt']);
  });

  it('packages a doc prompt asset into a transferable temp file', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-home-'));
    tempDirs.push(workspace, homeDir);

    mkdirSync(join(workspace, '.claude', 'commands', 'review'), { recursive: true });
    writeFileSync(join(workspace, '.claude', 'commands', 'review', 'code.md'), '# Review code\n', 'utf8');

    const { resolvePromptAssetDownloadSource } = await import('./resolvePromptAssetDownloadSource');
    const registry = createPromptAssetAdapterRegistry({
      homedir: () => homeDir,
    });

    const result = await resolvePromptAssetDownloadSource({
      adapterRegistry: registry,
      request: {
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: { relativePath: 'review/code.md' },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`expected success: ${result.error}`);
    }

    expect(result.source.name).toBe('review-code.prompt-asset.json');

    const payloadText = await import('node:fs/promises').then(({ readFile }) => readFile(result.source.filePath, 'utf8'));
    const parsedPayload = JSON.parse(payloadText);
    expect(parsedPayload).toMatchObject({
      assetTypeId: 'claude.command',
      scope: 'project',
      libraryKind: 'doc',
      title: 'review/code',
      markdown: '# Review code\n',
    });
  });

  it('returns the adapter read error when the prompt asset is not found', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-home-'));
    const happierHomeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-happier-home-'));
    tempDirs.push(homeDir, happierHomeDir);

    const { resolvePromptAssetDownloadSource } = await import('./resolvePromptAssetDownloadSource');
    const registry = createPromptAssetAdapterRegistry({
      homedir: () => homeDir,
      happierHomeDir: () => happierHomeDir,
    });

    const result = await resolvePromptAssetDownloadSource({
      adapterRegistry: registry,
      request: {
        assetTypeId: 'agents.skill',
        scope: 'user',
        externalRef: { skillName: 'missing' },
      },
    });

    expect(result).toEqual({
      success: false,
      error: 'skill not found',
    });
  });

  it('returns the adapter validation error when a project-scoped prompt asset directory is relative', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-home-'));
    tempDirs.push(homeDir);

    const { resolvePromptAssetDownloadSource } = await import('./resolvePromptAssetDownloadSource');
    const registry = createPromptAssetAdapterRegistry({
      homedir: () => homeDir,
    });

    const result = await resolvePromptAssetDownloadSource({
      adapterRegistry: registry,
      request: {
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: 'relative-workspace',
        externalRef: { relativePath: 'review/code.md' },
      },
    });

    expect(result).toEqual({
      success: false,
      error: 'directory must be an absolute path for project-scoped prompt assets',
    });
  });

  it('returns symlink access denial errors from the adapter read path', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-home-'));
    const outsideFile = join(workspace, 'outside.md');
    tempDirs.push(workspace, homeDir);

    mkdirSync(join(workspace, '.claude', 'commands', 'review'), { recursive: true });
    writeFileSync(outsideFile, '# Outside\n', 'utf8');
    (await import('node:fs')).symlinkSync(outsideFile, join(workspace, '.claude', 'commands', 'review', 'code.md'));

    const { resolvePromptAssetDownloadSource } = await import('./resolvePromptAssetDownloadSource');
    const registry = createPromptAssetAdapterRegistry({
      homedir: () => homeDir,
    });

    const result = await resolvePromptAssetDownloadSource({
      adapterRegistry: registry,
      request: {
        assetTypeId: 'claude.command',
        scope: 'project',
        directory: workspace,
        externalRef: { relativePath: 'review/code.md' },
      },
    });

    expect(result).toEqual({
      success: false,
      error: 'prompt asset path resolves through a symlink',
    });
  });

  it('fails closed when the prompt asset transfer payload exceeds the prompt transfer size limit', async () => {
    const previous = process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES;
    process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES = '32';
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    try {
      const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-home-'));
      const happierHomeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-happier-home-'));
      tempDirs.push(homeDir, happierHomeDir);

      mkdirSync(join(homeDir, '.agents', 'skills', 'reviewer'), { recursive: true });
      writeFileSync(join(homeDir, '.agents', 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');

      const { resolvePromptAssetDownloadSource } = await import('./resolvePromptAssetDownloadSource');
      const registry = createPromptAssetAdapterRegistry({
        homedir: () => homeDir,
        happierHomeDir: () => happierHomeDir,
      });

      const result = await resolvePromptAssetDownloadSource({
        adapterRegistry: registry,
        request: {
          assetTypeId: 'agents.skill',
          scope: 'user',
          externalRef: { skillName: 'reviewer' },
        },
      });

      expect(result).toEqual({
        success: false,
        error: 'Prompt transfer payload exceeds size limit',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES;
      } else {
        process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES = previous;
      }
      const { reloadConfiguration: reloadAfter } = await import('@/configuration');
      reloadAfter();
    }
  });
});
