import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

import type { ConnectedServiceStateSharingDescriptor, ConnectedServiceStateSharingDescriptorEntry } from '@/agent/catalog/types';
import type {
  ConnectedServiceStateSharingManifestV1,
  ConnectedServiceStateSharingSessionFileMappingV1,
  ConnectedServiceStateSharingMode,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import {
  copyConnectedServiceHomeEntry,
  linkConnectedServiceHomeEntry,
  moveConnectedServiceHomeEntryAside,
  prepareManagedConnectedServiceHomeDestination,
  removeLinkedConnectedServiceHomeEntries,
  tryStatConnectedServiceHomeEntry,
} from './connectedServiceHomeEntrySync';
import { createConnectedServiceSharedStateLink, ConnectedServiceSharedStateLinkUnavailableError } from './createSharedStateLink';
import { importConnectedServiceSessionFiles, type ConnectedServiceSessionFileImportDetail, type ConnectedServiceSessionFileImportRoot } from './importConnectedServiceSessionFiles';
import { removeConnectedServiceStateSharingManifestEntries } from './connectedServiceStateSharingManifest';

type ConnectedServicesMaterializationDiagnostic = Readonly<{
  code: string;
  providerId: string;
  serviceId?: string;
  requestedStateMode?: string;
  effectiveStateMode?: string;
  entryName?: string;
  reason?: string;
}>;

export type NativeSourceContext = Readonly<{
  sourceRoot: string;
  sourceEnv: Readonly<Record<string, string>>;
}>;

export type ExistingMaterializedStateContext = Readonly<{
  previousMaterializedRoot: string;
  allowedRelativePaths: readonly string[];
  expiresAfterRelease: string;
}>;

export type TargetMaterializationContext = Readonly<{
  targetMaterializedRoot: string;
  targetMaterializedEnv: Record<string, string>;
}>;

export type ApplyConnectedServiceStateSharingDescriptorInput = Readonly<{
  descriptor: ConnectedServiceStateSharingDescriptor;
  nativeSourceContext: NativeSourceContext;
  existingMaterializedStateContext?: ExistingMaterializedStateContext;
  target: TargetMaterializationContext;
  configMode: 'linked' | 'copied' | 'isolated';
  requestedStateMode: ConnectedServiceStateSharingMode;
  effectiveStateMode: ConnectedServiceStateSharingMode;
  cwd: string;
  existingManifest?: ConnectedServiceStateSharingManifestV1;
  configEntryNames?: readonly string[];
  stateEntryNames?: readonly string[];
  resolveStateSourceRoot?: (entryName: string) => string;
  allowHardLinkFallbackForStateEntry?: (entryName: string) => boolean;
  preserveDestinationWhenStateSourceMissing?: (entryName: string) => boolean;
  symlinkUnavailableDegradePolicy?: 'block_continuity' | 'degrade_to_isolated';
  mapStateSymlinkUnavailableDiagnostic?: (error: ConnectedServiceSharedStateLinkUnavailableError) => ConnectedServicesMaterializationDiagnostic;
  copyTransformByEntry?: Readonly<Record<string, (content: string) => string>>;
  forceCopiedEntries?: readonly string[];
  sessionImportRoots?: readonly ConnectedServiceSessionFileImportRoot[];
  resolveVendorResumeIdFromImportedFile?: (detail: ConnectedServiceSessionFileImportDetail) => string | null;
  providerLabel?: string;
}>;

export type ApplyConnectedServiceStateSharingDescriptorResult = Readonly<{
  envOverrides: Record<string, string>;
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
  manifest: ConnectedServiceStateSharingManifestV1;
  importedSessionFileMappings: readonly ConnectedServiceStateSharingSessionFileMappingV1[];
}>;

function isWin32ShapedPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path)
    || path.startsWith('\\\\?\\')
    || path.startsWith('\\\\')
    || path.startsWith('//')
    || path.includes('\\');
}

