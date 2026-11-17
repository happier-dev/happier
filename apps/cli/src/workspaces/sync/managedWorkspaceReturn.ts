import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { configuration } from '@/configuration';
import { readStoredScmComparison, writeStoredScmComparison, resolveStoredScmComparisonPath, resolveStoredScmComparisonEndpointsPath, type StoredScmComparison } from '@/scm/comparisons/comparisonStorage';
import type { ScmComparisonFile, WorkspaceManifest, WorkspaceManifestEntry } from '@happier-dev/protocol';
import { buildScmComparisonIdentity, classifyScmChangePath } from '@happier-dev/protocol/scm/comparison';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { projectActionFailureCauseV1, readActionErrorCodeV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveSessionTargetWorkspaceTransfer } from '@/daemon/sessions/sessionTargetWorkspaces';
import type { ScmBackendRegistry } from '@/scm/registry';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import { materializeWorkspaceExportArtifactsWithScmWorkspace } from '@/scm/workspace/workspaceExportMaterialization';
import { resolveWorkspaceReplicationSourceInputsWithScmWorkspace } from '@/scm/workspace/workspaceTransferResolution';
import { readWorkspaceTransferUnsupportedPath } from '@/scm/workspace/workspaceTransferErrors';
import { isAdministrativeWorkspacePathWithScmWorkspace } from '@/scm/workspace/workspacePortability';
import { scanWorkspaceManifest } from '@/scm/workspace/workspaceExportPackaging/scanWorkspaceManifest';
import { compareWorkspaceManifests } from '@/scm/workspace/workspaceExportPackaging/compareWorkspaceManifests';
import { writeTransferPayloadSourceToFile } from '@/machines/transfer/transferPayloadFileSink';
import { localWorkspaceSource } from '@/workspaces/source/localWorkspaceSource';
import { runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { createWorkspaceSyncSeedExport, materializeWorkspaceSyncSeedExport } from './workspaceSyncSeedTransfer';
import { captureWorkspaceSyncEntryAtRoot, applyCapturedWorkspaceSyncEntryAtRoot } from './workspaceSyncConflicts';
import { observeWorkspaceSyncEntryAtRoot } from './workspaceSyncFileRead';

export type ManagedWorkspaceReturnPreview = Readonly<{
  returnId: string;
  sessionId: string;
  repositoryRootPath: string;
  paths: readonly Readonly<{ path: string; files: readonly ScmComparisonFile[];
    conflicts: readonly ManagedWorkspaceReturnConflict[] }>[];
  applyUnavailableReason?: 'baseline_unavailable';
}>;

export type ManagedWorkspaceReturnConflict = Readonly<{ path: string; code: 'both_changed' }>;
export type ManagedWorkspaceReturnApplyResult = Readonly<{
  appliedPaths: readonly string[];
  conflicts: readonly ManagedWorkspaceReturnConflict[];
}>;

export type ManagedWorkspaceReturnErrorDetails = Readonly<{
  appliedPaths: readonly string[];
  path?: string;
  recoveryPath?: string;
}>;

class ManagedWorkspaceReturnError extends Error {
  constructor(readonly code: string, message: string, readonly details: ManagedWorkspaceReturnErrorDetails, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export function readManagedWorkspaceReturnErrorDetails(error: unknown): ManagedWorkspaceReturnErrorDetails | undefined {
  if (error instanceof ManagedWorkspaceReturnError) return error.details;
  const path = readWorkspaceTransferUnsupportedPath(error);
  return path === undefined ? undefined : { appliedPaths: [], path };
}

/** The Action and native RPC adapters expose the return owner's same typed failure. */
export function projectManagedWorkspaceReturnFailure(error: unknown,
  phase: 'workspace.return.prepare' | 'workspace.return.apply'): ActionExecuteFailure {
  const errorCode = readRpcErrorCode(error) ?? readActionErrorCodeV1(error) ?? 'action_failed';
  return { ok: false, errorCode, error: errorCode, details: readManagedWorkspaceReturnErrorDetails(error),
    failureCause: projectActionFailureCauseV1(error, phase) };
}

type PreparedEntry = NonNullable<StoredScmComparison['workspaceReturn']>['entries'][number];

const withoutAdministrativeMetadata = (manifest: WorkspaceManifest, registry: ScmBackendRegistry): WorkspaceManifest => ({
  entries: manifest.entries.filter(entry => !isAdministrativeWorkspacePathWithScmWorkspace({ relativePath: entry.relativePath, registry })),
});

function ancestors(path: string): string[] {
  const segments = path.split('/');
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

function changes(before: WorkspaceManifest, after: WorkspaceManifest): Set<string> {
  const compared = compareWorkspaceManifests({ previousManifest: before, nextManifest: after });
  return new Set([...compared.added, ...compared.removed, ...compared.changed.map(change => change.next)].map(entry => entry.relativePath));
}

async function privateDirectory(activeServerDir: string): Promise<string> {
  const parent = join(activeServerDir, 'runtime', 'workspace-returns');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(join(parent, 'return-'));
}

async function snapshotRoot(root: string, destination: string, registry: ScmBackendRegistry, signal?: AbortSignal): Promise<void> {
  await mkdir(destination, { mode: 0o700 });
  for (const name of (await readdir(root)).sort()) {
    if (isAdministrativeWorkspacePathWithScmWorkspace({ relativePath: name, registry })) continue;
    signal?.throwIfAborted();
    const expected = await observeWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath: name });
    const captured = await captureWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath: name, expected,
      captureDirectory: destination, operationId: randomUUID() });
    if (captured.materialPath) await rename(captured.materialPath, join(destination, name));
  }
}

