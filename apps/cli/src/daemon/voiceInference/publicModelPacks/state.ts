import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

import { VoiceModelPackIdentityV1Schema } from '@happier-dev/protocol';
import type {
  InstalledVoiceModelPackMetadataV1,
  VoiceModelPackArtifactBindingV1,
  VoiceModelPackIdentityV1,
  VoiceModelPackLicenseAcceptanceV1,
} from '@happier-dev/voice-modelpacks';
import {
  deriveVoiceModelPackDirectoryKeyV1,
  normalizeVoiceModelPackSha256DigestV1,
  parseVoiceModelPackArtifactBindingV1,
} from '@happier-dev/voice-modelpacks';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

const STATE_MAX_ENCODED_BYTES = 1024 * 1024;
const STATE_MAX_RECORDS = 1024;
const SHA256_DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/i;

type AcceptedLicenseRecordV1 = VoiceModelPackLicenseAcceptanceV1 & Readonly<{ acceptedAtMs: number }>;
type UnboundInstalledRecordV1 = Readonly<{
  identity: VoiceModelPackIdentityV1;
  directoryKey: string;
}>;

export type DaemonPublicVoiceModelPackStateV1 = Readonly<{
  schemaVersion: 1;
  accountId: string;
  machineId: string;
  installed: readonly InstalledVoiceModelPackMetadataV1[];
  licenseAcceptances: readonly AcceptedLicenseRecordV1[];
  /** Legacy metadata is cleanup-only; it never participates in admission or load. */
  unboundInstalled: readonly UnboundInstalledRecordV1[];
  unboundLicenseAcceptances: readonly unknown[];
}>;

function assertBoundedId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.trim() !== value) {
    throw new Error('voice_model_pack_state_invalid');
  }
  return value;
}

function assertDigest(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw new Error('voice_model_pack_state_invalid');
  }
  return value.toLowerCase();
}

function assertHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || value.trim() !== value) {
    throw new Error('voice_model_pack_state_invalid');
  }
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('voice_model_pack_state_invalid');
  }
  return value;
}

function assertNonNegativeSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('voice_model_pack_state_invalid');
  }
  return value;
}

function assertOnlyKnownKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) {
    throw new Error('voice_model_pack_state_invalid');
  }
}

function assertExactKeys(raw: Record<string, unknown>, expected: readonly string[]): void {
  assertOnlyKnownKeys(raw, expected);
  if (Object.keys(raw).length !== expected.length || expected.some((key) => !Object.hasOwn(raw, key))) {
    throw new Error('voice_model_pack_state_invalid');
  }
}

function parseCleanupOnlyInstalled(value: unknown): UnboundInstalledRecordV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  try {
    assertExactKeys(raw, ['identity', 'directoryKey']);
    const identity = VoiceModelPackIdentityV1Schema.parse(raw.identity);
    const directoryKey = assertBoundedId(raw.directoryKey);
    if (deriveVoiceModelPackDirectoryKeyV1(identity) !== directoryKey) return null;
    return Object.freeze({ identity: Object.freeze(identity), directoryKey });
  } catch {
    return null;
  }
}

function parseLegacyCleanupOnlyInstalled(value: unknown): UnboundInstalledRecordV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  // This is deliberately a cleanup locator, not an old metadata reader: old
  // digest-bound state never becomes loadable or license-authoritative again.
  if (raw.schemaVersion !== 1 || !Object.hasOwn(raw, 'pluginSourceDigest')) return null;
  return parseCleanupOnlyInstalled({ identity: raw.identity, directoryKey: raw.directoryKey });
}

export function parseInstalledVoiceModelPackMetadataV1(value: unknown): InstalledVoiceModelPackMetadataV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('voice_model_pack_state_invalid');
  const raw = value as Record<string, unknown>;
  assertExactKeys(raw, [
    'schemaVersion',
    'identity',
    'directoryKey',
    'pluginVersion',
    'artifactBinding',
    'packVersion',
    'manifestDigest',
    'verifiedAtMs',
  ]);
  const identity = VoiceModelPackIdentityV1Schema.parse(raw.identity);
  const directoryKey = assertBoundedId(raw.directoryKey);
  if (deriveVoiceModelPackDirectoryKeyV1(identity) !== directoryKey) {
    throw new Error('voice_model_pack_directory_key_mismatch');
  }
  if (raw.schemaVersion !== 1) throw new Error('voice_model_pack_state_invalid');
  return Object.freeze({
    schemaVersion: 1,
    identity: Object.freeze(identity),
    directoryKey,
    pluginVersion: assertBoundedId(raw.pluginVersion),
    artifactBinding: parseVoiceModelPackArtifactBindingV1(raw.artifactBinding),
    packVersion: assertBoundedId(raw.packVersion),
    manifestDigest: assertDigest(raw.manifestDigest),
    verifiedAtMs: assertNonNegativeSafeInteger(raw.verifiedAtMs),
  });
}

