import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TransferPayloadSource } from '../../machines/transfer/transferPayloadSource';
import {
  createFileTransferPayloadSource,
  resolveTransferPayloadManifestHash,
} from '../../machines/transfer/transferPayloadSource';
import type { SessionHandoffFileSlice, SessionHandoffProviderBundle } from './types';
import { SessionHandoffProviderBundleSchema } from './sessionHandoffProviderBundleSchema';

const SESSION_HANDOFF_PROVIDER_BUNDLE_DIRECTORY = join(tmpdir(), 'happier-session-handoff-provider-bundles');
const ARTIFACT_MAGIC = Buffer.from('HAPPIER_SESSION_HANDOFF_BUNDLE_V2\n', 'utf8');
const ARTIFACT_LENGTH_BYTES = 8;
// Only the structured manifest is memory-resident. Referenced file contents are streamed.
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const SOURCE_FILE_KIND = 'happier.handoff.file.v1';
const ARTIFACT_ENTRY_KIND = 'happier.handoff.entry.v1';

type ArtifactEntry = Readonly<{ source: SessionHandoffFileSlice }>;
type ArtifactManifest = Readonly<{
  t: 'session_handoff_bundle_artifact_v1';
  bundle: unknown;
  entries: readonly Readonly<{ sizeBytes: number }>[];
}>;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readSourceFile(value: unknown): SessionHandoffFileSlice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.t !== SOURCE_FILE_KIND) return null;
  if (
    Object.keys(record).some((key) => !['t', 'filePath', 'offsetBytes', 'sizeBytes'].includes(key))
    || typeof record.filePath !== 'string'
    || record.filePath.length === 0
    || !isNonNegativeInteger(record.offsetBytes)
    || !isNonNegativeInteger(record.sizeBytes)
  ) {
    throw new Error('Invalid session handoff file reference');
  }
  return {
    t: SOURCE_FILE_KIND,
    filePath: record.filePath,
    offsetBytes: record.offsetBytes,
    sizeBytes: record.sizeBytes,
  };
}

async function projectBundleFiles(value: unknown): Promise<Readonly<{
  bundle: unknown;
  entries: readonly ArtifactEntry[];
}>> {
  const entries: ArtifactEntry[] = [];
  const active = new WeakSet<object>();
  const visit = async (current: unknown, inArray: boolean): Promise<unknown> => {
    const source = readSourceFile(current);
    if (source) {
      const sourceStats = await stat(source.filePath);
      if (source.offsetBytes + source.sizeBytes > sourceStats.size) {
        throw new Error('Invalid session handoff file reference');
      }
      const entry = entries.length;
      entries.push({ source });
      return { t: ARTIFACT_ENTRY_KIND, entry, sizeBytes: source.sizeBytes };
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') return Number.isFinite(current) ? current : null;
    if (current === undefined || typeof current === 'function' || typeof current === 'symbol') {
      return inArray ? null : undefined;
    }
    if (typeof current !== 'object' || active.has(current)) {
      throw new Error('Invalid session handoff transfer payload');
    }
    active.add(current);
    try {
      if (Array.isArray(current)) return await Promise.all(current.map((item) => visit(item, true)));
      const projected: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) {
        const next = await visit(item, false);
        if (next !== undefined) projected[key] = next;
      }
      return projected;
    } finally {
      active.delete(current);
    }
  };
  return { bundle: await visit(value, false), entries };
}

async function appendFile(
  target: Awaited<ReturnType<typeof open>>,
  source: SessionHandoffFileSlice,
  onBytesWritten?: (bytesWritten: number) => void,
): Promise<void> {
  const input = await open(source.filePath, 'r');
  try {
    let remaining = source.sizeBytes;
    let position = source.offsetBytes;
    const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(1, remaining)));
    while (remaining > 0) {
      const requested = Math.min(buffer.length, remaining);
      const { bytesRead } = await input.read(buffer, 0, requested, position);
      if (bytesRead === 0) throw new Error('Session handoff source file changed during export');
      await target.write(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
      onBytesWritten?.(bytesRead);
    }
  } finally {
    await input.close();
  }
}

