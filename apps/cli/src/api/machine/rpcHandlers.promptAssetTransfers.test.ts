import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  createEncryptedTransferChunkEnvelope,
  createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope,
} from '@/machines/transfer/transferChunkEncryption';

import { registerMachineRpcHandlers } from './rpcHandlers';

type Handler = (data: unknown) => Promise<any>;

const PROMPT_ASSET_DOWNLOAD_METHODS = {
  init: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
  chunk: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
  finalize: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
  abort: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
} as const;

const PROMPT_ASSET_UPLOAD_METHODS = {
  init: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT,
  chunk: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK,
  finalize: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE,
  abort: RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_ABORT,
} as const;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

async function downloadAllChunks(input: Readonly<{
  init: Handler;
  chunk: Handler;
  finalize: Handler;
  request: unknown;
}>): Promise<Buffer> {
  const recipientKeyPair = createTransferRecipientKeyPair();
  const initResponse = await input.init({
    ...(input.request as Record<string, unknown>),
    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
  });
  expect(initResponse).toMatchObject({ success: true });

  const chunks: Buffer[] = [];
  for (let index = 0; index < 1000; index += 1) {
    const chunkResponse = await input.chunk({ downloadId: initResponse.downloadId, index });
    expect(chunkResponse).toMatchObject({ success: true });
    chunks.push(decryptEncryptedTransferChunkEnvelope({
      transferId: initResponse.downloadId as string,
      sequence: index,
      payloadBase64: chunkResponse.payloadBase64 as string,
      encryptedDataKeyEnvelopeBase64: chunkResponse.encryptedDataKeyEnvelopeBase64 as string,
      recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
    }));
    if (chunkResponse.isLast === true) break;
  }

  await expect(input.finalize({ downloadId: initResponse.downloadId })).resolves.toEqual({ success: true });
  return Buffer.concat(chunks);
}

async function uploadAllChunks(input: Readonly<{
  init: Handler;
  chunk: Handler;
  finalize: Handler;
  request: unknown;
  bytes: Buffer;
}>): Promise<unknown> {
  const initResponse = await input.init(input.request);
  expect(initResponse).toMatchObject({ success: true });

  const chunkSizeBytes = Number((initResponse as { chunkSizeBytes?: unknown }).chunkSizeBytes);
  expect(Number.isFinite(chunkSizeBytes) && chunkSizeBytes > 0).toBe(true);
  expect(initResponse).toMatchObject({ recipientPublicKeyBase64: expect.any(String) });

  for (let offset = 0, index = 0; offset < input.bytes.length; offset += chunkSizeBytes, index += 1) {
    const next = input.bytes.subarray(offset, Math.min(input.bytes.length, offset + chunkSizeBytes));
    const encryptedChunk = createEncryptedTransferChunkEnvelope({
      transferId: (initResponse as { uploadId: string }).uploadId,
      sequence: index,
      payload: next,
      recipientPublicKeyBase64: (initResponse as { recipientPublicKeyBase64: string }).recipientPublicKeyBase64,
    });
    await expect(input.chunk({
      uploadId: (initResponse as { uploadId: string }).uploadId,
      index,
      payloadBase64: encryptedChunk.payloadBase64,
      encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
    })).resolves.toEqual({ success: true });
  }

  return await input.finalize({ uploadId: (initResponse as { uploadId: string }).uploadId });
}