function parseAcceptedLicense(value: unknown): AcceptedLicenseRecordV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.executionHost !== 'daemon') return null;
  try {
    assertExactKeys(raw, [
      'accountId',
      'executionHost',
      'hostId',
      'pluginId',
      'packId',
      'packVersion',
      'licenseId',
      'licenseSourceUrl',
      'licenseTextDigest',
      'artifactBinding',
      'acceptedAtMs',
    ]);
    return Object.freeze({
      accountId: assertBoundedId(raw.accountId),
      executionHost: 'daemon',
      hostId: assertBoundedId(raw.hostId),
      pluginId: VoiceModelPackIdentityV1Schema.shape.pluginId.parse(raw.pluginId),
      packId: VoiceModelPackIdentityV1Schema.shape.packId.parse(raw.packId),
      packVersion: assertBoundedId(raw.packVersion),
      licenseId: assertBoundedId(raw.licenseId),
      licenseSourceUrl: assertHttpsUrl(raw.licenseSourceUrl),
      licenseTextDigest: assertDigest(raw.licenseTextDigest),
      artifactBinding: parseVoiceModelPackArtifactBindingV1(raw.artifactBinding),
      acceptedAtMs: assertNonNegativeSafeInteger(raw.acceptedAtMs),
    });
  } catch {
    return null;
  }
}

async function readBoundedJson(path: string): Promise<unknown | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.size > STATE_MAX_ENCODED_BYTES) throw new Error('voice_model_pack_state_invalid');
    const bytes = Buffer.alloc(STATE_MAX_ENCODED_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > STATE_MAX_ENCODED_BYTES) throw new Error('voice_model_pack_state_invalid');
    try {
      return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as unknown;
    } catch {
      throw new Error('voice_model_pack_state_invalid');
    }
  } finally {
    await handle.close();
  }
}

function parseState(params: Readonly<{
  raw: unknown;
  accountId: string;
  machineId: string;
}>): DaemonPublicVoiceModelPackStateV1 {
  if (!params.raw || typeof params.raw !== 'object' || Array.isArray(params.raw)) {
    throw new Error('voice_model_pack_state_invalid');
  }
  const raw = params.raw as Record<string, unknown>;
  assertOnlyKnownKeys(raw, [
    'schemaVersion',
    'accountId',
    'machineId',
    'installed',
    'licenseAcceptances',
    'unboundInstalled',
    'unboundLicenseAcceptances',
  ]);
  if (raw.schemaVersion !== 1) throw new Error('voice_model_pack_state_invalid');
  if (raw.accountId !== params.accountId || raw.machineId !== params.machineId) {
    throw new Error('voice_model_pack_state_scope_mismatch');
  }
  if (!Array.isArray(raw.installed) || !Array.isArray(raw.licenseAcceptances)) {
    throw new Error('voice_model_pack_state_invalid');
  }
  if (raw.installed.length > STATE_MAX_RECORDS || raw.licenseAcceptances.length > STATE_MAX_RECORDS) {
    throw new Error('voice_model_pack_state_invalid');
  }
  const installed: InstalledVoiceModelPackMetadataV1[] = [];
  const unboundInstalled: UnboundInstalledRecordV1[] = [];
  for (const candidate of raw.installed) {
    try {
      installed.push(parseInstalledVoiceModelPackMetadataV1(candidate));
    } catch {
      const cleanupOnly = parseLegacyCleanupOnlyInstalled(candidate);
      if (!cleanupOnly) throw new Error('voice_model_pack_state_invalid');
      unboundInstalled.push(cleanupOnly);
    }
  }
  if (raw.unboundInstalled !== undefined) {
    if (!Array.isArray(raw.unboundInstalled) || raw.unboundInstalled.length > STATE_MAX_RECORDS) {
      throw new Error('voice_model_pack_state_invalid');
    }
    for (const candidate of raw.unboundInstalled) {
      const cleanupOnly = parseCleanupOnlyInstalled(candidate);
      if (!cleanupOnly) throw new Error('voice_model_pack_state_invalid');
      unboundInstalled.push(cleanupOnly);
    }
  }
  const installedIdentities = new Set<string>();
  for (const record of [...installed, ...unboundInstalled]) {
    const key = JSON.stringify([record.identity.pluginId, record.identity.packId]);
    if (installedIdentities.has(key)) throw new Error('voice_model_pack_state_duplicate_identity');
    installedIdentities.add(key);
  }
  const accepted: AcceptedLicenseRecordV1[] = [];
  const unbound: unknown[] = Array.isArray(raw.unboundLicenseAcceptances)
    ? raw.unboundLicenseAcceptances.slice(0, STATE_MAX_RECORDS)
    : [];
  for (const candidate of raw.licenseAcceptances) {
    const parsed = parseAcceptedLicense(candidate);
    if (parsed && parsed.accountId === params.accountId && parsed.hostId === params.machineId) accepted.push(parsed);
    else if (unbound.length < STATE_MAX_RECORDS) unbound.push(structuredClone(candidate));
  }
  return Object.freeze({
    schemaVersion: 1,
    accountId: params.accountId,
    machineId: params.machineId,
    installed: Object.freeze(installed),
    licenseAcceptances: Object.freeze(accepted),
    unboundInstalled: Object.freeze(unboundInstalled),
    unboundLicenseAcceptances: Object.freeze(unbound),
  });
}