async function snapshotSelectedHostRoot(root: string, destination: string, paths: ReadonlySet<string>,
  registry: ScmBackendRegistry, signal?: AbortSignal) {
  await mkdir(destination, { mode: 0o700 });
  const topology = new Map<string, Readonly<{ kind: WorkspaceManifestEntry['kind'] }>>();
  for (const path of [...paths].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))) {
    if (isAdministrativeWorkspacePathWithScmWorkspace({ relativePath: path, registry })) continue;
    signal?.throwIfAborted();
    const stats = await localWorkspaceSource.lstat(join(root, path)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!stats) continue;
    if (stats.isDirectory()) {
      topology.set(path, { kind: 'directory' });
      await mkdir(join(destination, path), { recursive: true, mode: 0o700 });
      continue;
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) throw new ManagedWorkspaceReturnError('workspace_file_unsupported',
      'The selected host entry is not a regular file or symlink', { appliedPaths: [], path });
    topology.set(path, { kind: stats.isSymbolicLink() ? 'symlink' : 'file' });
    await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o700 });
    const expected = await observeWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath: path });
    if (expected.kind === 'directory') throw new ManagedWorkspaceReturnError('conflict_changed',
      'The host entry changed while capturing its review', { appliedPaths: [], path });
    const captured = await captureWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath: path, expected,
      captureDirectory: destination, operationId: randomUUID() });
    if (captured.materialPath) await rename(captured.materialPath, join(destination, path));
  }
  return topology;
}

function mode(entry: WorkspaceManifestEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.kind === 'file' ? entry.executable ? '100755' : '100644' : entry.kind === 'symlink' ? '120000' : '040000';
}

async function contents(root: string, entry: WorkspaceManifestEntry | undefined): Promise<Buffer> {
  if (!entry || entry.kind === 'directory') return Buffer.alloc(0);
  return entry.kind === 'symlink' ? Buffer.from(entry.target) : readFile(join(root, entry.relativePath));
}

function text(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}

function wholeFileHunk(before: string, after: string): string {
  const oldLines = before.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const newLines = after.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  if (!oldLines.length && !newLines.length) return '';
  const render = (lines: string[], prefix: string) => lines.map(line => `${prefix}${line}${line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'}`).join('');
  return `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n${render(oldLines, '-')}${render(newLines, '+')}`;
}

async function reviewFile(path: string, beforeRoot: string, afterRoot: string,
  before: WorkspaceManifestEntry | undefined, after: WorkspaceManifestEntry | undefined): Promise<ScmComparisonFile> {
  const [oldBytes, newBytes] = await Promise.all([contents(beforeRoot, before), contents(afterRoot, after)]);
  const oldText = text(oldBytes); const newText = text(newBytes);
  const binary = oldText === null || newText === null;
  let header = `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\n`;
  if (!before) header += `new file mode ${mode(after)}\n`;
  else if (!after) header += `deleted file mode ${mode(before)}\n`;
  else if (mode(before) !== mode(after)) header += `old mode ${mode(before)}\nnew mode ${mode(after)}\n`;
  const unifiedDiff = header + `--- ${before ? JSON.stringify(`a/${path}`) : '/dev/null'}\n+++ ${after ? JSON.stringify(`b/${path}`) : '/dev/null'}\n`
    + (binary ? `Binary files ${JSON.stringify(`a/${path}`)} and ${JSON.stringify(`b/${path}`)} differ\n` : wholeFileHunk(oldText!, newText!));
  return { path, changeKind: !before ? 'added' : !after ? 'deleted' : 'modified', binary,
    ...classifyScmChangePath(path), ...(before?.kind === 'file' ? { beforeBlobId: before.digest } : {}),
    ...(after?.kind === 'file' ? { afterBlobId: after.digest } : {}), evidence: { state: 'available', unifiedDiff }, occurrences: [] };
}

