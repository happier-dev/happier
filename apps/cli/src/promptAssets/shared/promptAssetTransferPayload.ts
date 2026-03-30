import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PromptAssetReadResponseV1 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { estimateJsonUtf8BytesBounded } from '@/transfers/shared/estimateJsonUtf8BytesBounded';
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
  if (estimateJsonUtf8BytesBounded(payload, configuration.promptTransferJsonMaxBytes) > configuration.promptTransferJsonMaxBytes) {
    throw new Error('Prompt transfer payload exceeds size limit');
  }
  const fileBody = JSON.stringify(payload);
  const sizeBytes = Buffer.byteLength(fileBody, 'utf8');
  if (sizeBytes > configuration.promptTransferJsonMaxBytes) {
    throw new Error('Prompt transfer payload exceeds size limit');
  }

  await mkdir(join(tmpdir(), 'happier', 'prompt-assets'), { recursive: true });
  await writeFile(filePath, fileBody, 'utf8');

  return {
    filePath,
    deleteFileOnClose: true,
    sizeBytes,
    name: `${normalizePromptAssetTransferName(payload.title)}.prompt-asset.json`,
  };
}