function emptyState(accountId: string, machineId: string): DaemonPublicVoiceModelPackStateV1 {
  return Object.freeze({
    schemaVersion: 1,
    accountId,
    machineId,
    installed: Object.freeze([]),
    licenseAcceptances: Object.freeze([]),
    unboundInstalled: Object.freeze([]),
    unboundLicenseAcceptances: Object.freeze([]),
  });
}

async function ensurePrivateParent(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('voice_model_pack_state_parent_invalid');
  if (process.platform !== 'win32') await chmod(parent, 0o700);
}

export function createDaemonPublicVoiceModelPackStateStore(params: Readonly<{
  stateFilePath: string;
  accountId: string;
  machineId: string;
}>): Readonly<{
  read(): Promise<DaemonPublicVoiceModelPackStateV1>;
  recordInstalled(metadata: InstalledVoiceModelPackMetadataV1): Promise<void>;
  removeInstalled(identity: VoiceModelPackIdentityV1): Promise<boolean>;
  acceptLicense(input: Readonly<{
    identity: VoiceModelPackIdentityV1;
    packVersion: string;
    licenseId: string;
    licenseSourceUrl: string;
    licenseTextDigest: string;
    artifactBinding: VoiceModelPackArtifactBindingV1;
    acceptedAtMs: number;
  }>): Promise<void>;
  findAcceptedLicense(input: Readonly<{
    identity: VoiceModelPackIdentityV1;
    packVersion: string;
    licenseId: string;
    licenseSourceUrl: string;
    licenseTextDigest: string;
    artifactBinding: VoiceModelPackArtifactBindingV1;
  }>): Promise<AcceptedLicenseRecordV1 | undefined>;
}> {
  const accountId = assertBoundedId(params.accountId);
  const machineId = assertBoundedId(params.machineId);
  let memory: DaemonPublicVoiceModelPackStateV1 | undefined;
  let tail: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function loadUnlocked(): Promise<DaemonPublicVoiceModelPackStateV1> {
    if (memory) return memory;
    const raw = await readBoundedJson(params.stateFilePath);
    memory = raw === null ? emptyState(accountId, machineId) : parseState({ raw, accountId, machineId });
    return memory;
  }

  async function commitUnlocked(next: DaemonPublicVoiceModelPackStateV1): Promise<void> {
    await ensurePrivateParent(params.stateFilePath);
    await writeJsonAtomic(params.stateFilePath, next);
    memory = next;
  }

  const licenseKey = (record: Readonly<{
    pluginId: string;
    packId: string;
    packVersion: string;
    licenseId: string;
    licenseSourceUrl: string;
    licenseTextDigest: string;
    artifactBinding: VoiceModelPackArtifactBindingV1;
  }>) => JSON.stringify([
    record.pluginId,
    record.packId,
    record.packVersion,
    record.licenseId,
    record.licenseSourceUrl,
    normalizeVoiceModelPackSha256DigestV1(record.licenseTextDigest),
    parseVoiceModelPackArtifactBindingV1(record.artifactBinding),
  ]);

  return {
    read: () => enqueue(async () => structuredClone(await loadUnlocked())),
    recordInstalled: (metadata) => enqueue(async () => {
      const parsed = parseInstalledVoiceModelPackMetadataV1(metadata);
      const current = await loadUnlocked();
      const installed = current.installed.filter((candidate) => (
        candidate.identity.pluginId !== parsed.identity.pluginId
        || candidate.identity.packId !== parsed.identity.packId
      ));
      installed.push(parsed);
      if (installed.length > STATE_MAX_RECORDS) throw new Error('voice_model_pack_state_record_limit_exceeded');
      const unboundInstalled = current.unboundInstalled.filter((candidate) => (
        candidate.identity.pluginId !== parsed.identity.pluginId
        || candidate.identity.packId !== parsed.identity.packId
      ));
      await commitUnlocked(Object.freeze({
        ...current,
        installed: Object.freeze(installed),
        unboundInstalled: Object.freeze(unboundInstalled),
      }));
    }),
    removeInstalled: (input) => enqueue(async () => {
      const identity = VoiceModelPackIdentityV1Schema.parse(input);
      const current = await loadUnlocked();
      const installed = current.installed.filter((candidate) => (
        candidate.identity.pluginId !== identity.pluginId
        || candidate.identity.packId !== identity.packId
      ));
      const unboundInstalled = current.unboundInstalled.filter((candidate) => (
        candidate.identity.pluginId !== identity.pluginId
        || candidate.identity.packId !== identity.packId
      ));
      if (
        installed.length === current.installed.length
        && unboundInstalled.length === current.unboundInstalled.length
      ) return false;
      await commitUnlocked(Object.freeze({
        ...current,
        installed: Object.freeze(installed),
        unboundInstalled: Object.freeze(unboundInstalled),
      }));
      return true;
    }),
    acceptLicense: (input) => enqueue(async () => {
      const identity = VoiceModelPackIdentityV1Schema.parse(input.identity);
      const record: AcceptedLicenseRecordV1 = Object.freeze({
        accountId,
        executionHost: 'daemon',
        hostId: machineId,
        pluginId: identity.pluginId,
        packId: identity.packId,
        packVersion: assertBoundedId(input.packVersion),
        licenseId: assertBoundedId(input.licenseId),
        licenseSourceUrl: assertHttpsUrl(input.licenseSourceUrl),
        licenseTextDigest: assertDigest(input.licenseTextDigest),
        artifactBinding: parseVoiceModelPackArtifactBindingV1(input.artifactBinding),
        acceptedAtMs: assertNonNegativeSafeInteger(input.acceptedAtMs),
      });
      const current = await loadUnlocked();
      const key = licenseKey(record);
      const accepted = current.licenseAcceptances.filter((candidate) => licenseKey(candidate) !== key);
      accepted.push(record);
      if (accepted.length > STATE_MAX_RECORDS) throw new Error('voice_model_pack_state_record_limit_exceeded');
      await commitUnlocked(Object.freeze({ ...current, licenseAcceptances: Object.freeze(accepted) }));
    }),
    findAcceptedLicense: (input) => enqueue(async () => {
      const identity = VoiceModelPackIdentityV1Schema.parse(input.identity);
      const key = licenseKey({
        pluginId: identity.pluginId,
        packId: identity.packId,
        packVersion: assertBoundedId(input.packVersion),
        licenseId: assertBoundedId(input.licenseId),
        licenseSourceUrl: assertHttpsUrl(input.licenseSourceUrl),
        licenseTextDigest: assertDigest(input.licenseTextDigest),
        artifactBinding: parseVoiceModelPackArtifactBindingV1(input.artifactBinding),
      });
      const current = await loadUnlocked();
      return structuredClone(current.licenseAcceptances.find((candidate) => licenseKey(candidate) === key));
    }),
  };
}