export type CapturedManagedWorkspaceReturnStage = Readonly<{
  stageRoot: string;
  hostRoot: string;
  baseline?: WorkspaceManifest;
  excludedPaths?: readonly string[];
  dispose(): Promise<void>;
}>;

/** The caller supplies its private finite handoff stage and retains its cleanup through consumption. */
export async function captureManagedWorkspaceReturnStage(input: Readonly<{
  sessionId: string; stageRoot: string; activeServerDir: string; registry?: ScmBackendRegistry; signal?: AbortSignal;
  /** Native custody owns the destination; the daemon passes finite bytes only. */
  materializeStage?(input: Readonly<{ operationId: string;
    exported: Awaited<ReturnType<typeof createWorkspaceSyncSeedExport>> }>): Promise<Readonly<{ dispose(): Promise<void> }>>;
}>): Promise<CapturedManagedWorkspaceReturnStage> {
  input.signal?.throwIfAborted();
  const placement = resolveSessionTargetWorkspaceTransfer(input.sessionId);
  if (!placement) throw new ManagedWorkspaceReturnError('workspace_source_operation_unavailable', 'The Session target is unavailable', { appliedPaths: [] });
  return runWithScmBackendRegistryLease(input.registry, async registry => {
    const operationId = randomUUID();
    let materialized: Readonly<{ dispose(): Promise<void> }> | undefined;
    try {
      const exported = await runWithWorkspaceSource(placement.source, () => createWorkspaceSyncSeedExport({ operationId,
        sourcePath: placement.workspace.targetRoot, activeServerDir: posix.join(placement.workspace.targetRoot, '.git', 'happier-exports'),
        workspaceTransfer: { includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [], contentOnly: true,
          ...(placement.baseline ? { exclusionCandidates: placement.baseline.entries.filter(entry => entry.kind !== 'directory')
            .map(entry => entry.relativePath) } : {}) }, registry }));
      if (input.materializeStage) materialized = await input.materializeStage({ operationId, exported });
      else await runWithWorkspaceSource(localWorkspaceSource, async () => {
        await mkdir(dirname(input.stageRoot), { recursive: true, mode: 0o700 });
        const custody = await materializeWorkspaceSyncSeedExport({ operationId, targetPath: input.stageRoot, signal: input.signal,
          requestPayload: async request => {
            const source = request.transferId === operationId ? exported.payloadSource
              : await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId: request.transferId, requestBody: {} });
            try { await writeTransferPayloadSourceToFile({ source, destinationPath: request.destinationPath }); }
            finally { await source.dispose?.(); }
          },
          materializeWorkspaceExportArtifacts: request => materializeWorkspaceExportArtifactsWithScmWorkspace({ ...request, registry }),
        });
        await custody.commit();
      });
      materialized ??= { dispose: () => rm(input.stageRoot, { recursive: true, force: true }) };
      return { stageRoot: input.stageRoot, hostRoot: placement.workspace.hostRoot,
        ...(placement.baseline ? { baseline: placement.baseline } : {}),
        ...(exported.excludedPaths ? { excludedPaths: exported.excludedPaths } : {}),
        dispose: materialized.dispose };
    } catch (error) {
      if (materialized) await materialized.dispose();
      else if (!input.materializeStage) await rm(input.stageRoot, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function prepareManagedWorkspaceReturn(input: Readonly<{
  sessionId: string; activeServerDir: string; registry?: ScmBackendRegistry; signal?: AbortSignal;
}>): Promise<ManagedWorkspaceReturnPreview> {
  return runWithScmBackendRegistryLease(input.registry, async registry => {
    const directory = await privateDirectory(input.activeServerDir);
    try {
      const captured = await captureManagedWorkspaceReturnStage({ ...input, registry, stageRoot: join(directory, 'stage') });
      try { return await prepareManagedWorkspaceReturnFromStage({ ...input, registry, hostRoot: captured.hostRoot,
        stageRoot: captured.stageRoot, ...(captured.baseline ? { baseline: captured.baseline } : {}),
        ...(captured.excludedPaths ? { excludedPaths: captured.excludedPaths } : {}) }); }
      finally { await captured.dispose(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

export async function applyManagedWorkspaceReturn(input: Readonly<{
  sessionId: string; returnId: string; paths: readonly string[]; signal?: AbortSignal;
  activeServerDir?: string; replaceConflictPaths?: readonly string[];
}>): Promise<ManagedWorkspaceReturnApplyResult> {
  input.signal?.throwIfAborted();
  let storagePath: string;
  let stored: StoredScmComparison;
  try {
    storagePath = resolveStoredScmComparisonPath({ activeServerDir: input.activeServerDir ?? configuration.activeServerDir,
      comparisonId: input.returnId, sessionId: input.sessionId });
    stored = await readStoredScmComparison(storagePath);
  } catch (cause) {
    throw new ManagedWorkspaceReturnError('invalid_request', 'The selected return is unavailable', { appliedPaths: [] }, cause);
  }
  const prepared = stored.workspaceReturn;
  const groups = new Set(stored.comparison.inventory.files.map(file => file.path.split('/')[0]!));
  const entries = new Map(prepared?.entries.map(entry => [entry.path, entry]));
  const selected = new Set(input.paths);
  const replacements = new Set(input.replaceConflictPaths ?? []);
  const selectedEntry = (path: string) => selected.has(path) || selected.has(path.split('/')[0]!);
  if (!prepared || stored.sessionId !== input.sessionId || new Set(input.paths).size !== input.paths.length
    || input.paths.some(path => !groups.has(path) && !entries.has(path))
    || [...replacements].some(path => !selectedEntry(path) || !entries.get(path)?.conflicts.some(conflict => conflict.path === path))) {
    throw new ManagedWorkspaceReturnError('invalid_request', 'The selected return or paths were not reviewed', { appliedPaths: [] });
  }
  if (!prepared.baselineAvailable) throw new ManagedWorkspaceReturnError('baseline_unavailable',
    'The original project baseline is unavailable; review and apply the patch manually', { appliedPaths: [] });
  const directory = resolveStoredScmComparisonEndpointsPath(storagePath);
  const appliedPaths: string[] = [];
  const conflicts: ManagedWorkspaceReturnConflict[] = [];
  let applicationFailure: unknown;
  try {
    for (const [path, entry] of entries) {
      if (!selectedEntry(path)) continue;
      if (entry.conflicts.length && !replacements.has(path)) { conflicts.push(...entry.conflicts); continue; }
      try {
        input.signal?.throwIfAborted();
        const outcome = await applyCapturedWorkspaceSyncEntryAtRoot({ rootPath: stored.comparison.repository.rootPath, relativePath: path,
          expectedDestination: entry.expectedDestination, selectedExpectation: entry.selectedExpectation,
          materialPath: entry.selectedExpectation.kind === 'missing' ? null : join(directory, 'after', path),
          recoveryDirectory: join(directory, 'recovery'), operationId: randomUUID() });
        if (outcome.status !== 'installed') throw new ManagedWorkspaceReturnError('conflict_resolution_unsupported',
          outcome.status === 'restored' ? 'The host entry was restored without applying changes' : 'The host entry needs recovery',
          { appliedPaths, path, ...(outcome.status === 'recovery_needed' ? { recoveryPath: outcome.recoveryPath } : {}) });
        appliedPaths.push(path);
        entries.delete(path);
      } catch (error) {
        throw new ManagedWorkspaceReturnError(readRpcErrorCode(error) ?? readActionErrorCodeV1(error) ?? 'action_failed',
          error instanceof Error ? error.message : 'The reviewed return failed',
          { ...readManagedWorkspaceReturnErrorDetails(error), appliedPaths: [...appliedPaths], path }, error);
      }
    }
  } catch (error) { applicationFailure = error; throw error; }
  finally {
    if (appliedPaths.length) {
      try { await writeStoredScmComparison(storagePath, { ...stored,
        workspaceReturn: { ...prepared, entries: [...entries.values()] } }); }
      catch (error) { throw new ManagedWorkspaceReturnError(applicationFailure
        ? readRpcErrorCode(applicationFailure) ?? readActionErrorCodeV1(applicationFailure) ?? 'action_failed' : 'action_failed',
        'Changes were applied, but the remaining review could not be saved',
        { ...readManagedWorkspaceReturnErrorDetails(applicationFailure), appliedPaths: [...appliedPaths] },
        applicationFailure ? new AggregateError([applicationFailure, error], 'Application and review retention failed') : error); }
    }
  }
  return { appliedPaths, conflicts };
}

export async function prepareManagedWorkspaceReturnFromStage(input: Readonly<{
  sessionId: string; hostRoot: string; stageRoot: string; activeServerDir: string;
  baseline?: WorkspaceManifest; excludedPaths?: readonly string[]; registry?: ScmBackendRegistry; signal?: AbortSignal;
}>): Promise<ManagedWorkspaceReturnPreview> {
  return runWithScmBackendRegistryLease(input.registry, registry => runWithWorkspaceSource(localWorkspaceSource, async () => {
    const returnId = buildScmComparisonIdentity({ source: { kind: 'workingTree' }, repositoryRootPath: input.hostRoot, evidenceIdentity: randomUUID() });
    const directory = await privateDirectory(input.activeServerDir);
    try {
      const beforeRoot = join(directory, 'before'); const afterRoot = join(directory, 'after');
      const hostSelection = await resolveWorkspaceReplicationSourceInputsWithScmWorkspace({ sourcePath: input.hostRoot,
        workspaceTransfer: { includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [], contentOnly: true }, registry });
      const excludedPaths = new Set(input.excludedPaths);
      const selectedHostPaths = new Set(hostSelection.entries.filter(entry => !excludedPaths.has(entry.relativePath))
        .flatMap(entry => ancestors(entry.relativePath)));
      for (const entry of hostSelection.entries) await entry.disposeSource?.();
      await snapshotRoot(input.stageRoot, afterRoot, registry, input.signal);
      await mkdir(join(directory, 'recovery'), { mode: 0o700 });
      const rawAfter = await scanWorkspaceManifest({ workspaceRoot: afterRoot,
        safeFilterPolicy: { excludeAdministrativePaths: false }, assertCanContinue: () => input.signal?.throwIfAborted() });
      const after = withoutAdministrativeMetadata(rawAfter, registry);
      // An admitted sandbox file can collide with an ignored host file. Retain
      // that host version as a conflict rather than presenting an empty preimage.
      const captureHostPaths = new Set([...selectedHostPaths, ...after.entries.flatMap(entry => ancestors(entry.relativePath))]);
      const rawBeforeEntries = await snapshotSelectedHostRoot(input.hostRoot, beforeRoot, captureHostPaths, registry, input.signal);
      const before = await scanWorkspaceManifest({ workspaceRoot: beforeRoot,
        safeFilterPolicy: { excludeAdministrativePaths: false }, assertCanContinue: () => input.signal?.throwIfAborted() });
      const beforeEntries = new Map(before.entries.map(entry => [entry.relativePath, entry]));
      const afterEntries = new Map(after.entries.map(entry => [entry.relativePath, entry]));
      const different = changes(before, after);
      const targetChanged = input.baseline ? changes(withoutAdministrativeMetadata(input.baseline, registry), after) : new Set(different);
      const hostChanged = input.baseline ? changes(withoutAdministrativeMetadata(input.baseline, registry), before) : new Set<string>();
      for (const path of excludedPaths) { different.delete(path); targetChanged.delete(path); hostChanged.delete(path); }
      const hostChangedAncestors = new Set([...hostChanged].flatMap(ancestors));
      const conflictAncestors = new Set([...hostChanged].filter(path => different.has(path)).flatMap(ancestors));
      const metadataAncestors = (manifest: WorkspaceManifest) => {
        const paths = new Map<string, string>();
        for (const entry of manifest.entries) if (isAdministrativeWorkspacePathWithScmWorkspace({ relativePath: entry.relativePath, registry })) {
          for (const path of ancestors(entry.relativePath)) if (!paths.has(path)) paths.set(path, entry.relativePath);
        }
        return paths;
      };
      const afterMetadata = metadataAncestors(rawAfter);
      const protectedHostPaths = new Map<string, string | null>();
      const findProtectedHostPath = async (path: string): Promise<string | null> => {
        const known = protectedHostPaths.get(path);
        if (known !== undefined) return known;
        input.signal?.throwIfAborted();
        const children = await localWorkspaceSource.readdir(join(input.hostRoot, path));
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
          const childPath = `${path}/${child.name}`;
          const excluded = !selectedHostPaths.has(childPath) ? childPath
            : child.isDirectory() ? await findProtectedHostPath(childPath) : null;
          if (excluded) { protectedHostPaths.set(path, excluded); return excluded; }
        }
        protectedHostPaths.set(path, null);
        return null;
      };
      const candidates = new Set<string>();
      for (const path of targetChanged) {
        if (!different.has(path)) continue;
        const segments = path.split('/');
        for (let count = 1; count <= segments.length; count++) {
          const prefix = segments.slice(0, count).join('/');
          const old = rawBeforeEntries.get(prefix); const next = afterEntries.get(prefix);
          if (old?.kind === 'directory' && next?.kind === 'directory') continue;
          // Delete eligible children independently when a removed directory holds person edits or Git metadata.
          if (old?.kind === 'directory' && !next && (hostChangedAncestors.has(prefix) || await findProtectedHostPath(prefix))) continue;
          candidates.add(prefix); break;
        }
      }
      const entries = new Map<string, PreparedEntry>();
      for (const path of [...candidates].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))) {
        if (ancestors(path).some(ancestor => entries.has(ancestor))) continue;
        const protectedHostPath = rawBeforeEntries.get(path)?.kind === 'directory' ? await findProtectedHostPath(path) : null;
        if (rawBeforeEntries.get(path)?.kind === 'directory' && afterEntries.get(path)?.kind !== 'directory' && protectedHostPath) {
          throw new ManagedWorkspaceReturnError('workspace_file_unsupported',
            'This replacement would remove excluded host files; return the file changes manually', { appliedPaths: [], path: protectedHostPath });
        }
        const metadata = afterMetadata.get(path);
        if (metadata) throw new ManagedWorkspaceReturnError('workspace_file_unsupported',
          'This new subtree contains Git metadata; return its files manually', { appliedPaths: [], path: metadata });
        const conflicts: ManagedWorkspaceReturnConflict[] = conflictAncestors.has(path)
          ? [{ path, code: 'both_changed' }] : [];
        const expectedDestination = await observeWorkspaceSyncEntryAtRoot({ rootPath: beforeRoot, relativePath: path });
        const selectedExpectation = await observeWorkspaceSyncEntryAtRoot({ rootPath: afterRoot, relativePath: path });
        entries.set(path, { path, expectedDestination, selectedExpectation, conflicts });
      }
      const paths: Array<ManagedWorkspaceReturnPreview['paths'][number]> = [];
      const fileGroups = new Map<string, string[]>();
      const conflictGroups = new Map<string, ManagedWorkspaceReturnConflict[]>();
      for (const path of targetChanged) if (different.has(path)) {
        const group = path.split('/')[0]!;
        const files = fileGroups.get(group) ?? [];
        files.push(path); fileGroups.set(group, files);
      }
      for (const entry of entries.values()) {
        const group = entry.path.split('/')[0]!;
        const conflicts = conflictGroups.get(group) ?? [];
        conflicts.push(...entry.conflicts); conflictGroups.set(group, conflicts);
      }
      const groups = [...fileGroups.keys()].sort();
      for (const path of groups) {
        const filePaths = fileGroups.get(path)!.sort();
        const files = await Promise.all(filePaths.map(changed => reviewFile(changed, beforeRoot, afterRoot, beforeEntries.get(changed), afterEntries.get(changed))));
        const conflicts = conflictGroups.get(path) ?? [];
        paths.push({ path, files, conflicts });
      }
      const storagePath = resolveStoredScmComparisonPath({ activeServerDir: input.activeServerDir, sessionId: input.sessionId, comparisonId: returnId });
      const endpointDirectory = resolveStoredScmComparisonEndpointsPath(storagePath);
      await mkdir(dirname(storagePath), { recursive: true, mode: 0o700 });
      await rename(directory, endpointDirectory);
      try {
        await writeStoredScmComparison(storagePath, { sessionId: input.sessionId,
          metadata: { source: { kind: 'workingTree' }, sourceKey: returnId, contentConfidence: 'exact', attributionScope: 'unknown' },
          comparison: { id: returnId, source: { kind: 'workingTree' }, repository: { rootPath: input.hostRoot }, endpoints: {},
            inventory: { state: 'complete', files: paths.flatMap(group => [...group.files]), reasons: [] }, freshness: 'current', attributionScope: 'unknown' },
          retainedRefs: [], workspaceReturn: { baselineAvailable: input.baseline !== undefined, entries: [...entries.values()] } });
      } catch (error) { await rm(endpointDirectory, { recursive: true, force: true }); throw error; }
      return { returnId, sessionId: input.sessionId, repositoryRootPath: input.hostRoot, paths,
        ...(!input.baseline ? { applyUnavailableReason: 'baseline_unavailable' as const } : {}) };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }));
}
