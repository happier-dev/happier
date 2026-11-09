import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { BrowserExtensionIdV1Schema, BrowserExtensionRecordV1Schema, type BrowserExtensionRecordV1 } from '@happier-dev/protocol/browser/profile/v1';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

function recordsDirectory(profileDirectory: string): string {
  return join(profileDirectory, 'extensions', 'records');
}

export async function readProfileExtensions(profileDirectory: string, extensionIds?: readonly string[]): Promise<BrowserExtensionRecordV1[]> {
  const directory = recordsDirectory(profileDirectory);
  if (extensionIds) {
    const ids = [...new Set(extensionIds)].filter(id => BrowserExtensionIdV1Schema.safeParse(id).success);
    const records = await Promise.all(ids.map(async id => {
      const content = await readFile(join(directory, `${id}.json`), 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw error;
      });
      return content === null ? null : BrowserExtensionRecordV1Schema.parse(JSON.parse(content));
    }));
    return records.filter((record): record is BrowserExtensionRecordV1 => record !== null).sort((left, right) => left.id.localeCompare(right.id));
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  });
  const records = await Promise.all(entries
    .filter(entry => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.json'))
    .map(async entry => BrowserExtensionRecordV1Schema.parse(JSON.parse(await readFile(join(directory, entry.name), 'utf8')))));
  return records.sort((left, right) => left.id.localeCompare(right.id));
}

export async function writeProfileExtension(profileDirectory: string, extension: BrowserExtensionRecordV1): Promise<void> {
  await writeJsonAtomic(join(recordsDirectory(profileDirectory), `${extension.id}.json`), extension);
}

export async function removeProfileExtension(profileDirectory: string, extensionId: string): Promise<void> {
  await rm(join(recordsDirectory(profileDirectory), `${extensionId}.json`), { force: true });
}