function assertCanonicalSessionHandoffProviderBundle(providerBundle: SessionHandoffProviderBundle): void {
  if (
    providerBundle.providerId === 'codex'
    && 'codexBackendMode' in (providerBundle as SessionHandoffProviderBundle & { codexBackendMode?: unknown })
    && (providerBundle as SessionHandoffProviderBundle & { codexBackendMode?: unknown }).codexBackendMode !== undefined
  ) {
    throw new Error('Invalid session handoff transfer payload');
  }
}

export async function writeSessionHandoffProviderBundleArtifact(params: Readonly<{
  providerBundle: SessionHandoffProviderBundle;
  filePath: string;
  onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
}>): Promise<Readonly<{ sizeBytes: number; manifestHash: string }>> {
  const normalized = SessionHandoffProviderBundleSchema.parse(params.providerBundle);
  assertCanonicalSessionHandoffProviderBundle(normalized);
  const projected = await projectBundleFiles(normalized);
  const manifest: ArtifactManifest = {
    t: 'session_handoff_bundle_artifact_v1',
    bundle: projected.bundle,
    entries: projected.entries.map((entry) => ({ sizeBytes: entry.source.sizeBytes })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw new Error('Session handoff provider manifest is too large');
  }

  const temporaryPath = `${params.filePath}.${randomUUID()}.tmp`;
  const target = await open(temporaryPath, 'wx', 0o600);
  let published = false;
  const totalBytes = projected.entries.reduce((sum, entry) => sum + entry.source.sizeBytes, 0);
  let currentBytes = 0;
  let lastReportedBytes = 0;
  const reportProgress = (force = false) => {
    if (!params.onProgress) return;
    if (!force && currentBytes - lastReportedBytes < 16 * 1024 * 1024) return;
    lastReportedBytes = currentBytes;
    params.onProgress({ currentBytes, totalBytes });
  };
  try {
    reportProgress(true);
    const manifestLength = Buffer.alloc(ARTIFACT_LENGTH_BYTES);
    manifestLength.writeBigUInt64BE(BigInt(manifestBytes.length));
    await target.write(ARTIFACT_MAGIC);
    await target.write(manifestLength);
    await target.write(manifestBytes);
    for (const entry of projected.entries) {
      await appendFile(target, entry.source, (bytesWritten) => {
        currentBytes += bytesWritten;
        reportProgress();
      });
    }
    reportProgress(true);
    await target.close();
    await rename(temporaryPath, params.filePath);
    published = true;
  } finally {
    await target.close().catch(() => undefined);
    if (!published) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  const sizeBytes = (await stat(params.filePath)).size;
  const manifestHash = await resolveTransferPayloadManifestHash({ kind: 'file', filePath: params.filePath, sizeBytes });
  return { sizeBytes, manifestHash };
}

export async function createSessionHandoffProviderBundlePayloadSource(
  providerBundle: SessionHandoffProviderBundle,
  onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void,
): Promise<TransferPayloadSource> {
  await mkdir(SESSION_HANDOFF_PROVIDER_BUNDLE_DIRECTORY, { recursive: true });
  const filePath = join(SESSION_HANDOFF_PROVIDER_BUNDLE_DIRECTORY, `provider-bundle-${randomUUID()}.bin`);
  const artifact = await writeSessionHandoffProviderBundleArtifact({
    providerBundle,
    filePath,
    ...(onProgress ? { onProgress } : {}),
  });
  return createFileTransferPayloadSource({
    filePath,
    ...artifact,
    dispose: async () => {
      await rm(filePath, { force: true }).catch(() => undefined);
    },
  });
}

async function readExactly(file: Awaited<ReturnType<typeof open>>, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await file.read(buffer, total, length - total, position + total);
    if (bytesRead === 0) throw new Error('Invalid session handoff transfer payload');
    total += bytesRead;
  }
  return buffer;
}

function materializeBundleFiles(params: Readonly<{
  value: unknown;
  filePath: string;
  slices: readonly Readonly<{ offsetBytes: number; sizeBytes: number }>[];
}>): unknown {
  const visit = (current: unknown): unknown => {
    if (!current || typeof current !== 'object') return current;
    if (Array.isArray(current)) return current.map(visit);
    const record = current as Record<string, unknown>;
    if (record.t === ARTIFACT_ENTRY_KIND) {
      if (
        Object.keys(record).some((key) => !['t', 'entry', 'sizeBytes'].includes(key))
        || !isNonNegativeInteger(record.entry)
        || !isNonNegativeInteger(record.sizeBytes)
      ) {
        throw new Error('Invalid session handoff transfer payload');
      }
      const slice = params.slices[record.entry];
      if (!slice || slice.sizeBytes !== record.sizeBytes) {
        throw new Error('Invalid session handoff transfer payload');
      }
      return { t: SOURCE_FILE_KIND, filePath: params.filePath, ...slice };
    }
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, visit(value)]));
  };
  return visit(params.value);
}

