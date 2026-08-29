import { createHash } from 'node:crypto';

export type PersonalHomeBackupEntry = Readonly<{ path: string; size: number; sha256: string }>;
export type PersonalHomeBackupManifestV1 = Readonly<{
  format: 'happier-personal-home-backup'; version: 1; createdAt: string; happierVersion: string;
  schemaVersion: string; homeServerIdentityId: string; masterSecretFingerprint: string;
  databaseProvider: 'sqlite'; filesProvider: 'local'; sourcePlatform: string;
  sourceRuntimeMode: 'user' | 'system'; entries: readonly PersonalHomeBackupEntry[];
}>;

export const PERSONAL_HOME_BACKUP_FORMAT = 'happier-personal-home-backup' as const;
export const PERSONAL_HOME_BACKUP_VERSION = 1 as const;
export const PERSONAL_HOME_BACKUP_MAX_ENTRIES = 4096;
export const PERSONAL_HOME_BACKUP_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
export const PERSONAL_HOME_BACKUP_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
export const PERSONAL_HOME_BACKUP_MAX_PATH_LENGTH = 512;
const HEX_64 = /^[a-f0-9]{64}$/u;
const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|clock\$|com[0-9１-９]|lpt[0-9１-９])(?:\..*)?$/iu;

export function fingerprintMasterSecret(secret: Buffer | string): string { return createHash('sha256').update(secret).digest('hex'); }

export function isAllowedPersonalHomeBackupPath(path: string): boolean {
  if (!path || path.length > PERSONAL_HOME_BACKUP_MAX_PATH_LENGTH || path.includes('\\') || path.includes(':')) return false;
  if (path.startsWith('/') || path.startsWith('./') || path.split('/').some((part) => !part || part === '.' || part === '..')) return false;
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  const segments = path.split('/');
  if (segments.some((segment) => /[ .]$/u.test(segment) || WINDOWS_RESERVED_NAMES.test(segment))) return false;
  return path === 'manifest.json' || path === 'database/home.sqlite' || path === 'secrets/handy-master-secret.txt'
    || path === 'configuration/home.env.json' || path.startsWith('files/public/') || path.startsWith('files/private/');
}
export function assertAllowedPersonalHomeBackupPath(path: string): void { if (!isAllowedPersonalHomeBackupPath(path)) throw new Error(`Invalid Personal Home backup path: ${path}`); }

function assertBoundedString(value: unknown, field: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`Invalid Personal Home manifest ${field}`);
}
function assertManifestEntry(value: unknown): PersonalHomeBackupEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Personal Home manifest entry');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'path,sha256,size') throw new Error('Invalid Personal Home manifest entry fields');
  assertBoundedString(record.path, 'entry path', PERSONAL_HOME_BACKUP_MAX_PATH_LENGTH); assertAllowedPersonalHomeBackupPath(record.path);
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 0 || (record.size as number) > PERSONAL_HOME_BACKUP_MAX_ENTRY_BYTES) throw new Error(`Invalid Personal Home manifest entry size: ${record.path}`);
  if (typeof record.sha256 !== 'string' || !HEX_64.test(record.sha256)) throw new Error(`Invalid Personal Home manifest entry hash: ${record.path}`);
  return Object.freeze({ path: record.path, size: record.size as number, sha256: record.sha256 });
}

export function parsePersonalHomeBackupManifest(value: unknown): PersonalHomeBackupManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Personal Home backup manifest');
  const record = value as Record<string, unknown>;
  const expected = ['createdAt', 'databaseProvider', 'entries', 'filesProvider', 'format', 'happierVersion', 'homeServerIdentityId', 'masterSecretFingerprint', 'schemaVersion', 'sourcePlatform', 'sourceRuntimeMode', 'version'];
  if (Object.keys(record).sort().join(',') !== expected.join(',')) throw new Error('Invalid Personal Home manifest fields');
  if (record.format !== PERSONAL_HOME_BACKUP_FORMAT || record.version !== PERSONAL_HOME_BACKUP_VERSION) throw new Error('Unsupported Personal Home backup manifest');
  assertBoundedString(record.createdAt, 'createdAt', 128); if (Number.isNaN(Date.parse(record.createdAt))) throw new Error('Invalid Personal Home manifest createdAt');
  assertBoundedString(record.happierVersion, 'happierVersion'); assertBoundedString(record.schemaVersion, 'schemaVersion'); assertBoundedString(record.homeServerIdentityId, 'homeServerIdentityId');
  if (typeof record.masterSecretFingerprint !== 'string' || !HEX_64.test(record.masterSecretFingerprint)) throw new Error('Invalid Personal Home manifest masterSecretFingerprint');
  if (record.databaseProvider !== 'sqlite' || record.filesProvider !== 'local') throw new Error('Unsupported Personal Home backup provider');
  assertBoundedString(record.sourcePlatform, 'sourcePlatform', 64); if (record.sourceRuntimeMode !== 'user' && record.sourceRuntimeMode !== 'system') throw new Error('Invalid Personal Home manifest sourceRuntimeMode');
  if (!Array.isArray(record.entries) || record.entries.length > PERSONAL_HOME_BACKUP_MAX_ENTRIES) throw new Error('Invalid Personal Home manifest entries');
  const entries = record.entries.map(assertManifestEntry); const seen = new Set<string>();
  for (const entry of entries) { const folded = entry.path.toLocaleLowerCase('en-US'); if (seen.has(folded)) throw new Error(`Duplicate Personal Home backup path: ${entry.path}`); seen.add(folded); }
  for (const required of ['database/home.sqlite', 'secrets/handy-master-secret.txt', 'configuration/home.env.json']) if (!seen.has(required)) throw new Error('Personal Home backup is missing a required entry');
  return Object.freeze({ format: PERSONAL_HOME_BACKUP_FORMAT, version: PERSONAL_HOME_BACKUP_VERSION, createdAt: record.createdAt, happierVersion: record.happierVersion, schemaVersion: record.schemaVersion, homeServerIdentityId: record.homeServerIdentityId, masterSecretFingerprint: record.masterSecretFingerprint, databaseProvider: 'sqlite', filesProvider: 'local', sourcePlatform: record.sourcePlatform, sourceRuntimeMode: record.sourceRuntimeMode, entries: Object.freeze(entries.slice().sort((a, b) => a.path.localeCompare(b.path))) });
}
export function serializePersonalHomeManifest(manifest: PersonalHomeBackupManifestV1): string { return `${JSON.stringify(parsePersonalHomeBackupManifest(manifest), null, 2)}\n`; }
