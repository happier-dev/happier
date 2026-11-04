import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ScmComparisonSchema, ScmComparisonFileSchema } from '@happier-dev/protocol/scm/comparison';
import type { ScmComparisonFile } from '@happier-dev/protocol/scm/comparison';
import { ScmDiffSummaryMetadataSchema } from '@happier-dev/protocol/scm/diffSummary';
import { writeFileAtomically } from '@/utils/fs/writeJsonAtomic';
import { projectCapturedComparisonFileIndex } from './projectCapturedComparison';

export const StoredScmComparisonSchema = z.strictObject({
  sessionId: z.optional(z.string()), metadata: ScmDiffSummaryMetadataSchema, comparison: ScmComparisonSchema,
  retainedRefs: z.array(z.strictObject({ ref: z.string(), oid: z.string() })),
});
export type StoredScmComparison = z.infer<typeof StoredScmComparisonSchema>;
export type StoredScmComparisonReader = Readonly<{
  stored: StoredScmComparison; totalFiles: number; legacy?: true;
  readFile: (position: number, kind: 'full' | 'index') => Promise<ScmComparisonFile>;
  findFile: (path: string) => Promise<number | undefined>;
}>;
const StoredReadSchema = createStoredReadSchema(StoredScmComparisonSchema);
const FileReadSchema = createStoredReadSchema(ScmComparisonFileSchema);
const FooterReadSchema = createStoredReadSchema(z.strictObject({ stored: StoredScmComparisonSchema,
  totalFiles: z.number(), recordsOffset: z.number(), pathsOffset: z.number() }));
const magic = Buffer.from('HSCM0001');
const trailerBytes = 8;
// Each position addresses its full record and patch-free record. Sorted path
// digests point to positions, so selecting one path never loads the directory.
const recordBytes = 32;
const pathBytes = 40;
const pathDigest = (root: string, path: string) => createHash('sha256').update(resolve(root, path)).digest();

function* recordChunks(value: StoredScmComparison): Generator<Buffer> {
  yield magic;
  let offset = magic.length;
  const sourceFiles = value.comparison.inventory.files;
  const records = Buffer.alloc(sourceFiles.length * recordBytes);
  const paths: Array<{ digest: Buffer; position: number }> = [];
  for (const [position, file] of sourceFiles.entries()) {
    for (const [kind, entry] of [file, projectCapturedComparisonFileIndex(file)].entries()) {
      const record = Buffer.from(JSON.stringify(entry));
      records.writeBigUInt64BE(BigInt(offset), position * recordBytes + kind * 16);
      records.writeBigUInt64BE(BigInt(record.length), position * recordBytes + kind * 16 + 8);
      yield record;
      offset += record.length;
    }
    paths.push({ digest: pathDigest(value.comparison.repository.rootPath, file.path), position });
  }
  const recordsOffset = offset;
  yield records;
  offset += records.length;
  const pathsOffset = offset;
  paths.sort((a, b) => Buffer.compare(a.digest, b.digest) || a.position - b.position);
  for (const path of paths) {
    const entry = Buffer.alloc(pathBytes);
    path.digest.copy(entry);
    entry.writeBigUInt64BE(BigInt(path.position), 32);
    yield entry;
    offset += entry.length;
  }
  const footer = { stored: { ...value, comparison: { ...value.comparison,
    inventory: { ...value.comparison.inventory, files: [] } } }, totalFiles: sourceFiles.length, recordsOffset, pathsOffset };
  yield Buffer.from(JSON.stringify(footer));
  const trailer = Buffer.alloc(trailerBytes);
  trailer.writeBigUInt64BE(BigInt(offset));
  yield trailer;
}

export async function writeStoredScmComparison(path: string, value: StoredScmComparison): Promise<void> {
  await writeFileAtomically({ path, writeTemporaryFile: async temporaryPath => {
    await writeFile(temporaryPath, recordChunks(value), { mode: 0o600 });
  } });
}

async function readRange(handle: FileHandle, offset: number, length: number, end: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > end) {
    throw new Error('Captured comparison record position is invalid');
  }
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, offset + read);
    if (!result.bytesRead) throw new Error('Captured comparison record is incomplete');
    read += result.bytesRead;
  }
  return buffer;
}

