import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PromptAssetReadResponseV1 } from '@happier-dev/protocol';

import type { DownloadTransferSource } from '@/transfers/targets/downloadTransferSource';

export type PromptAssetTransferPayload = Extract<PromptAssetReadResponseV1, { ok: true }>['item'];

function createTempPromptAssetPayloadPath(): string {
  return join(tmpdir(), 'happier', 'prompt-assets', `${randomUUID()}.json`);
}

function normalizePromptAssetTransferName(title: string): string {
  const normalized = title
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized.length > 0 ? normalized : 'prompt-asset';
}

export async function writePromptAssetTransferPayload(
  payload: PromptAssetTransferPayload,
): Promise<DownloadTransferSource> {
  const filePath = createTempPromptAssetPayloadPath();
  const fileBody = JSON.stringify(payload);

  await mkdir(join(tmpdir(), 'happier', 'prompt-assets'), { recursive: true });
  await writeFile(filePath, fileBody, 'utf8');

  const payloadStats = await stat(filePath);
  return {
    filePath,
    deleteFileOnClose: true,
    sizeBytes: payloadStats.size,
    name: `${normalizePromptAssetTransferName(payload.title)}.prompt-asset.json`,
  };
}