function stripWin32NamespacePrefix(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`;
  if (path.startsWith('\\\\?\\')) return path.slice('\\\\?\\'.length);
  return path;
}

function usesWin32Comparison(path: string, root: string): boolean {
  return isWin32ShapedPath(path) || isWin32ShapedPath(root);
}

function resolvePathForComparison(path: string): string {
  return isWin32ShapedPath(path)
    ? win32.resolve(stripWin32NamespacePrefix(path))
    : resolve(path);
}

function relativePathForComparison(root: string, path: string): string {
  if (usesWin32Comparison(path, root)) {
    return win32.relative(
      win32.resolve(stripWin32NamespacePrefix(root)),
      win32.resolve(stripWin32NamespacePrefix(path)),
    );
  }
  return relative(root, path);
}

function isPathWithin(path: string, root: string): boolean {
  const rel = relativePathForComparison(root, path);
  if (rel.length === 0) return true;
  if (usesWin32Comparison(path, root)) {
    return !rel.startsWith('..') && !win32.isAbsolute(rel) && !rel.includes(`..${win32.sep}`);
  }
  return !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(`..${sep}`);
}

function normalizeRelativePath(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).join('/');
}

function isAllowedMigrationSource(params: Readonly<{
  sourceRoot: string;
  existingMaterializedStateContext?: ExistingMaterializedStateContext;
}>): boolean {
  if (!params.existingMaterializedStateContext) return false;
  const previousRoot = resolvePathForComparison(params.existingMaterializedStateContext.previousMaterializedRoot);
  if (!isPathWithin(params.sourceRoot, previousRoot)) return false;
  const relativeToPrevious = normalizeRelativePath(relativePathForComparison(previousRoot, params.sourceRoot));
  if (!relativeToPrevious || relativeToPrevious.startsWith('..') || relativeToPrevious.startsWith('/')) return false;
  return params.existingMaterializedStateContext.allowedRelativePaths.some((allowed) => {
    const normalizedAllowed = normalizeRelativePath(allowed);
    if (!normalizedAllowed || normalizedAllowed.startsWith('..') || normalizedAllowed.startsWith('/')) return false;
    return relativeToPrevious === normalizedAllowed || relativeToPrevious.startsWith(`${normalizedAllowed}/`);
  });
}

function assertNativeSourceRootInvariant(input: ApplyConnectedServiceStateSharingDescriptorInput): void {
  if (process.env.NODE_ENV === 'production') return;
  const sourceRoot = resolvePathForComparison(input.nativeSourceContext.sourceRoot);
  const targetRoot = resolvePathForComparison(input.target.targetMaterializedRoot);
  if (!isPathWithin(sourceRoot, targetRoot)) return;
  if (isAllowedMigrationSource({ sourceRoot, existingMaterializedStateContext: input.existingMaterializedStateContext })) return;
  throw new Error('nativeSourceContext.sourceRoot must not be nested under target.targetMaterializedRoot');
}

function resolveEntryMode(params: Readonly<{
  descriptorEntry: ConnectedServiceStateSharingDescriptorEntry;
  entryName: string;
  configMode: 'linked' | 'copied' | 'isolated';
  forceCopiedEntries?: readonly string[];
}>): 'linked' | 'copied' | 'env_redirect' {
  if (params.forceCopiedEntries?.includes(params.entryName)) return 'copied';
  const mode = params.descriptorEntry.mode;
  if (mode === 'force_copied') return 'copied';
  if (mode === 'linked_or_copied') return params.configMode === 'linked' ? 'linked' : 'copied';
  if (mode === 'linked') return 'linked';
  if (mode === 'copied') return 'copied';
  return 'env_redirect';
}

function resolveDescriptorEntryForPath(
  descriptor: ConnectedServiceStateSharingDescriptor,
  scope: 'config' | 'state',
  path: string,
): ConnectedServiceStateSharingDescriptorEntry | null {
  const entries = scope === 'config' ? descriptor.config.entries : descriptor.state.entries;
  const exact = entries.find((entry) => entry.path === path);
  if (exact) return exact;
  const wildcard = entries.find((entry) => {
    if (!entry.path.includes('*')) return false;
    const escaped = entry.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const withSqliteCompanionSuffix = entry.path.endsWith('.sqlite')
      ? escaped.replace(/\\\.sqlite$/, '\\.sqlite(?:-(?:wal|shm))?')
      : escaped;
    return new RegExp(`^${withSqliteCompanionSuffix}$`).test(path);
  });
  if (wildcard) return wildcard;
  const parent = entries.find((entry) => !entry.path.includes('*') && path.startsWith(`${entry.path}/`));
  if (parent) return parent;

  for (const dynamicPattern of Object.values(descriptor.dynamicEntryPatterns ?? {})) {
    if (dynamicPattern.scope !== scope) continue;
    let matcher: RegExp;
    try {
      matcher = new RegExp(dynamicPattern.pattern);
    } catch {
      continue;
    }
    if (!matcher.test(path)) continue;
    return {
      path,
      mode: dynamicPattern.mode ?? 'linked',
      ...(dynamicPattern.envVar ? { envVar: dynamicPattern.envVar } : {}),
      ...(dynamicPattern.allowHardLinkFallback !== undefined
        ? { allowHardLinkFallback: dynamicPattern.allowHardLinkFallback }
        : {}),
    };
  }
  return null;
}

async function copyEntryWithOptionalTransform(params: Readonly<{
  sourcePath: string;
  destinationPath: string;
  transform?: ((content: string) => string) | undefined;
}>): Promise<void> {
  if (!params.transform) {
    await copyConnectedServiceHomeEntry(params.sourcePath, params.destinationPath);
    return;
  }
  const sourceStat = await tryStatConnectedServiceHomeEntry(params.sourcePath);
  if (!sourceStat || !sourceStat.isFile()) {
    await copyConnectedServiceHomeEntry(params.sourcePath, params.destinationPath);
    return;
  }
  const content = await readFile(params.sourcePath, 'utf8');
  await mkdir(dirname(params.destinationPath), { recursive: true });
  await writeFile(params.destinationPath, params.transform(content), 'utf8');
}

async function preflightStateLink(params: Readonly<{
  providerLabel: string;
  entryName: string;
  sourcePath: string;
  destinationPath: string;
  allowHardLinkFallback: boolean;
}>): Promise<void> {
  const sourceStat = await tryStatConnectedServiceHomeEntry(params.sourcePath);
  if (!sourceStat) return;
  const tempLinkPath = `${params.destinationPath}.happier-link-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await mkdir(dirname(params.destinationPath), { recursive: true });
    await createConnectedServiceSharedStateLink({
      providerLabel: params.providerLabel,
      entryName: params.entryName,
      sourcePath: params.sourcePath,
      destinationPath: tempLinkPath,
      sourceStat,
      allowHardLinkFallback: params.allowHardLinkFallback,
    });
  } finally {
    await rm(tempLinkPath, { recursive: true, force: true });
  }
}

