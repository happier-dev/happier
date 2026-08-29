import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, lstat, writeFile, rm, open, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as tar from 'tar';
import {
  assertAllowedPersonalHomeBackupPath,
  parsePersonalHomeBackupManifest,
  PERSONAL_HOME_BACKUP_MAX_ARCHIVE_BYTES,
  PERSONAL_HOME_BACKUP_MAX_ENTRY_BYTES,
  type PersonalHomeBackupManifestV1,
} from './manifest.js';

export type PersonalHomeArchiveResult = Readonly<{ path: string; sha256: string }>;

export async function createPersonalHomeArchive(params: Readonly<{ stagingDir: string; outputPath: string; manifest: PersonalHomeBackupManifestV1 }>): Promise<PersonalHomeArchiveResult> {
  const staging = resolve(params.stagingDir); const output = resolve(params.outputPath);
  await mkdir(staging, { recursive: true }); await mkdir(dirname(output), { recursive: true });
  await writeFile(join(staging, 'manifest.json'), JSON.stringify(parsePersonalHomeBackupManifest(params.manifest), null, 2) + '\n', { mode: 0o600 });
  const paths = await walk(staging); const names = paths.map((path) => relative(staging, path).split(sep).join('/')).sort();
  for (const name of names) assertAllowedPersonalHomeBackupPath(name);
  const temporary = `${output}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await tar.create({ cwd: staging, file: temporary, portable: true, noMtime: true, follow: false }, names);
    const handle = await open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    const bytes = await readFile(temporary); const sha256 = createHash('sha256').update(bytes).digest('hex'); await chmod(temporary, 0o600);
    await verifyPersonalHomeArchive(temporary); await rename(temporary, output);
    return { path: output, sha256 };
  } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

type ArchiveEntry = { path: string; type?: string; linkpath?: string; size?: number };
async function listArchive(path: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await tar.list({ file: path, strict: true, preservePaths: true, onentry: (entry) => { entries.push({ path: entry.path, type: entry.type, linkpath: entry.linkpath, size: entry.size }); } });
  return entries;
}

async function validateArchiveEntries(path: string): Promise<ArchiveEntry[]> {
  const info = await stat(path); if (info.size > PERSONAL_HOME_BACKUP_MAX_ARCHIVE_BYTES) throw new Error('Personal Home backup archive exceeds size limit');
  const entries = await listArchive(path); const seen = new Set<string>();
  for (const entry of entries) {
    assertAllowedPersonalHomeBackupPath(entry.path);
    if (entry.size !== undefined && entry.size > PERSONAL_HOME_BACKUP_MAX_ENTRY_BYTES) throw new Error(`Archive entry exceeds size limit: ${entry.path}`);
    if (entry.type && entry.type !== 'File' && entry.type !== 'OldFile') throw new Error(`Unsupported archive entry type: ${entry.path}`);
    const folded = entry.path.toLocaleLowerCase('en-US'); if (seen.has(folded)) throw new Error(`Duplicate archive entry: ${entry.path}`); seen.add(folded);
    if (entry.linkpath) throw new Error(`Archive links are not supported: ${entry.path}`);
  }
  if (!seen.has('manifest.json')) throw new Error('Personal Home backup manifest is missing');
  return entries;
}

export async function extractVerifiedPersonalHomeArchive(archivePath: string, destinationDir: string): Promise<PersonalHomeBackupManifestV1> {
  const entries = await validateArchiveEntries(archivePath); const destination = resolve(destinationDir); await mkdir(destination, { recursive: true });
  await tar.extract({ file: archivePath, cwd: destination, strict: true, preservePaths: false, follow: false });
  for (const entry of entries) { const file = resolve(destination, entry.path); const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error(`Unsupported extracted archive entry: ${entry.path}`); }
  const manifest = parsePersonalHomeBackupManifest(JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8')));
  const expected = new Set(['manifest.json', ...manifest.entries.map((entry) => entry.path)]);
  if (expected.size !== entries.length || entries.some((entry) => !expected.has(entry.path))) throw new Error('Archive entries do not match manifest');
  for (const entry of manifest.entries) { const bytes = await readFile(join(destination, entry.path)); if (bytes.byteLength !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Backup hash mismatch: ${entry.path}`); }
  return manifest;
}

export async function verifyPersonalHomeArchive(path: string): Promise<PersonalHomeBackupManifestV1> {
  const temporary = `${resolve(path)}.verify-${process.pid}-${randomUUID()}`; await mkdir(temporary, { recursive: true });
  try { return await extractVerifiedPersonalHomeArchive(path, temporary); } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    const { readdir } = await import('node:fs/promises');
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name); const info = await lstat(path);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error(`Unsupported link in backup: ${path}`);
      if (info.isDirectory()) await visit(path); else if (info.isFile()) out.push(path); else throw new Error(`Unsupported file type in backup: ${path}`);
    }
  }
  await visit(root); return out;
}
