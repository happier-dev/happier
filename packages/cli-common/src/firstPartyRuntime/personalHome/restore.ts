import { randomUUID } from 'node:crypto';
import { mkdir, lstat, rename, rm, statfs } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { extractVerifiedPersonalHomeArchive, verifyPersonalHomeArchive } from './archive.js';
import { type PersonalHomeRuntimeLayout } from './layout.js';
import { fingerprintMasterSecret } from './manifest.js';
import { withPersonalHomeOperationLock } from './lock.js';

export class PersonalHomeRestoreError extends Error {
  constructor(public readonly code: 'destination_not_empty' | 'identity_mismatch' | 'insufficient_space' | 'restore_failed', message: string) { super(message); this.name = 'PersonalHomeRestoreError'; }
}
export type PersonalHomeRestoreResult = Readonly<{ outcome: 'restored' | 'rolled_back'; manifest: Awaited<ReturnType<typeof verifyPersonalHomeArchive>>; rollbackDir?: string; error?: string }>;
export type PersonalHomeRestoreHooks = Readonly<{
  expectedHomeServerIdentityId?: string;
  expectedSchemaVersion?: string;
  confirmOverwrite?: boolean;
  minFreeBytes?: number;
  stopHome?: () => Promise<void>;
  startHome?: () => Promise<void>;
  healthCheck?: () => Promise<boolean>;
  verifyIdentity?: (manifest: PersonalHomeRestoreResult['manifest']) => Promise<boolean>;
  quickCheck?: (databasePath: string) => Promise<boolean>;
  runMigrations?: (databasePath: string, manifest: PersonalHomeRestoreResult['manifest']) => Promise<void>;
  rebuildSearch?: () => Promise<void>;
}>;

const targetEntries = (layout: PersonalHomeRuntimeLayout, stage: string): Array<{ target: string; source: string }> => [
  { target: layout.databasePath, source: join(stage, 'database/home.sqlite') },
  { target: layout.publicFilesDir, source: join(stage, 'files/public') },
  { target: layout.privateFilesDir, source: join(stage, 'files/private') },
  { target: layout.masterSecretPath, source: join(stage, 'secrets/handy-master-secret.txt') },
  { target: join(layout.dataDir, 'configuration/home.env.json'), source: join(stage, 'configuration/home.env.json') },
];
async function exists(path: string): Promise<boolean> { return lstat(path).then(() => true).catch(() => false); }
async function hasMeaningfulData(layout: PersonalHomeRuntimeLayout): Promise<boolean> { for (const path of [layout.databasePath, layout.publicFilesDir, layout.privateFilesDir, layout.masterSecretPath]) if (await exists(path)) return true; return false; }
async function moveIfPresent(from: string, to: string): Promise<void> { if (!(await exists(from))) return; await mkdir(dirname(to), { recursive: true }); await rename(from, to); }

export async function restorePersonalHomeBackup(params: Readonly<{ layout: PersonalHomeRuntimeLayout; archivePath: string } & PersonalHomeRestoreHooks>): Promise<PersonalHomeRestoreResult> {
  return withPersonalHomeOperationLock(params.layout.dataDir, 'restore', async () => {
    const manifest = await verifyPersonalHomeArchive(params.archivePath);
    if (params.expectedHomeServerIdentityId && params.expectedHomeServerIdentityId !== manifest.homeServerIdentityId) throw new PersonalHomeRestoreError('identity_mismatch', 'Personal Home identity does not match restore target');
    if (params.expectedSchemaVersion && isSchemaNewer(manifest.schemaVersion, params.expectedSchemaVersion)) throw new PersonalHomeRestoreError('identity_mismatch', 'Personal Home backup schema is newer than this runtime');
    if (await hasMeaningfulData(params.layout) && params.confirmOverwrite !== true) throw new PersonalHomeRestoreError('destination_not_empty', 'Destination Personal Home contains data; explicit overwrite confirmation is required');
    if (params.minFreeBytes !== undefined) { const usage = await statfs(params.layout.dataDir).catch(() => statfs(dirname(params.layout.dataDir))).catch(() => undefined); if (usage && usage.bavail * usage.bsize < params.minFreeBytes) throw new PersonalHomeRestoreError('insufficient_space', 'Insufficient free space for Personal Home restore'); }
    const stage = `${params.layout.dataDir}.restore-stage-${process.pid}-${randomUUID()}`; const rollbackDir = `${params.layout.dataDir}.restore-rollback-${process.pid}-${randomUUID()}`;
    await mkdir(stage, { recursive: true });
    try {
      await extractVerifiedPersonalHomeArchive(params.archivePath, stage);
      const secret = await import('node:fs/promises').then(({ readFile }) => readFile(join(stage, 'secrets/handy-master-secret.txt')));
      if (fingerprintMasterSecret(secret) !== manifest.masterSecretFingerprint) throw new PersonalHomeRestoreError('restore_failed', 'Restored Home master secret fingerprint does not match manifest');
      if (params.quickCheck && !(await params.quickCheck(join(stage, 'database/home.sqlite')))) throw new PersonalHomeRestoreError('restore_failed', 'Restored SQLite quick_check failed');
      if (params.stopHome) await params.stopHome();
      const targets = targetEntries(params.layout, stage); await mkdir(rollbackDir, { recursive: true });
      for (const { target } of targets) if (await exists(target)) await moveIfPresent(target, join(rollbackDir, relative(params.layout.dataDir, target)));
      for (const { target, source } of targets) if (await exists(source)) await moveIfPresent(source, target);
      try {
        if (params.runMigrations) await params.runMigrations(params.layout.databasePath, manifest);
        if (params.startHome) await params.startHome();
        if (params.healthCheck && !(await params.healthCheck())) throw new Error('Personal Home health check failed');
        if (params.verifyIdentity && !(await params.verifyIdentity(manifest))) throw new Error('Personal Home identity verification failed');
        if (params.rebuildSearch) await params.rebuildSearch();
        return { outcome: 'restored', manifest, rollbackDir };
      } catch (error) {
        await params.stopHome?.().catch(() => undefined);
        for (const { target } of targets) await rm(target, { recursive: true, force: true });
        for (const { target } of targets) await moveIfPresent(join(rollbackDir, relative(params.layout.dataDir, target)), target);
        if (params.startHome) await params.startHome().catch(() => undefined);
        return { outcome: 'rolled_back', manifest, rollbackDir, error: error instanceof Error ? error.message : String(error) };
      }
    } finally { await rm(stage, { recursive: true, force: true }).catch(() => undefined); }
  });
}

function isSchemaNewer(candidate: string, supported: string): boolean {
  const candidateNumber = /^\d+$/u.test(candidate) ? Number(candidate) : undefined;
  const supportedNumber = /^\d+$/u.test(supported) ? Number(supported) : undefined;
  return candidateNumber !== undefined && supportedNumber !== undefined ? candidateNumber > supportedNumber : false;
}