async function materializeLinkedStateEntry(params: Readonly<{
  providerLabel: string;
  entryName: string;
  sourcePath: string;
  destinationPath: string;
  allowHardLinkFallback: boolean;
  preserveDestinationWhenSourceMissing: boolean;
}>): Promise<boolean> {
  const sourceStat = await tryStatConnectedServiceHomeEntry(params.sourcePath);
  if (!sourceStat) {
    if (!params.preserveDestinationWhenSourceMissing) {
      await prepareManagedConnectedServiceHomeDestination(params.destinationPath);
    }
    return false;
  }
  await prepareManagedConnectedServiceHomeDestination(params.destinationPath);
  const tempLinkPath = `${params.destinationPath}.happier-link-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await createConnectedServiceSharedStateLink({
      providerLabel: params.providerLabel,
      entryName: params.entryName,
      sourcePath: params.sourcePath,
      destinationPath: tempLinkPath,
      sourceStat,
      allowHardLinkFallback: params.allowHardLinkFallback,
    });

    // The provider may recreate its state directory between the removal above and the atomic
    // symlink rename (including EPERM on Windows). Reconcile that newly appeared entry and retry
    // the same prepared link so a live-home race cannot abort materialization or create a competing path.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let destinationStat;
      try {
        destinationStat = await lstat(params.destinationPath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code !== 'ENOENT') throw error;
      }

      if (destinationStat) {
        if (destinationStat.isSymbolicLink()) {
          await rm(params.destinationPath, { recursive: true, force: true });
        } else {
          await moveConnectedServiceHomeEntryAside(params.destinationPath);
        }
      }
      await mkdir(dirname(params.destinationPath), { recursive: true });
      try {
        await rename(tempLinkPath, params.destinationPath);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const destinationAppeared = code === 'EISDIR'
          || code === 'ENOTEMPTY'
          || code === 'EEXIST'
          || code === 'EPERM';
        if (!destinationAppeared || attempt === 2) throw error;
      }
    }
    throw new Error('State-link promotion retry loop exhausted without returning or throwing');
  } catch (error) {
    await rm(tempLinkPath, { recursive: true, force: true });
    throw error;
  }
}

function defaultSymlinkUnavailableDiagnostic(params: Readonly<{
  providerId: ConnectedServiceStateSharingDescriptor['providerId'];
  requestedStateMode: ConnectedServiceStateSharingMode;
}>): (error: ConnectedServiceSharedStateLinkUnavailableError) => ConnectedServicesMaterializationDiagnostic {
  return (error) => ({
    code: 'state_symlink_unavailable',
    providerId: params.providerId,
    requestedStateMode: params.requestedStateMode,
    effectiveStateMode: 'isolated',
    entryName: error.entryName,
    reason: 'symlink_unavailable',
  });
}

function isConnectedServiceSharedStateLinkUnavailableError(error: unknown): error is ConnectedServiceSharedStateLinkUnavailableError {
  if (error instanceof ConnectedServiceSharedStateLinkUnavailableError) return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'state_symlink_unavailable';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyRewriteTomlSetStringValues(
  content: string,
  setStringValues: Readonly<Record<string, string>>,
): string {
  let resultLines = content.split(/\r?\n/);
  for (const [key, value] of Object.entries(setStringValues)) {
    if (!key.trim()) continue;
    const assignment = `${key} = ${JSON.stringify(value)}`;
    const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
    let replaced = false;
    const nextLines: string[] = [];
    for (const line of resultLines) {
      if (keyPattern.test(line)) {
        if (!replaced) {
          nextLines.push(assignment);
          replaced = true;
        }
        continue;
      }
      nextLines.push(line);
    }
    if (!replaced) {
      const firstTableIndex = nextLines.findIndex((line) => /^\s*\[/.test(line));
      if (firstTableIndex === -1) {
        nextLines.push(assignment);
      } else {
        nextLines.splice(firstTableIndex, 0, assignment);
      }
    }
    resultLines = nextLines;
  }
  return resultLines.join('\n');
}

function buildDescriptorCopyTransformByEntry(
  descriptor: ConnectedServiceStateSharingDescriptor,
): Readonly<Record<string, (content: string) => string>> {
  const transforms: Record<string, (content: string) => string> = {};
  for (const transform of descriptor.transforms ?? []) {
    if (transform.kind === 'rewrite_toml') {
      transforms[transform.entry] = (content) => applyRewriteTomlSetStringValues(content, transform.spec.setStringValues);
      continue;
    }
    throw new Error(`Unsupported connected-service descriptor transform kind: ${transform.kind}`);
  }
  return transforms;
}

function dedupeManifestEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function buildSessionFileMappings(params: Readonly<{
  details: readonly ConnectedServiceSessionFileImportDetail[];
  resolveVendorResumeIdFromImportedFile?: (detail: ConnectedServiceSessionFileImportDetail) => string | null;
}>): ConnectedServiceStateSharingSessionFileMappingV1[] {
  if (!params.resolveVendorResumeIdFromImportedFile) return [];
  const now = Date.now();
  const seen = new Set<string>();
  const mappings: ConnectedServiceStateSharingSessionFileMappingV1[] = [];
  for (const detail of params.details) {
    const vendorResumeId = params.resolveVendorResumeIdFromImportedFile(detail);
    if (!vendorResumeId) continue;
    const dedupeKey = `${vendorResumeId}\u0000${detail.destinationPath}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    mappings.push({
      vendorResumeId,
      sourcePath: detail.sourcePath,
      destinationPath: detail.destinationPath,
      importedAtMs: now,
      verifiedAtMs: null,
    });
  }
  return mappings;
}

