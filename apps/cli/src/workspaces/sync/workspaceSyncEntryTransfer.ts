import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { WorkspaceSyncEntryExpectationV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceManifestEntrySchema } from '@happier-dev/protocol/workspaces/manifestSchema';
import type { WorkspaceManifestEntry, WorkspaceSyncEntryExpectationV1 } from '@happier-dev/protocol';
import type { DirectPeerOnDemandTransferScope } from '@/machines/transfer/directPeerTransport';
import {
  createBufferTransferPayloadSource,
  createFileTransferPayloadSource,
  type TransferPayloadSource,
} from '@/machines/transfer/transferPayloadSource';
import { observeWorkspaceSyncEntryAtRoot } from './workspaceSyncFileRead';

type WorkspaceSyncEntryTransferEnvelopeV1 = Readonly<{
  v: 1;
  expectation: WorkspaceSyncEntryExpectationV1;
  entries: readonly WorkspaceManifestEntry[];
  blobTransferIds: Readonly<Record<string, string>>;
}>;

function changed(message: string): Error {
  return Object.assign(new Error(message), { code: 'conflict_changed' });
}

async function assertMaterialMatchesExpectation(
  materialPath: string,
  expectation: WorkspaceSyncEntryExpectationV1,
): Promise<void> {
  const observed = await observeWorkspaceSyncEntryAtRoot({
    rootPath: dirname(materialPath),
    relativePath: basename(materialPath),
  });
  if (JSON.stringify(observed) !== JSON.stringify(expectation)) {
    throw changed('Captured workspace entry no longer matches the approved observation');
  }
}

function blobTransferId(operationId: string, digest: string): string {
  return `${operationId}:entry-blob:${createHash('sha256').update(digest).digest('hex')}`;
}

async function hashFile(path: string): Promise<Readonly<{ digest: string; sizeBytes: number; executable: boolean }>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw Object.assign(new Error('Captured resolution material changed'), { code: 'conflict_changed' });
    const hash = createHash('sha1');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode || offset !== after.size) {
      throw Object.assign(new Error('Captured resolution material changed during transfer preparation'), { code: 'conflict_changed' });
    }
    return { digest: hash.digest('hex'), sizeBytes: offset, executable: (after.mode & 0o111) !== 0 };
  } finally {
    await handle.close();
  }
}

async function scanCapturedMaterial(root: string): Promise<Readonly<{
  entries: readonly WorkspaceManifestEntry[];
  blobPathByDigest: ReadonlyMap<string, string>;
}>> {
  const entries: WorkspaceManifestEntry[] = [];
  const blobPathByDigest = new Map<string, string>();
  const visit = async (absolutePath: string, relativePath: string): Promise<void> => {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      entries.push({ relativePath, kind: 'symlink', target: await readlink(absolutePath) });
      return;
    }
    if (stats.isFile()) {
      const observed = await hashFile(absolutePath);
      entries.push({ relativePath, kind: 'file', ...observed });
      blobPathByDigest.set(observed.digest, absolutePath);
      return;
    }
    if (!stats.isDirectory()) throw Object.assign(new Error('Captured resolution material is unsupported'), { code: 'conflict_resolution_unsupported' });
    entries.push({ relativePath, kind: 'directory' });
    const names = (await readdir(absolutePath)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    for (const name of names) await visit(resolve(absolutePath, name), `${relativePath}/${name}`);
  };
  await visit(root, 'entry');
  return { entries, blobPathByDigest };
}

export async function createWorkspaceSyncEntryExport(input: Readonly<{
  operationId: string;
  expectation: WorkspaceSyncEntryExpectationV1;
  materialPath: string | null;
}>): Promise<Readonly<{ payloadSource: TransferPayloadSource; onDemandScope: DirectPeerOnDemandTransferScope }>> {
  const expectation = WorkspaceSyncEntryExpectationV1Schema.parse(input.expectation);
  if ((expectation.kind === 'missing') !== (input.materialPath === null)) {
    throw changed('Captured resolution material does not match its observation');
  }
  if (input.materialPath !== null) await assertMaterialMatchesExpectation(input.materialPath, expectation);
  const scanned = input.materialPath === null
    ? { entries: [] as readonly WorkspaceManifestEntry[], blobPathByDigest: new Map<string, string>() }
    : await scanCapturedMaterial(input.materialPath);
  if (input.materialPath !== null) await assertMaterialMatchesExpectation(input.materialPath, expectation);
  const blobTransferIds = Object.fromEntries([...scanned.blobPathByDigest].map(([digest]) => [digest, blobTransferId(input.operationId, digest)]));
  const digestByTransferId = new Map(Object.entries(blobTransferIds).map(([digest, transferId]) => [transferId, digest]));
  const envelope: WorkspaceSyncEntryTransferEnvelopeV1 = { v: 1, expectation, entries: scanned.entries, blobTransferIds };
  return {
    payloadSource: createBufferTransferPayloadSource(Buffer.from(JSON.stringify(envelope), 'utf8')),
    onDemandScope: {
      allowTransferId: (transferId) => digestByTransferId.has(transferId),
      maxResolvedTransfers: digestByTransferId.size,
      resolvePayloadSourceOnOpen: async ({ transferId }) => {
        const digest = digestByTransferId.get(transferId);
        const filePath = digest ? scanned.blobPathByDigest.get(digest) : null;
        if (!digest || !filePath) throw new Error('Workspace sync entry blob is not authorized');
        return createFileTransferPayloadSource({ filePath });
      },
    },
  };
}

