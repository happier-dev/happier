import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

import { parse, stringify, TomlError, type TomlTable, type TomlValue } from 'smol-toml';
import type { AgentConnectedAccountSharedStateFileMergeV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { linkDirectoryChildren, resolveConfiguredNativeHomePath } from '@happier-dev/plugin-sdk/fs';

import type { ConnectedServiceStateSharingDescriptor, ConnectedServiceStateSharingDescriptorEntry } from '@/agent/catalog/types';
import type { ConnectedServiceMaterializedStateObservationBinding, ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialization/materializer';
import { logger } from '@/ui/logger';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import type {
  ConnectedServiceStateSharingManifestV1,
  ConnectedServiceStateSharingSessionFileMappingV1,
  ConnectedServiceStateSharingMode,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import {
  copyConnectedServiceHomeEntry,
  isConnectedServiceHomeEntryLinkedToSource,
  linkConnectedServiceHomeEntry,
  listDisplacedConnectedServiceHomeDirectories,
  moveConnectedServiceHomeEntryAside,
  prepareManagedConnectedServiceHomeDestination,
  removeLinkedConnectedServiceHomeEntries,
  tryLstatConnectedServiceHomeEntry,
  tryStatConnectedServiceHomeEntry,
} from './connectedServiceHomeEntrySync';
import { createConnectedServiceSharedStateLink, ConnectedServiceSharedStateLinkUnavailableError } from './createSharedStateLink';
import { importConnectedServiceSessionFiles, type ConnectedServiceSessionFileImportDetail, type ConnectedServiceSessionFileImportRoot } from './importConnectedServiceSessionFiles';
import { removeConnectedServiceStateSharingManifestEntries } from './connectedServiceStateSharingManifest';

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
  signal?: AbortSignal;
  descriptor: ConnectedServiceStateSharingDescriptor;
  nativeSourceContext: NativeSourceContext;
  existingMaterializedStateContext?: ExistingMaterializedStateContext;
  target: TargetMaterializationContext;
  configMode: 'linked' | 'copied' | 'isolated';
  requestedStateMode: ConnectedServiceStateSharingMode;
  effectiveStateMode: ConnectedServiceStateSharingMode;
  cwd: string;
  existingManifest?: ConnectedServiceStateSharingManifestV1;
  /** Stable promoted home whose own preferences survive staged replacement. */
  previousMaterializedRoot?: string | null;
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
  mergeSharedStateFile?: AgentConnectedAccountSharedStateFileMergeV1;
  resolveVendorResumeIdFromImportedFile?: (detail: ConnectedServiceSessionFileImportDetail) => string | null;
  providerLabel?: string;
}>;

export type ApplyConnectedServiceStateSharingDescriptorResult = Readonly<{
  envOverrides: Record<string, string>;
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
  manifest: ConnectedServiceStateSharingManifestV1;
  importedSessionFileMappings: readonly ConnectedServiceStateSharingSessionFileMappingV1[];
  linkedStateEntries: ConnectedServiceMaterializedStateObservationBinding['entries'];
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

/** Resolves one public native-home declaration without exposing path custody. */
export function resolveConnectedServiceNativeHomeRoot(input: Readonly<{
  nativeHome: NonNullable<ConnectedServiceStateSharingDescriptor['nativeHome']>;
  sourceEnvironment: Readonly<Record<string, string | undefined>>;
  homeDir: string;
}>): string {
  return resolveConfiguredNativeHomePath(input.nativeHome, input.sourceEnvironment, input.homeDir);
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
  const sourceRoot = resolvePathForComparison(input.nativeSourceContext.sourceRoot);
  const targetRoot = resolvePathForComparison(input.target.targetMaterializedRoot);
  if (sourceRoot === targetRoot
    && input.requestedStateMode === 'isolated' && input.effectiveStateMode === 'isolated') return;
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
  removeMissingDestinationEntries?: boolean;
}>): Promise<void> {
  if (!params.transform) {
    await copyConnectedServiceHomeEntry(params.sourcePath, params.destinationPath, params);
    return;
  }
  const sourceStat = await tryStatConnectedServiceHomeEntry(params.sourcePath);
  if (!sourceStat || !sourceStat.isFile()) {
    await copyConnectedServiceHomeEntry(params.sourcePath, params.destinationPath, params);
    return;
  }
  const content = await readFile(params.sourcePath, 'utf8');
  await writeConfigContentIfChanged(params.destinationPath, params.transform(content));
}

async function writeConfigContentIfChanged(destinationPath: string, content: string): Promise<void> {
  const parentPath = dirname(destinationPath);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  // A retained materialized directory can predate private config projection.
  // Repair only this destination parent; Windows permissions are owned by ACLs.
  if (process.platform !== 'win32') await chmod(parentPath, 0o700);
  try {
    if (await readFile(destinationPath, 'utf8') === content) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  await writeFile(destinationPath, content, { encoding: 'utf8', mode: 0o600 });
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
  signal?: AbortSignal;
  providerLabel: string;
  entryName: string;
  sourcePath: string;
  destinationPath: string;
  allowHardLinkFallback: boolean;
  preserveDestinationWhenSourceMissing: boolean;
}>): Promise<boolean> {
  const sourceStat = await tryStatConnectedServiceHomeEntry(params.sourcePath);
  if (!sourceStat) {
    const destinationStat = await tryLstatConnectedServiceHomeEntry(params.destinationPath);
    if (!params.preserveDestinationWhenSourceMissing && destinationStat?.isSymbolicLink()) {
      await prepareManagedConnectedServiceHomeDestination(params.destinationPath);
    }
    return false;
  }
  if (await isConnectedServiceHomeEntryLinkedToSource(params.sourcePath, params.destinationPath)) return true;
  await prepareManagedConnectedServiceHomeDestination(params.destinationPath);
  await mkdir(dirname(params.destinationPath), { recursive: true });
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
    while (true) {
      params.signal?.throwIfAborted();
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
        if (!destinationAppeared) throw error;
        // EPERM can also be a permanent permission refusal. Retry only the
        // observed recreated-directory race rather than hiding an OS failure.
        if (code === 'EPERM' && !await tryLstatConnectedServiceHomeEntry(params.destinationPath)) throw error;
      }
    }
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

function parseConnectedServiceTomlConfig(content: string, configPath: string): TomlTable {
  try {
    return parse(content, { integersAsBigInt: 'asNeeded' });
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    // Parser messages and codeblocks contain nearby config values. Retain only
    // safe classification and location metadata when reporting the file error.
    throw new Error(`Invalid TOML in ${configPath} (line ${error.line}, column ${error.column})`, {
      cause: { name: 'TomlError', line: error.line, column: error.column },
    });
  }
}

function asTomlTable(value: TomlValue | undefined): TomlTable | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as TomlTable : null;
}

function tableAt(config: TomlTable, path: readonly string[]): TomlTable | null {
  let table: TomlTable | null = config;
  for (const segment of path) table = table && Object.hasOwn(table, segment) ? asTomlTable(table[segment]) : null;
  return table;
}

function mergeTableEntries(config: TomlTable, path: readonly string[], entries: TomlTable): void {
  let table = config;
  for (const segment of path) {
    const child = (Object.hasOwn(table, segment) ? asTomlTable(table[segment]) : null) ?? (Object.create(null) as TomlTable);
    Object.defineProperty(table, segment, { value: child, writable: true, enumerable: true, configurable: true });
    table = child;
  }
  Object.assign(table, entries);
}

function removeTomlKeyPath(table: TomlTable, path: readonly string[]): void {
  const [segment, ...rest] = path;
  if (segment === undefined) return;
  for (const key of segment === '*' ? Object.keys(table) : [segment]) {
    if (!Object.hasOwn(table, key)) continue;
    if (rest.length === 0) delete table[key];
    else {
      const child = asTomlTable(table[key]);
      if (child) removeTomlKeyPath(child, rest);
    }
  }
}

async function buildDescriptorCopyTransformByEntry(
  input: ApplyConnectedServiceStateSharingDescriptorInput,
  diagnostics: ConnectedServicesMaterializationDiagnostic[],
): Promise<Readonly<Record<string, (content: string) => string>>> {
  const transforms: Record<string, (content: string) => string> = {};
  const effectiveRoot = resolve(input.previousMaterializedRoot ?? input.target.targetMaterializedRoot);
  for (const transform of input.descriptor.transforms ?? []) {
    if (transform.kind !== 'rewrite_toml') throw new Error(`Unsupported connected-service descriptor transform kind: ${transform.kind}`);
    const retained: Array<Readonly<{ path: readonly string[]; entries: TomlTable }>> = [];
    const rules = (transform.spec.preserveTableEntries ?? []).map((rule) => {
      const entryPath = resolve(effectiveRoot, rule.keyPrefixEntry);
      const sourceEntryPath = resolve(input.nativeSourceContext.sourceRoot, rule.keyPrefixEntry);
      if (!isPathWithin(entryPath, effectiveRoot)
        || !isPathWithin(sourceEntryPath, resolve(input.nativeSourceContext.sourceRoot))
        || !input.descriptor.config.entries.some((entry) => entry.path === rule.keyPrefixEntry)) {
        throw new Error('Profile preference keys must refer to a declared config entry');
      }
      return { ...rule, prefix: `${entryPath}${rule.keyPrefixSuffix}`, sourcePrefix: `${sourceEntryPath}${rule.keyPrefixSuffix}` };
    });
    if (input.configMode !== 'isolated' && transform.spec.preserveTableEntries?.length) {
      const previousPath = resolve(effectiveRoot, transform.entry);
      if (!isPathWithin(previousPath, effectiveRoot)) throw new Error('Profile config entry must stay within its materialized home');
      let previous: TomlTable | null = null;
      try {
        // A symlink does not establish profile-owned preferences.
        if ((await lstat(previousPath)).isFile()) {
          const content = await readFile(previousPath, 'utf8');
          try {
            previous = parseConnectedServiceTomlConfig(content, previousPath);
          } catch (error) {
            diagnostics.push({ code: 'profile_config_invalid', severity: 'warning',
              providerId: input.descriptor.providerId, entryName: transform.entry });
            logger.infoFile('[connected-services] Rebuilding malformed profile config from native config or defaults', error);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (previous) {
        for (const rule of rules) {
          const entries = Object.fromEntries(Object.entries(tableAt(previous, rule.tablePath) ?? {})
            .filter(([key]) => key.startsWith(rule.prefix)));
          if (Object.keys(entries).length) {
            retained.push({ path: rule.tablePath, entries });
          }
        }
      }
    }
    transforms[transform.entry] = (content) => {
      const config = parseConnectedServiceTomlConfig(content, resolve(input.nativeSourceContext.sourceRoot, transform.entry));
      for (const [key, value] of Object.entries(transform.spec.setStringValues)) {
        if (key.trim()) config[key] = value;
      }
      for (const path of transform.spec.removeKeyPaths ?? []) removeTomlKeyPath(config, path);
      for (const projection of transform.spec.setStringValuesFromEnvironment ?? []) {
        const selected = input.target.targetMaterializedEnv[projection.environmentKey];
        const value = selected !== undefined && Object.hasOwn(projection.values, selected) ? projection.values[selected] : undefined;
        const key = projection.path.at(-1);
        if (typeof value !== 'string' || !key) throw new Error('Connected-service config environment projection unavailable');
        mergeTableEntries(config, projection.path.slice(0, -1), { [key]: value });
      }
      for (const rule of rules) {
        if (!rule.rebaseSourceKeys || input.configMode === 'isolated') continue;
        const table = tableAt(config, rule.tablePath);
        if (!table) continue;
        for (const [key, value] of Object.entries(table)) {
          if (!key.startsWith(rule.sourcePrefix)) continue;
          delete table[key];
          // The native Agent still validates the unchanged trust hash against hook content.
          Object.defineProperty(table, `${rule.prefix}${key.slice(rule.sourcePrefix.length)}`, {
            value, writable: true, enumerable: true, configurable: true,
          });
        }
      }
      for (const retainedTable of retained) mergeTableEntries(config, retainedTable.path, retainedTable.entries);
      return stringify(config);
    };
  }
  return transforms;
}

function dedupeManifestEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const relativeEntry of entries) {
    const entry = relativeEntry.replaceAll('\\', '/');
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
  // An already-selected private home has no external configuration source. Preserve config
  // while the normal state owner detaches borrowed entries before private adoption.
  const selfSource = resolvePathForComparison(sourceRoot) === resolvePathForComparison(targetRoot);
  const overlay = input.descriptor.nativeHome?.materializedRootOverlay;
  if (overlay && !selfSource) {
    await linkDirectoryChildren({ source: sourceRoot, destination: targetRoot, exclude: overlay.privateEntries });
  }
  const sourceEnvironmentKey = input.descriptor.nativeHome?.sourceEnvironmentKey;
  const envOverrides: Record<string, string> = sourceEnvironmentKey ? { [sourceEnvironmentKey]: sourceRoot } : {};
  const diagnostics: ConnectedServicesMaterializationDiagnostic[] = [];
  const descriptorCopyTransformByEntry = selfSource ? {} : await buildDescriptorCopyTransformByEntry(input, diagnostics);
  const previousManifest = input.existingManifest ? {
    ...input.existingManifest,
    configEntries: dedupeManifestEntries(input.existingManifest.configEntries),
    stateEntries: dedupeManifestEntries(input.existingManifest.stateEntries),
  } : undefined;
  const configEntryNames = dedupeManifestEntries(input.configEntryNames ?? input.descriptor.config.entries.map((entry) => entry.path));
  const stateEntryNames = dedupeManifestEntries(input.stateEntryNames ?? input.descriptor.state.entries.map((entry) => entry.path));
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
  const configEntries: string[] = selfSource ? [...(previousManifest?.configEntries ?? [])] : [];
  let stateEntries: string[] = [];
  let effectiveStateMode = input.effectiveStateMode;
  let importedSessionFileMappings: ConnectedServiceStateSharingSessionFileMappingV1[] = [];
  const linkedStateEntries: Array<ConnectedServiceMaterializedStateObservationBinding['entries'][number]> = [];

  await mkdir(targetRoot, { recursive: true });

  const activeConfigEntries = input.configMode === 'isolated' ? [] : configEntryNames;
  if (!selfSource) await removeConnectedServiceStateSharingManifestEntries(targetRoot,
    (previousManifest?.configEntries ?? []).filter((entry) => !activeConfigEntries.includes(entry)));
  if (!selfSource) await removeLinkedConnectedServiceHomeEntries(targetRoot,
    configRemovalCandidates.filter((entry) => !activeConfigEntries.some((active) => active === entry || active.startsWith(`${entry}/`))));

  if (!selfSource && input.configMode !== 'isolated') {
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
      if (!sourceStat) {
        const transform = descriptorCopyTransformByEntry[entryName];
        if (!transform) {
          if (previousManifest?.configEntries.includes(entryName)) {
            await removeConnectedServiceStateSharingManifestEntries(targetRoot, [entryName]);
          }
          continue;
        }
        const destinationStat = await tryLstatConnectedServiceHomeEntry(destinationPath);
        if (!previousManifest?.configEntries.includes(entryName) || (destinationStat && !destinationStat.isFile())) {
          await prepareManagedConnectedServiceHomeDestination(destinationPath);
        }
        await writeConfigContentIfChanged(destinationPath, transform(''));
        configEntries.push(entryName);
        continue;
      }
      if (entryMode === 'linked' && await isConnectedServiceHomeEntryLinkedToSource(sourcePath, destinationPath)) {
        configEntries.push(entryName);
        continue;
      }
      const destinationStat = await tryLstatConnectedServiceHomeEntry(destinationPath);
      const destinationNeedsReplacement = destinationStat && (
        destinationStat.isSymbolicLink() || destinationStat.isDirectory() !== sourceStat.isDirectory()
      );
      const replaceManagedDestination = entryMode === 'linked' && Boolean(destinationStat)
        && !destinationNeedsReplacement && previousManifest?.configEntries.includes(entryName);
      if (destinationNeedsReplacement || !previousManifest?.configEntries.includes(entryName)) {
        await prepareManagedConnectedServiceHomeDestination(destinationPath);
      }
      if (entryMode === 'copied') {
        await copyEntryWithOptionalTransform({
          sourcePath,
          destinationPath,
          transform: input.copyTransformByEntry?.[entryName] ?? descriptorCopyTransformByEntry[entryName],
          removeMissingDestinationEntries: true,
        });
      } else {
        try {
          await linkConnectedServiceHomeEntry(sourcePath, destinationPath, sourceStat, { replaceManagedDestination });
        } catch {
          await copyEntryWithOptionalTransform({
            sourcePath,
            destinationPath,
            transform: input.copyTransformByEntry?.[entryName] ?? descriptorCopyTransformByEntry[entryName],
            removeMissingDestinationEntries: true,
          });
        }
      }
      configEntries.push(entryName);
    }
  }

  if (input.requestedStateMode === 'shared' && effectiveStateMode === 'shared') {
    const resolveStateSourceRoot = input.resolveStateSourceRoot ?? (() => sourceRoot);
    const degradePolicy = input.symlinkUnavailableDegradePolicy ?? input.descriptor.state.symlinkUnavailableDegradePolicy;
    try {
      for (const entryName of stateEntryNames) {
        const descriptorEntry = resolveDescriptorEntryForPath(input.descriptor, 'state', entryName);
        if (!descriptorEntry || descriptorEntry.requiresRealDirectory
          || (descriptorEntry.mode !== 'linked' && descriptorEntry.mode !== 'linked_or_copied')) continue;
        if (await isConnectedServiceHomeEntryLinkedToSource(
          join(resolve(resolveStateSourceRoot(entryName)), entryName), join(targetRoot, entryName),
        )) continue;
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

  // The manifest tracks sharing, not ownership of provider-written private state. Retain real
  // entries until the existing importer has adopted them; only obsolete links are detached.
  const activeStateEntries = input.requestedStateMode === 'shared' && effectiveStateMode === 'shared' ? stateEntryNames : [];
  const inactiveStateEntries = stateRemovalCandidates.filter((entry) => !activeStateEntries.includes(entry));
  await removeLinkedConnectedServiceHomeEntries(targetRoot, inactiveStateEntries);
  for (const entryName of inactiveStateEntries) {
    if (!previousManifest?.stateEntries.includes(entryName)) continue;
    const sourcePath = join(resolve(input.resolveStateSourceRoot?.(entryName) ?? sourceRoot), entryName);
    if (resolvePathForComparison(sourcePath) === resolvePathForComparison(join(targetRoot, entryName))) continue;
    if (await isConnectedServiceHomeEntryLinkedToSource(sourcePath, join(targetRoot, entryName))) {
      await rm(join(targetRoot, entryName), { force: true });
    }
  }

  // A native writer can retain an open file after its directory is moved aside for a
  // shared link. Re-adopt those later writes before replacement imports/verification;
  // retirement signals and turn completion are not filesystem synchronization points.
  const displacedStateRoots: ConnectedServiceSessionFileImportRoot[] = [];
  const mergeSharedStateFile = input.mergeSharedStateFile;
  for (const entryName of stateEntryNames) {
    const entry = resolveDescriptorEntryForPath(input.descriptor, 'state', entryName);
    if (!entry || (entry.mode !== 'linked' && entry.mode !== 'linked_or_copied')) continue;
    const destinationRoot = join(targetRoot, entryName);
    for (const sourceRoot of await listDisplacedConnectedServiceHomeDirectories(destinationRoot)) {
      displacedStateRoots.push({
        sourceRoot,
        destinationRoot,
        ...(mergeSharedStateFile ? {
          mergeSharedStateFile: (file) => mergeSharedStateFile({
            ...file, entryPath: `${entryName}/${file.entryPath}`,
          }),
        } : {}),
      });
    }
  }
  if (displacedStateRoots.length > 0) {
    await importConnectedServiceSessionFiles({ roots: displacedStateRoots });
  }

  if (input.requestedStateMode === 'shared' && effectiveStateMode === 'shared') {
    if (input.sessionImportRoots && input.sessionImportRoots.length > 0) {
      const importResult = await importConnectedServiceSessionFiles({ roots: input.sessionImportRoots.map(root => ({
        ...root,
        ...(input.mergeSharedStateFile && !root.mergeSharedStateFile
          ? { mergeSharedStateFile: input.mergeSharedStateFile } : {}),
      })) });
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
      if (descriptorEntry.createIfMissing === 'directory') {
        await mkdir(sourcePath, { recursive: true });
      }
      if (descriptorEntry.mode === 'env_redirect') {
        await mkdir(destinationPath, { recursive: true });
        if (descriptorEntry.envVar) envOverrides[descriptorEntry.envVar] = destinationPath;
        stateEntries.push(entryName);
        continue;
      }
      if (descriptorEntry.mode === 'copied') {
        const sourceStat = await tryStatConnectedServiceHomeEntry(sourcePath);
        if (!sourceStat) continue;
        await copyConnectedServiceHomeEntry(sourcePath, destinationPath);
        stateEntries.push(entryName);
        continue;
      }
      if (descriptorEntry.requiresRealDirectory) {
        const sourceStat = await tryStatConnectedServiceHomeEntry(sourcePath);
        if (sourceStat) await copyConnectedServiceHomeEntry(sourcePath, destinationPath);
        else await mkdir(destinationPath, { recursive: true });
        stateEntries.push(entryName);
        continue;
      }
      if (descriptorEntry.mode === 'linked' || descriptorEntry.mode === 'linked_or_copied') {
        if (!await materializeLinkedStateEntry({
          signal: input.signal,
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
        const [sourceEntryRoot, materializedEntryRoot] = await Promise.all([
          realpath(sourcePath), realpath(destinationPath),
        ]);
        if (resolvePathForComparison(sourceEntryRoot) === resolvePathForComparison(materializedEntryRoot)) {
          linkedStateEntries.push({ entryPath: entryName, sourceEntryRoot, materializedEntryPath: destinationPath });
        }
      }
    }
  } else {
    stateEntries = [];
  }

  const stateRootEnvironmentKey = input.descriptor.state.rootEnvironmentKey;
  let stateRootEnvironment: Record<string, string> | undefined;
  if (stateRootEnvironmentKey) {
    const configuredSourceRoot = input.nativeSourceContext.sourceEnv[stateRootEnvironmentKey]?.trim();
    const selectedRoot = effectiveStateMode === 'shared'
      ? configuredSourceRoot
        ? resolve(input.cwd, expandHomeDirPath(configuredSourceRoot, input.nativeSourceContext.sourceEnv))
        : sourceRoot
      : targetRoot;
    envOverrides[stateRootEnvironmentKey] = selectedRoot;
    stateRootEnvironment = { [stateRootEnvironmentKey]: effectiveStateMode === 'shared' ? selectedRoot : '.' };
  }

  const manifest: ConnectedServiceStateSharingManifestV1 = {
    v: 1,
    requestedStateMode: input.requestedStateMode,
    effectiveStateMode,
    ...(stateRootEnvironment ? { stateRootEnvironment } : {}),
    lastSyncAtMs: Date.now(),
    configEntries: dedupeManifestEntries(configEntries),
    stateEntries: dedupeManifestEntries(stateEntries),
    resumeStateEntries: dedupeManifestEntries(stateEntryNames),
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
    linkedStateEntries,
  };
}