export async function readSessionHandoffProviderBundleFile(
  providerBundleFilePath: string,
): Promise<SessionHandoffProviderBundle> {
  const file = await open(providerBundleFilePath, 'r');
  try {
    const prefix = await readExactly(file, ARTIFACT_MAGIC.length, 0).catch(() => null);
    if (!prefix?.equals(ARTIFACT_MAGIC)) {
      let payload: unknown;
      try {
        payload = JSON.parse(await readFile(providerBundleFilePath, 'utf8')) as unknown;
      } catch {
        throw new Error('Invalid session handoff transfer payload');
      }
      try {
        const providerBundle = SessionHandoffProviderBundleSchema.parse(payload);
        assertCanonicalSessionHandoffProviderBundle(providerBundle);
        return providerBundle;
      } catch {
        throw new Error('Invalid session handoff transfer payload');
      }
    }

    const lengthBytes = await readExactly(file, ARTIFACT_LENGTH_BYTES, ARTIFACT_MAGIC.length);
    const manifestLengthBig = lengthBytes.readBigUInt64BE();
    if (manifestLengthBig > BigInt(MAX_MANIFEST_BYTES)) {
      throw new Error('Invalid session handoff transfer payload');
    }
    const manifestLength = Number(manifestLengthBig);
    const manifestOffset = ARTIFACT_MAGIC.length + ARTIFACT_LENGTH_BYTES;
    let manifest: ArtifactManifest;
    try {
      const value = JSON.parse((await readExactly(file, manifestLength, manifestOffset)).toString('utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const record = value as Record<string, unknown>;
      if (record.t !== 'session_handoff_bundle_artifact_v1' || !Array.isArray(record.entries)) throw new Error();
      const entries = record.entries.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error();
        const sizeBytes = (entry as Record<string, unknown>).sizeBytes;
        if (!isNonNegativeInteger(sizeBytes)) throw new Error();
        return { sizeBytes };
      });
      manifest = { t: 'session_handoff_bundle_artifact_v1', bundle: record.bundle, entries };
    } catch {
      throw new Error('Invalid session handoff transfer payload');
    }

    const payloadOffset = manifestOffset + manifestLength;
    const slices: Array<{ offsetBytes: number; sizeBytes: number }> = [];
    let offsetBytes = payloadOffset;
    for (const entry of manifest.entries) {
      slices.push({ offsetBytes, sizeBytes: entry.sizeBytes });
      offsetBytes += entry.sizeBytes;
    }
    if ((await file.stat()).size !== offsetBytes) throw new Error('Invalid session handoff transfer payload');
    const providerBundle = SessionHandoffProviderBundleSchema.parse(materializeBundleFiles({
      value: manifest.bundle,
      filePath: providerBundleFilePath,
      slices,
    }));
    assertCanonicalSessionHandoffProviderBundle(providerBundle);
    return providerBundle;
  } finally {
    await file.close();
  }
}

export async function copySessionHandoffFileSlice(params: Readonly<{
  source: SessionHandoffFileSlice;
  targetFilePath: string;
}>): Promise<void> {
  const source = await open(params.source.filePath, 'r');
  const target = await open(params.targetFilePath, 'w', 0o600);
  try {
    let remaining = params.source.sizeBytes;
    let position = params.source.offsetBytes;
    const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(1, remaining)));
    while (remaining > 0) {
      const requested = Math.min(buffer.length, remaining);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (bytesRead === 0) throw new Error('Invalid session handoff transfer payload');
      await target.write(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
  } finally {
    await Promise.all([source.close(), target.close()]);
  }
}
