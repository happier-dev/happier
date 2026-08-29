import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat, cp, readdir, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createPersonalHomeArchive, verifyPersonalHomeArchive } from './archive.js';
import { type PersonalHomeRuntimeLayout } from './layout.js';
import { fingerprintMasterSecret, type PersonalHomeBackupEntry, type PersonalHomeBackupManifestV1 } from './manifest.js';
import { assertStablePersonalHomeSqliteSnapshot, PersonalHomeSqliteSnapshotError } from './sqliteSnapshot.js';
import { withPersonalHomeOperationLock } from './lock.js';

export type PersonalHomeBackupResult = Readonly<{ path: string; manifest: PersonalHomeBackupManifestV1; sha256: string; homeNeedsAttention?: boolean }>;
export type PersonalHomeSqliteMaintenance = Readonly<{ checkpoint: () => Promise<{ busy: number }>; quickCheck: () => Promise<boolean> }>;

async function addFile(source: string, staging: string, archivePath: string, entries: PersonalHomeBackupEntry[]): Promise<void> {
  const info = await lstat(source); if (!info.isFile() || info.nlink > 1) throw new Error(`Backup source is not a regular file: ${source}`);
  const bytes = await readFile(source); const target = join(staging, archivePath); await mkdir(dirname(target), { recursive: true }); await cp(source, target); await chmod(target, 0o600).catch(() => undefined); entries.push({ path: archivePath, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
}
async function addTree(source: string, staging: string, prefix: string, entries: PersonalHomeBackupEntry[], excludedPath?: string): Promise<void> {
  let names: string[]; try { names = await readdir(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of names.sort()) { const sourcePath = join(source, name); if (excludedPath && resolve(sourcePath) === resolve(excludedPath)) continue; const info = await lstat(sourcePath); const archivePath = join(prefix, name).split('\\').join('/'); if (info.isDirectory()) await addTree(sourcePath, staging, archivePath, entries, excludedPath); else await addFile(sourcePath, staging, archivePath, entries); }
}

function sanitizeConfiguration(configuration: Record<string, unknown>, homeServerIdentityId: string): Record<string, string> {
  const result: Record<string, string> = { homeServerIdentityId };
  const canonicalServerUrl = configuration.canonicalServerUrl;
  if (typeof canonicalServerUrl === 'string' && canonicalServerUrl.length <= 4096) {
    try { const parsed = new URL(canonicalServerUrl); if (parsed.protocol === 'http:' || parsed.protocol === 'https:') result.canonicalServerUrl = canonicalServerUrl.replace(/\/+$/u, ''); } catch { /* malformed origin is not restorable configuration */ }
  }
  result.encryptionStoragePolicy = 'plaintext_only';
  result.defaultAccountMode = 'plain';
  result.anonymousSignupPhase = 'loopback-bootstrap-then-disabled';
  return result;
}

export async function createPersonalHomeBackup(params: Readonly<{
  layout: PersonalHomeRuntimeLayout; outputPath: string; stagingDir: string; homeServerIdentityId: string; schemaVersion: string; happierVersion: string; configuration: Record<string, unknown>; sqlite?: PersonalHomeSqliteMaintenance; rotate?: Readonly<{ maxBackups?: number; maxBytes?: number }>; wasRunning?: boolean; stopHome?: () => Promise<void>; startHome?: () => Promise<void>;
}>): Promise<PersonalHomeBackupResult> {
  return withPersonalHomeOperationLock(params.layout.dataDir, 'backup', async () => {
    if (params.wasRunning && !params.stopHome) throw new Error('Backup requires a stopHome callback when the Home is running');
    let homeNeedsAttention = false;
    if (params.wasRunning) await params.stopHome!();
    if (params.sqlite) await assertStablePersonalHomeSqliteSnapshot({ databasePath: params.layout.databasePath, ...params.sqlite });
    const databaseBefore = params.sqlite ? await stat(params.layout.databasePath) : undefined;
    const staging = resolve(params.stagingDir); await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
    let backupResult: PersonalHomeBackupResult | undefined;
    try {
      const entries: PersonalHomeBackupEntry[] = [];
      await addFile(params.layout.databasePath, staging, 'database/home.sqlite', entries);
      if (databaseBefore) {
        const databaseAfter = await stat(params.layout.databasePath);
        if (databaseAfter.size !== databaseBefore.size || databaseAfter.mtimeMs !== databaseBefore.mtimeMs) throw new PersonalHomeSqliteSnapshotError('sqlite_snapshot_unstable', 'SQLite database changed during backup');
        for (const suffix of ['-wal', '-shm']) { try { if ((await stat(`${params.layout.databasePath}${suffix}`)).size > 0) throw new PersonalHomeSqliteSnapshotError('sqlite_snapshot_unstable', `SQLite sidecar remains: ${suffix}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
      }
      await addTree(params.layout.publicFilesDir, staging, 'files/public', entries, params.layout.privateFilesDir);
      await addTree(params.layout.privateFilesDir, staging, 'files/private', entries);
      await addFile(params.layout.masterSecretPath, staging, 'secrets/handy-master-secret.txt', entries);
      const configBytes = Buffer.from(`${JSON.stringify(sanitizeConfiguration(params.configuration, params.homeServerIdentityId), null, 2)}\n`); const configPath = join(staging, 'configuration/home.env.json'); await mkdir(dirname(configPath), { recursive: true }); await writeFile(configPath, configBytes, { mode: 0o600 }); entries.push({ path: 'configuration/home.env.json', size: configBytes.byteLength, sha256: createHash('sha256').update(configBytes).digest('hex') });
      const manifest: PersonalHomeBackupManifestV1 = { format: 'happier-personal-home-backup', version: 1, createdAt: new Date().toISOString(), happierVersion: params.happierVersion, schemaVersion: params.schemaVersion, homeServerIdentityId: params.homeServerIdentityId, masterSecretFingerprint: fingerprintMasterSecret(await readFile(params.layout.masterSecretPath)), databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: params.layout.platform, sourceRuntimeMode: params.layout.mode, entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
      const archive = await createPersonalHomeArchive({ stagingDir: staging, outputPath: params.outputPath, manifest });
      await verifyPersonalHomeArchive(archive.path);
      await rotatePersonalHomeBackups({ backupsDir: params.layout.backupsDir, ...(params.rotate ?? {}), protectPath: archive.path });
      backupResult = { path: archive.path, manifest, sha256: archive.sha256 };
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (params.wasRunning && params.startHome) await params.startHome().catch(() => { homeNeedsAttention = true; });
    }
    if (!backupResult) throw new Error('Personal Home backup did not produce a result');
    return homeNeedsAttention ? { ...backupResult, homeNeedsAttention: true } : backupResult;
  });
}

export type PersonalHomeBackupRotationResult = Readonly<{ retained: string[]; removed: string[] }>;
export async function rotatePersonalHomeBackups(params: Readonly<{ backupsDir: string; maxBackups?: number; maxBytes?: number; protectPath?: string }>): Promise<PersonalHomeBackupRotationResult> {
  const maxBackups = Math.max(1, Math.floor(params.maxBackups ?? 5)); const maxBytes = params.maxBytes ?? Number.POSITIVE_INFINITY; await mkdir(params.backupsDir, { recursive: true });
  const candidates: Array<{ path: string; createdAt: number; size: number }> = [];
  for (const name of await readdir(params.backupsDir)) {
    if (!name.endsWith('.tar')) continue; const path = resolve(params.backupsDir, name); if (params.protectPath && resolve(params.protectPath) === path) { try { const info = await stat(path); const manifest = await verifyPersonalHomeArchive(path); candidates.push({ path, createdAt: Date.parse(manifest.createdAt), size: info.size }); } catch { /* protected invalid output is left for caller */ } continue; }
    try { const info = await stat(path); const manifest = await verifyPersonalHomeArchive(path); candidates.push({ path, createdAt: Date.parse(manifest.createdAt), size: info.size }); } catch { continue; }
  }
  candidates.sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path)); const retained: string[] = []; const removed: string[] = []; let total = 0;
  for (const candidate of candidates) { const keep = retained.length < maxBackups && total + candidate.size <= maxBytes || retained.length === 0; if (keep) { retained.push(candidate.path); total += candidate.size; } else { await rm(candidate.path, { force: true }); removed.push(candidate.path); } }
  return { retained, removed };
}
