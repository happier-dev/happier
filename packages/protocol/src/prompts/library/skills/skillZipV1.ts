import { openZipEntriesV1 } from '../../../archives/zipEntriesV1.js';
import { decodeBase64, encodeBase64 } from '../../../crypto/base64.js';
import type { SkillFileInputV1 } from './skillActionSchemasV1.js';

export function skillFileFromBytesV1(path: string, bytes: Uint8Array, unixMode?: number): SkillFileInputV1 {
  let contentKind: 'utf8' | 'binary' = 'binary';
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); contentKind = 'utf8'; } catch {}
  return { path, contentBase64: encodeBase64(bytes, 'base64'), contentKind, ...(unixMode === undefined ? {} : { unixMode }) };
}

export async function readSkillZipFilesV1(bytes: Uint8Array): Promise<SkillFileInputV1[]> {
  const archive = await openZipEntriesV1(bytes);
  try {
    const files: SkillFileInputV1[] = [];
    for (const entry of archive.entries) {
      if (!entry.directory) files.push(skillFileFromBytesV1(entry.path, await entry.read(), entry.unixMode));
    }
    return files;
  } finally { await archive.close(); }
}

/** One portable archive producer for both UI downloads and CLI exports. */
export async function exportSkillBundlesAsZipV1(items: readonly Readonly<{ name: string; files: readonly SkillFileInputV1[] }>[]) {
  const { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } = await import('@zip.js/zip.js');
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const names = new Set<string>();
  for (const item of items) {
    if (names.has(item.name)) throw Object.assign(new Error('duplicate_skill_name'), { code: 'duplicate_skill_name' });
    names.add(item.name);
    for (const file of item.files) {
      await writer.add(`${item.name}/${file.path}`, new Uint8ArrayReader(decodeBase64(file.contentBase64, 'base64')),
        { level: 0, useWebWorkers: false, externalFileAttributes: ((0o100000 | (file.unixMode ?? 0o644)) << 16) >>> 0, msDosCompatible: false });
    }
  }
  return { fileName: items.length === 1 ? `${items[0]!.name}.zip` : 'skills.zip', bytes: encodeBase64(await writer.close(), 'base64') };
}
