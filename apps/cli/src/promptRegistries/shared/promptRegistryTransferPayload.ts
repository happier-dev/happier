import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PromptRegistryFetchedItemV1 } from '@happier-dev/protocol';

import type { DownloadTransferSource } from '@/transfers/targets/downloadTransferSource';

function createTempPromptRegistryPayloadPath(): string {
  return join(tmpdir(), 'happier', 'prompt-registry-items', `${randomUUID()}.json`);
}

function normalizePromptRegistryPayloadName(title: string): string {
  const normalized = title
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized.length > 0 ? normalized : 'prompt-registry-item';
}

export async function writePromptRegistryTransferPayload(
  payload: PromptRegistryFetchedItemV1,
): Promise<DownloadTransferSource> {
  const filePath = createTempPromptRegistryPayloadPath();
  const fileBody = JSON.stringify(payload);

  await mkdir(join(tmpdir(), 'happier', 'prompt-registry-items'), { recursive: true });
  await writeFile(filePath, fileBody, 'utf8');

  const payloadStats = await stat(filePath);
  return {
    filePath,
    deleteFileOnClose: true,
    sizeBytes: payloadStats.size,
    name: `${normalizePromptRegistryPayloadName(payload.title)}.prompt-registry-item.json`,
  };
}