export async function applyConnectedServiceStateSharingDescriptor(
  input: ApplyConnectedServiceStateSharingDescriptorInput,
): Promise<ApplyConnectedServiceStateSharingDescriptorResult> {
  assertNativeSourceRootInvariant(input);

  const providerLabel = input.providerLabel ?? input.descriptor.providerId;
  const targetRoot = resolve(input.target.targetMaterializedRoot);
  const sourceRoot = resolve(input.nativeSourceContext.sourceRoot);
  const envOverrides: Record<string, string> = {};
  const diagnostics: ConnectedServicesMaterializationDiagnostic[] = [];
  const descriptorCopyTransformByEntry = buildDescriptorCopyTransformByEntry(input.descriptor);
  const previousManifest = input.existingManifest;
  const configEntryNames = input.configEntryNames ?? input.descriptor.config.entries.map((entry) => entry.path);
  const stateEntryNames = input.stateEntryNames ?? input.descriptor.state.entries.map((entry) => entry.path);
  const configRemovalCandidates = dedupeManifestEntries([
    ...(previousManifest?.configEntries ?? []),
    ...input.descriptor.config.entries.map((entry) => entry.path),
    ...configEntryNames,
  ]);
  const stateRemovalCandidates = dedupeManifestEntries([
    ...(previousManifest?.stateEntries ?? []),
    ...input.descriptor.state.entries.map((entry) => entry.path),
    ...stateEntryNames,
  ]);
  const configEntries: string[] = [];
  let stateEntries: string[] = [];
  let effectiveStateMode = input.effectiveStateMode;
  let importedSessionFileMappings: ConnectedServiceStateSharingSessionFileMappingV1[] = [];

  await mkdir(targetRoot, { recursive: true });

  await removeConnectedServiceStateSharingManifestEntries(targetRoot, previousManifest?.configEntries ?? []);
  await removeLinkedConnectedServiceHomeEntries(targetRoot, configRemovalCandidates);

  if (input.configMode !== 'isolated') {
    for (const entryName of configEntryNames) {
      const descriptorEntry = resolveDescriptorEntryForPath(input.descriptor, 'config', entryName);
      if (!descriptorEntry) continue;
      const entryMode = resolveEntryMode({
        descriptorEntry,
        entryName,
        configMode: input.configMode,
        forceCopiedEntries: input.forceCopiedEntries,
      });
      const sourcePath = join(sourceRoot, entryName);
      const destinationPath = join(targetRoot, entryName);
      if (entryMode === 'env_redirect') {
        if (descriptorEntry.envVar) envOverrides[descriptorEntry.envVar] = destinationPath;
        continue;
      }
      const sourceStat = await tryStatConnectedServiceHomeEntry(sourcePath);
      if (!sourceStat) continue;
      await prepareManagedConnectedServiceHomeDestination(destinationPath);
      if (entryMode === 'copied') {
        await copyEntryWithOptionalTransform({
          sourcePath,
          destinationPath,
          transform: input.copyTransformByEntry?.[entryName] ?? descriptorCopyTransformByEntry[entryName],
        });
      } else {
        try {
          await linkConnectedServiceHomeEntry(sourcePath, destinationPath, sourceStat);
        } catch {
          await copyEntryWithOptionalTransform({
            sourcePath,
            destinationPath,
            transform: input.copyTransformByEntry?.[entryName] ?? descriptorCopyTransformByEntry[entryName],
          });
        }
      }
      configEntries.push(entryName);
    }
  }

  await removeConnectedServiceStateSharingManifestEntries(targetRoot, previousManifest?.stateEntries ?? []);
  await removeLinkedConnectedServiceHomeEntries(targetRoot, stateRemovalCandidates);

  if (input.requestedStateMode === 'shared' && effectiveStateMode === 'shared') {
    const resolveStateSourceRoot = input.resolveStateSourceRoot ?? (() => sourceRoot);
    const degradePolicy = input.symlinkUnavailableDegradePolicy ?? input.descriptor.state.symlinkUnavailableDegradePolicy;
    try {
      for (const entryName of stateEntryNames) {
        const descriptorEntry = resolveDescriptorEntryForPath(input.descriptor, 'state', entryName);
        if (!descriptorEntry || (descriptorEntry.mode !== 'linked' && descriptorEntry.mode !== 'linked_or_copied')) continue;
        await preflightStateLink({
          providerLabel,
          entryName,
          sourcePath: join(resolve(resolveStateSourceRoot(entryName)), entryName),
          destinationPath: join(targetRoot, entryName),
          allowHardLinkFallback:
            input.allowHardLinkFallbackForStateEntry?.(entryName)
            ?? descriptorEntry.allowHardLinkFallback
            ?? true,
        });
      }
    } catch (error) {
      if (!isConnectedServiceSharedStateLinkUnavailableError(error) || degradePolicy !== 'degrade_to_isolated') {
        throw error;
      }
      effectiveStateMode = 'isolated';
      diagnostics.push(
        (input.mapStateSymlinkUnavailableDiagnostic
          ?? defaultSymlinkUnavailableDiagnostic({
            providerId: input.descriptor.providerId,
            requestedStateMode: input.requestedStateMode,
          }))(error),
      );
    }
  }

  if (input.requestedStateMode === 'shared' && effectiveStateMode === 'shared') {
    if (input.sessionImportRoots && input.sessionImportRoots.length > 0) {
      const importResult = await importConnectedServiceSessionFiles({ roots: input.sessionImportRoots });
      importedSessionFileMappings = buildSessionFileMappings({
        details: importResult.details,
        resolveVendorResumeIdFromImportedFile: input.resolveVendorResumeIdFromImportedFile,
      });
    }

    const resolveStateSourceRoot = input.resolveStateSourceRoot ?? (() => sourceRoot);
    for (const entryName of stateEntryNames) {
      const descriptorEntry = resolveDescriptorEntryForPath(input.descriptor, 'state', entryName);
      if (!descriptorEntry) continue;
      const sourcePath = join(resolve(resolveStateSourceRoot(entryName)), entryName);
      const destinationPath = join(targetRoot, entryName);
      if (descriptorEntry.mode === 'env_redirect') {
        await mkdir(destinationPath, { recursive: true });
        if (descriptorEntry.envVar) envOverrides[descriptorEntry.envVar] = destinationPath;
        stateEntries.push(entryName);
        continue;
      }
      if (descriptorEntry.mode === 'copied') {
        const sourceStat = await tryStatConnectedServiceHomeEntry(sourcePath);
        await prepareManagedConnectedServiceHomeDestination(destinationPath);
        if (!sourceStat) continue;
        await copyConnectedServiceHomeEntry(sourcePath, destinationPath);
        stateEntries.push(entryName);
        continue;
      }
      if (descriptorEntry.mode === 'linked' || descriptorEntry.mode === 'linked_or_copied') {
        if (!await materializeLinkedStateEntry({
          providerLabel,
          entryName,
          sourcePath,
          destinationPath,
          allowHardLinkFallback:
            input.allowHardLinkFallbackForStateEntry?.(entryName)
            ?? descriptorEntry.allowHardLinkFallback
            ?? true,
          preserveDestinationWhenSourceMissing:
            input.preserveDestinationWhenStateSourceMissing?.(entryName) ?? false,
        })) continue;
        stateEntries.push(entryName);
      }
    }
  } else {
    stateEntries = [];
  }

  const manifest: ConnectedServiceStateSharingManifestV1 = {
    v: 1,
    requestedStateMode: input.requestedStateMode,
    effectiveStateMode,
    lastSyncAtMs: Date.now(),
    configEntries: dedupeManifestEntries(configEntries),
    stateEntries: dedupeManifestEntries(stateEntries),
    sessionFileMappings: importedSessionFileMappings,
    diagnostics: diagnostics
      .map((entry) => (typeof entry.reason === 'string' && entry.reason.trim().length > 0 ? entry.reason : entry.code))
      .filter((entry) => entry.trim().length > 0),
  };

  return {
    envOverrides,
    diagnostics,
    manifest,
    importedSessionFileMappings,
  };
}