export async function withStoredScmComparison<T>(path: string, consume: (reader: StoredScmComparisonReader) => Promise<T>): Promise<T> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const prefix = await readRange(handle, 0, Math.min(magic.length, size), size);
    // Compatibility lives only at this owner. New captures have one record
    // writer; this low-level reader stays read-only. The capture owner can
    // promote legacy JSON after validating its scope and serving the request.
    if (!prefix.equals(magic)) {
      const stored = StoredReadSchema.parse(JSON.parse((await handle.readFile()).toString('utf8')));
      return await consume({ stored, legacy: true, totalFiles: stored.comparison.inventory.files.length,
        readFile: async (position, kind) => {
          const file = stored.comparison.inventory.files[position];
          if (!file) throw new Error('Captured comparison file position is invalid');
          return kind === 'index' ? projectCapturedComparisonFileIndex(file) : file;
        },
        findFile: async path => {
          const position = stored.comparison.inventory.files.findIndex(file => resolve(stored.comparison.repository.rootPath, file.path)
            === resolve(stored.comparison.repository.rootPath, path));
          return position < 0 ? undefined : position;
        } });
    }
    const trailer = await readRange(handle, size - trailerBytes, trailerBytes, size);
    const footerOffset = Number(trailer.readBigUInt64BE());
    if (footerOffset < magic.length) throw new Error('Captured comparison footer position is invalid');
    const footer = FooterReadSchema.parse(JSON.parse((await readRange(handle, footerOffset,
      size - footerOffset - trailerBytes, size - trailerBytes)).toString('utf8')));
    const { totalFiles, recordsOffset, pathsOffset } = footer;
    if (!Number.isSafeInteger(totalFiles) || totalFiles < 0 || recordsOffset < magic.length
      || recordsOffset + totalFiles * recordBytes !== pathsOffset || pathsOffset + totalFiles * pathBytes !== footerOffset) {
      throw new Error('Captured comparison directory is invalid');
    }
    const readFile: StoredScmComparisonReader['readFile'] = async (position, kind) => {
      if (!Number.isSafeInteger(position) || position < 0 || position >= totalFiles) throw new Error('Captured comparison file position is invalid');
      const descriptor = await readRange(handle, recordsOffset + position * recordBytes + (kind === 'index' ? 16 : 0), 16, pathsOffset);
      const bytes = await readRange(handle, Number(descriptor.readBigUInt64BE()), Number(descriptor.readBigUInt64BE(8)), recordsOffset);
      return FileReadSchema.parse(JSON.parse(bytes.toString('utf8')));
    };
    return await consume({ stored: footer.stored, totalFiles, readFile, findFile: async path => {
      const digest = pathDigest(footer.stored.comparison.repository.rootPath, path);
      let low = 0;
      let high = totalFiles;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const entry = await readRange(handle, pathsOffset + middle * pathBytes, pathBytes, footerOffset);
        if (Buffer.compare(entry.subarray(0, 32), digest) < 0) low = middle + 1;
        else high = middle;
      }
      for (let position = low; position < totalFiles; position++) {
        const entry = await readRange(handle, pathsOffset + position * pathBytes, pathBytes, footerOffset);
        if (!entry.subarray(0, 32).equals(digest)) break;
        const filePosition = Number(entry.readBigUInt64BE(32));
        const file = await readFile(filePosition, 'index');
        if (resolve(footer.stored.comparison.repository.rootPath, file.path) === resolve(footer.stored.comparison.repository.rootPath, path)) return filePosition;
      }
      return undefined;
    } });
  } finally { await handle.close(); }
}

export async function readStoredScmComparison(path: string): Promise<StoredScmComparison> {
  return withStoredScmComparison(path, async reader => {
    const files = [];
    for (let position = 0; position < reader.totalFiles; position++) files.push(await reader.readFile(position, 'full'));
    return { ...reader.stored, comparison: { ...reader.stored.comparison,
      inventory: { ...reader.stored.comparison.inventory, files } } };
  });
}
