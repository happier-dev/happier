import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPromptAssetAdapterRegistry } from '@/promptAssets/createPromptAssetAdapterRegistry';

import { resolvePromptAssetUploadTarget } from './resolvePromptAssetUploadTarget';

describe('resolvePromptAssetUploadTarget', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns invalid_request results for Windows-style absolute markdown target paths', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-home-'));
    const tempPath = join(workspace, 'prompt-asset-upload.json');
    tempDirs.push(workspace, homeDir);

    const payloadText = JSON.stringify({
      assetTypeId: 'claude.command',
      scope: 'project',
      directory: workspace,
      externalRef: null,
      targetPath: 'C:\\\\escape.md',
      title: 'Escape',
      markdown: '# Escape',
      previewOnly: false,
      expectedDigest: null,
    });
    writeFileSync(tempPath, payloadText, 'utf8');

    const result = resolvePromptAssetUploadTarget({
      adapterRegistry: createPromptAssetAdapterRegistry({
        homedir: () => homeDir,
      }),
      sizeBytes: Buffer.byteLength(payloadText),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`expected upload target: ${result.error}`);
    }

    await expect(result.target.finalizeUpload({
      tempPath,
      sizeBytes: Buffer.byteLength(payloadText),
      sha256: 'sha256',
    })).resolves.toMatchObject({
      success: true,
      result: {
        ok: false,
        errorCode: 'invalid_request',
        error: 'targetPath must be a relative markdown path',
      },
    });
  });

  it('propagates digest conflicts for project prompt doc uploads', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-home-'));
    const tempPath = join(workspace, 'prompt-asset-upload.json');
    tempDirs.push(workspace, homeDir);

    const registry = createPromptAssetAdapterRegistry({
      homedir: () => homeDir,
    });
    const adapter = registry.get('claude.command');
    if (!adapter) {
      throw new Error('expected claude.command adapter');
    }

    const firstWrite = await adapter.writeDoc({
      assetTypeId: 'claude.command',
      scope: 'project',
      directory: workspace,
      externalRef: null,
      targetPath: 'review/code.md',
      title: 'review/code',
      markdown: '# Review code\n\nUse $ARGUMENTS\n',
      previewOnly: false,
      expectedDigest: null,
    });
    expect(firstWrite.ok).toBe(true);
    if (!firstWrite.ok) {
      throw new Error(`expected initial write to succeed: ${firstWrite.error}`);
    }

    const commandPath = join(workspace, '.claude', 'commands', 'review', 'code.md');
    writeFileSync(commandPath, '# Changed on disk\n', 'utf8');

    const payloadText = JSON.stringify({
      assetTypeId: 'claude.command',
      scope: 'project',
      directory: workspace,
      externalRef: { relativePath: 'review/code.md' },
      targetPath: 'review/code.md',
      title: 'review/code',
      markdown: '# Review code\n\nUse $ARGUMENTS\n',
      previewOnly: false,
      expectedDigest: firstWrite.digest,
    });
    writeFileSync(tempPath, payloadText, 'utf8');

    const result = resolvePromptAssetUploadTarget({
      adapterRegistry: registry,
      sizeBytes: Buffer.byteLength(payloadText),
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`expected upload target: ${result.error}`);
    }

    await expect(result.target.finalizeUpload({
      tempPath,
      sizeBytes: Buffer.byteLength(payloadText),
      sha256: 'sha256',
    })).resolves.toMatchObject({
      success: true,
      result: {
        ok: false,
        errorCode: 'conflict',
        currentDigest: expect.any(String),
      },
    });
    expect(readFileSync(commandPath, 'utf8')).toBe('# Changed on disk\n');
  });

  it('fails closed when the uploaded JSON payload exceeds the prompt transfer size limit', async () => {
    const previous = process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES;
    process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES = '16';
    const { reloadConfiguration } = await import('@/configuration');
    reloadConfiguration();

    try {
      const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-home-'));
      tempDirs.push(homeDir);

      const result = resolvePromptAssetUploadTarget({
        adapterRegistry: createPromptAssetAdapterRegistry({
          homedir: () => homeDir,
        }),
        sizeBytes: 17,
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