describe('rpcHandlers (prompt asset transfers)', () => {
  it('registers daemon.promptAssets.download.* handlers', () => {
    const mgr = createRpcHandlerManager();

    registerMachineRpcHandlers({
      rpcHandlerManager: mgr as any,
      handlers: {
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(mgr.handlers.has(PROMPT_ASSET_DOWNLOAD_METHODS.init)).toBe(true);
    expect(mgr.handlers.has(PROMPT_ASSET_DOWNLOAD_METHODS.chunk)).toBe(true);
    expect(mgr.handlers.has(PROMPT_ASSET_DOWNLOAD_METHODS.finalize)).toBe(true);
    expect(mgr.handlers.has(PROMPT_ASSET_DOWNLOAD_METHODS.abort)).toBe(true);
  });

  it('registers daemon.promptAssets.upload.* handlers', () => {
    const mgr = createRpcHandlerManager();

    registerMachineRpcHandlers({
      rpcHandlerManager: mgr as any,
      handlers: {
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
    });

    expect(mgr.handlers.has(PROMPT_ASSET_UPLOAD_METHODS.init)).toBe(true);
    expect(mgr.handlers.has(PROMPT_ASSET_UPLOAD_METHODS.chunk)).toBe(true);
    expect(mgr.handlers.has(PROMPT_ASSET_UPLOAD_METHODS.finalize)).toBe(true);
    expect(mgr.handlers.has(PROMPT_ASSET_UPLOAD_METHODS.abort)).toBe(true);
  });

  it('downloads a bundle prompt asset through the generic chunk lifecycle', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-prompt-transfer-workspace-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-transfer-home-'));

    try {
      mkdirSync(join(homeDir, '.agents', 'skills', 'reviewer'), { recursive: true });
      writeFileSync(join(homeDir, '.agents', 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');
      writeFileSync(join(homeDir, '.agents', 'skills', 'reviewer', 'notes.txt'), 'Remember this\n', 'utf8');

      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const init = mgr.handlers.get(PROMPT_ASSET_DOWNLOAD_METHODS.init);
      const chunk = mgr.handlers.get(PROMPT_ASSET_DOWNLOAD_METHODS.chunk);
      const finalize = mgr.handlers.get(PROMPT_ASSET_DOWNLOAD_METHODS.finalize);
      if (!init || !chunk || !finalize) throw new Error('expected prompt asset download handlers');

      const bytes = await downloadAllChunks({
        init,
        chunk,
        finalize,
        request: {
          assetTypeId: 'agents.skill',
          scope: 'user',
          externalRef: { skillName: 'reviewer' },
        },
      });

      const parsedPayload = JSON.parse(bytes.toString('utf8'));
      expect(parsedPayload).toMatchObject({
        assetTypeId: 'agents.skill',
        scope: 'user',
        libraryKind: 'bundle',
        title: 'reviewer',
        bundleSchemaId: 'skills.skill_md_v1',
      });
      expect(parsedPayload.bundleBody.entries.map((entry: { path: string }) => entry.path)).toEqual(['SKILL.md', 'notes.txt']);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('returns prompt asset read errors from download init', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-transfer-home-'));

    try {
      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const init = mgr.handlers.get(PROMPT_ASSET_DOWNLOAD_METHODS.init);
      if (!init) throw new Error('expected prompt asset download init handler');
      const recipientKeyPair = createTransferRecipientKeyPair();

      await expect(init({
        assetTypeId: 'agents.skill',
        scope: 'user',
        externalRef: { skillName: 'missing' },
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
      })).resolves.toEqual({
        success: false,
        error: 'skill not found',
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('uploads a bundle prompt asset through the generic chunk lifecycle', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-transfer-home-'));

    try {
      const mgr = createRpcHandlerManager();
      registerMachineRpcHandlers({
        rpcHandlerManager: mgr as any,
        handlers: {
          spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
          stopSession: async () => true,
          requestShutdown: () => {},
        },
        deps: {
          promptAssetsHomedir: () => homeDir,
        },
      });

      const init = mgr.handlers.get(PROMPT_ASSET_UPLOAD_METHODS.init);
      const chunk = mgr.handlers.get(PROMPT_ASSET_UPLOAD_METHODS.chunk);
      const finalize = mgr.handlers.get(PROMPT_ASSET_UPLOAD_METHODS.finalize);
      if (!init || !chunk || !finalize) throw new Error('expected prompt asset upload handlers');

      const uploadPayload = Buffer.from(JSON.stringify({
        assetTypeId: 'agents.skill',
        scope: 'user',
        externalRef: null,
        targetName: 'writer',
        title: 'Writer',
        bundleSchemaId: 'skills.skill_md_v1',
        bundleBody: {
          v: 1,
          entries: [
            { path: 'SKILL.md', contentBase64: Buffer.from('# Writer\n', 'utf8').toString('base64'), contentKind: 'utf8' },
          ],
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        previewOnly: false,
        expectedDigest: null,
      }), 'utf8');

      await expect(uploadAllChunks({
        init,
        chunk,
        finalize,
        request: { sizeBytes: uploadPayload.byteLength },
        bytes: uploadPayload,
      })).resolves.toEqual({
        success: true,
        response: expect.objectContaining({
          ok: true,
          externalRef: { skillName: 'writer' },
        }),
      });

      expect(readFileSync(join(homeDir, '.agents', 'skills', 'writer', 'SKILL.md'), 'utf8')).toBe('# Writer\n');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