function parseEnvelope(raw: Buffer, operationId: string, expectation: WorkspaceSyncEntryExpectationV1): WorkspaceSyncEntryTransferEnvelopeV1 {
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')) as unknown; } catch { throw new Error('Workspace sync entry transfer manifest is malformed'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workspace sync entry transfer manifest is malformed');
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || JSON.stringify(record.expectation) !== JSON.stringify(expectation)
    || !Array.isArray(record.entries) || !record.blobTransferIds || typeof record.blobTransferIds !== 'object' || Array.isArray(record.blobTransferIds)) {
    throw Object.assign(new Error('Workspace sync entry transfer commitment changed'), { code: 'conflict_changed' });
  }
  const entries = record.entries.map((entry) => WorkspaceManifestEntrySchema.parse(entry));
  const byPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  if (byPath.size !== entries.length
    || (expectation.kind === 'missing' ? entries.length !== 0 : byPath.get('entry')?.kind !== expectation.kind)) {
    throw changed('Workspace sync entry transfer tree changed');
  }
  for (const entry of entries) {
    const segments = entry.relativePath.split('/');
    if (segments[0] !== 'entry' || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
      throw changed('Workspace sync entry transfer path changed');
    }
    if (entry.relativePath !== 'entry') {
      const parent = segments.slice(0, -1).join('/');
      if (byPath.get(parent)?.kind !== 'directory') {
        throw changed('Workspace sync entry transfer parent changed');
      }
    }
  }
  const ids = record.blobTransferIds as Record<string, unknown>;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !('relativePath' in entry) || typeof entry.relativePath !== 'string'
      || (entry.relativePath !== 'entry' && !entry.relativePath.startsWith('entry/'))) throw new Error('Workspace sync entry transfer path is malformed');
    if (entry.kind === 'file' && ids[entry.digest] !== blobTransferId(operationId, entry.digest)) {
      throw new Error('Workspace sync entry transfer blob index is malformed');
    }
  }
  return { v: 1, expectation, entries, blobTransferIds: ids as Record<string, string> };
}

export async function stageWorkspaceSyncEntryExport(input: Readonly<{
  operationId: string;
  stagingDirectory: string;
  expectation: WorkspaceSyncEntryExpectationV1;
  requestPayload(request: Readonly<{ transferId: string; destinationPath: string; expectedSizeBytes?: number; expectedManifestHash?: string }>): Promise<void>;
}>): Promise<string | null> {
  await mkdir(input.stagingDirectory, { recursive: true });
  const envelopePath = join(input.stagingDirectory, 'manifest.json');
  await input.requestPayload({ transferId: input.operationId, destinationPath: envelopePath });
  const envelope = parseEnvelope(await readFile(envelopePath), input.operationId, input.expectation);
  if (input.expectation.kind === 'missing') return null;
  const entryPath = join(input.stagingDirectory, 'entry');
  const blobs = new Map<string, string>();
  for (const entry of envelope.entries) {
    if (entry.kind !== 'file' || blobs.has(entry.digest)) continue;
    const blobPath = join(input.stagingDirectory, `blob-${createHash('sha256').update(entry.digest).digest('hex')}`);
    // Direct-peer commitments require size and transport hash together. The
    // reviewed SHA-1/size/tree commitment is verified after reconstruction.
    await input.requestPayload({ transferId: envelope.blobTransferIds[entry.digest]!, destinationPath: blobPath });
    blobs.set(entry.digest, blobPath);
  }
  for (const entry of envelope.entries) {
    const destination = join(input.stagingDirectory, entry.relativePath);
    const rest = relative(input.stagingDirectory, destination);
    if (!rest || rest === '..' || rest.startsWith('../')) throw new Error('Workspace sync entry transfer path escaped staging');
    if (entry.kind === 'directory') await mkdir(destination, { recursive: true });
  }
  for (const entry of envelope.entries) {
    const destination = join(input.stagingDirectory, entry.relativePath);
    if (entry.kind === 'directory') continue;
    await mkdir(resolve(destination, '..'), { recursive: true });
    if (entry.kind === 'symlink') await symlink(entry.target, destination);
    else {
      const source = blobs.get(entry.digest);
      if (!source) throw new Error('Workspace sync entry transfer blob is missing');
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      await chmod(destination, entry.executable ? 0o755 : 0o644);
    }
  }
  await assertMaterialMatchesExpectation(entryPath, input.expectation);
  return entryPath;
}

export async function disposeWorkspaceSyncEntryStaging(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
