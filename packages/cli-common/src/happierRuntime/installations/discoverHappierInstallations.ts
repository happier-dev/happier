import { accessSync, constants as fsConstants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  getReleaseRingCatalogEntry,
  PUBLIC_RELEASE_RING_IDS,
  resolvePublicReleaseRingIdForCliInvokerName,
  type PublicReleaseRingId,
  type PublicReleaseRingLabel,
} from '@happier-dev/release-runtime/releaseRings';

import {
  FIRST_PARTY_COMPONENT_IDS,
  resolveInstalledFirstPartyComponentPaths,
  resolveFirstPartyInstallLayout,
  resolveRelayRuntimeDefaults,
  type FirstPartyComponentId,
} from '../../firstPartyRuntime/index.js';
import { resolveWindowsCommandOnPath } from '../../process/index.js';
import type { HappierActiveInvocation, HappierInstallation, HappierInstallationInventory, HappierInstallationSource } from '../types.js';
import { isHappierRuntimePathWithinRoot, normalizeHappierRuntimePath } from '../runtimePathMatching.js';

type DiscoverFs = Readonly<{
  access?: typeof access;
  readFile?: typeof readFile;
  realpath?: typeof realpath;
}>;

type DiscoverCommandRunner = Readonly<{
  run?: (input: Readonly<{ cmd: string; args: readonly string[] }>) => string | null;
}>;

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

async function pathExists(path: string, fsApi: DiscoverFs): Promise<boolean> {
  try {
    await (fsApi.access ?? access)(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonVersion(packageJsonPath: string, fsApi: DiscoverFs): Promise<string | null> {
  try {
    const raw = await (fsApi.readFile ?? readFile)(packageJsonPath, 'utf8');
    const parsed = JSON.parse(String(raw)) as { version?: unknown };
    const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
    return version || null;
  } catch {
    return null;
  }
}

async function readTrimmedText(path: string, fsApi: DiscoverFs): Promise<string | null> {
  try {
    const value = String(await (fsApi.readFile ?? readFile)(path, 'utf8')).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function resolveRealPathSafe(path: string, fsApi: DiscoverFs): Promise<string | null> {
  try {
    return await (fsApi.realpath ?? realpath)(path);
  } catch {
    return null;
  }
}

function installationComponentsFor(componentId: FirstPartyComponentId): string[] {
  if (componentId === 'happier-cli') {
    return ['happier-cli', 'happier-daemon'];
  }
  return [componentId];
}

function createManagedInstallationId(params: Readonly<{
  ring: PublicReleaseRingLabel | null;
  currentPath: string;
}>): string {
  return `managed:${params.ring ?? 'unknown'}:${params.currentPath}`;
}

function inferVersionFromManagedRealPath(realPath: string | null): string | null {
  const normalized = String(realPath ?? '').trim();
  if (!normalized) {
    return null;
  }
  const versionId = basename(normalized);
  if (!versionId || versionId === 'current' || versionId === 'previous') {
    return null;
  }
  const parentDir = basename(dirname(normalized));
  return parentDir === 'versions' ? versionId : null;
}

async function resolveManagedInstallationVersion(params: Readonly<{
  currentPath: string;
  installRoot: string;
  realPath: string | null;
  fsApi: DiscoverFs;
}>): Promise<string | null> {
  return (
    await readJsonVersion(join(params.currentPath, 'package.json'), params.fsApi)
    ?? await readJsonVersion(join(params.realPath ?? '', 'package.json'), params.fsApi)
    ?? await readTrimmedText(join(params.installRoot, 'current.version'), params.fsApi)
    ?? inferVersionFromManagedRealPath(params.realPath)
  );
}

async function discoverManagedInstallationEntries(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  fsApi: DiscoverFs;
}>): Promise<HappierInstallation[]> {
  const entries: HappierInstallation[] = [];
  const componentIds: FirstPartyComponentId[] = ['happier-cli', 'hstack', 'happier-server', 'mutagen-engine'];
  for (const componentId of componentIds) {
    for (const channel of PUBLIC_RELEASE_RING_IDS) {
      const paths = resolveInstalledFirstPartyComponentPaths({
        componentId,
        channel,
        processEnv: params.processEnv,
      });
      const hasCurrent = await pathExists(paths.currentPath, params.fsApi);
      const hasBinary = await pathExists(paths.binaryPath, params.fsApi);
      const hasEntrypoint = paths.nodeEntrypointPath ? await pathExists(paths.nodeEntrypointPath, params.fsApi) : false;
      if (!hasCurrent && !hasBinary && !hasEntrypoint) {
        continue;
      }
      const installLayout = resolveFirstPartyInstallLayout({ componentId, channel, processEnv: params.processEnv });
      const realPath = await resolveRealPathSafe(paths.currentPath, params.fsApi);
      const version = await resolveManagedInstallationVersion({
        currentPath: paths.currentPath,
        installRoot: installLayout.installRoot,
        realPath,
        fsApi: params.fsApi,
      });
      const ring = getReleaseRingCatalogEntry(channel).publicLabel;
      entries.push({
        id: createManagedInstallationId({ ring, currentPath: paths.currentPath }),
        source: componentId === 'hstack' ? 'stackManaged' : 'firstPartyManaged',
        components: installationComponentsFor(componentId),
        ring,
        version,
        path: paths.currentPath,
        realPath,
        shimName: basename(paths.shimPaths[0] ?? '') || null,
        onPath: false,
        pathOrder: null,
        managedRoot: installLayout.installRoot,
        packageManager: null,
      });
    }
  }
  return entries;
}

type SelfHostRuntimeState = Readonly<{
  channel: PublicReleaseRingId | null;
  mode: 'user' | 'system' | null;
  version: string | null;
}>;

async function readSelfHostRuntimeState(params: Readonly<{
  installRoot: string;
  fsApi: DiscoverFs;
}>): Promise<SelfHostRuntimeState | null> {
  try {
    const raw = await (params.fsApi.readFile ?? readFile)(join(params.installRoot, 'self-host-state.json'), 'utf8');
    const parsed = JSON.parse(String(raw)) as {
      channel?: unknown;
      mode?: unknown;
      version?: unknown;
    };
    const rawChannel = String(parsed.channel ?? '').trim();
    const channel = rawChannel === 'stable' || rawChannel === 'preview' || rawChannel === 'publicdev'
      ? rawChannel
      : null;
    const rawMode = String(parsed.mode ?? '').trim();
    const mode = rawMode === 'user' || rawMode === 'system' ? rawMode : null;
    const version = typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : null;
    return { channel, mode, version };
  } catch {
    return null;
  }
}

async function discoverSelfHostInstallationEntries(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  fsApi: DiscoverFs;
}>): Promise<HappierInstallation[]> {
  const entries: HappierInstallation[] = [];
  const platform = process.platform;
  const executableName = platform === 'win32' ? 'happier-server.exe' : 'happier-server';

  for (const channel of PUBLIC_RELEASE_RING_IDS) {
    for (const mode of ['user', 'system'] as const) {
      const defaults = resolveRelayRuntimeDefaults({
        channel,
        mode,
        platform,
        homeDir: params.processEnv.HOME ?? params.processEnv.USERPROFILE ?? '',
      });
      const installRoot = defaults.installRoot;
      const binaryPath = join(installRoot, 'bin', executableName);
      const hasState = await pathExists(join(installRoot, 'self-host-state.json'), params.fsApi);
      const hasBinary = await pathExists(binaryPath, params.fsApi);
      if (!hasState && !hasBinary) {
        continue;
      }

      const state = await readSelfHostRuntimeState({ installRoot, fsApi: params.fsApi });
      const resolvedChannel = state?.channel ?? channel;
      const ring = getReleaseRingCatalogEntry(resolvedChannel).publicLabel;
      const shimPath = join(defaults.binDir, executableName);
      const hasShim = await pathExists(shimPath, params.fsApi);

      entries.push({
        id: `selfHostManaged:${mode}:${ring}:${installRoot}`,
        source: 'selfHostManaged',
        components: ['happier-server'],
        ring,
        version: state?.version ?? null,
        path: installRoot,
        realPath: await resolveRealPathSafe(installRoot, params.fsApi),
        shimName: hasShim ? 'happier-server' : null,
        onPath: false,
        pathOrder: null,
        managedRoot: installRoot,
        packageManager: null,
      });
    }
  }

  return entries;
}

function resolveCommandPathsOnPath(command: string, processEnv: NodeJS.ProcessEnv): string[] {
  const pathEnv = String(processEnv.PATH ?? '');
  const dirs = pathEnv.split(delimiter).map((value) => value.trim()).filter(Boolean);
  const isWindows = process.platform === 'win32';
  const extensions = isWindows
    ? Array.from(new Set([
      '',
      ...String(processEnv.PATHEXT ?? (processEnv as NodeJS.ProcessEnv & { Pathext?: string }).Pathext ?? '')
        .split(';')
        .map((value) => value.trim())
        .filter(Boolean),
    ]))
    : [''];
  const seen = new Set<string>();
  const matches: string[] = [];

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = isWindows && extension && !command.toLowerCase().endsWith(extension.toLowerCase())
        ? join(dir, `${command}${extension}`)
        : join(dir, command);
      try {
        accessSync(candidate, isWindows ? fsConstants.F_OK : fsConstants.F_OK | fsConstants.X_OK);
        const resolvedCandidate = resolve(candidate);
        if (!seen.has(resolvedCandidate)) {
          seen.add(resolvedCandidate);
          matches.push(resolvedCandidate);
        }
      } catch {
        continue;
      }
    }
  }
  if (matches.length === 0 && process.platform === 'win32') {
    const fallback = resolveWindowsCommandOnPath(command, processEnv);
    if (fallback) matches.push(fallback);
  }
  return matches;
}

function defaultCommandRunner(input: Readonly<{ cmd: string; args: readonly string[] }>): string | null {
  try {
    const result = spawnSync(input.cmd, [...input.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
      encoding: 'utf8',
    });
    const output = `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`.trim();
    return output || null;
  } catch {
    return null;
  }
}

function inferRingFromVersion(version: string | null): PublicReleaseRingLabel | null {
  const normalized = String(version ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('preview')) return 'preview';
  if (normalized.includes('dev')) return 'dev';
  return 'stable';
}

async function discoverNpmInstallationEntries(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  fsApi: DiscoverFs;
  commands?: DiscoverCommandRunner;
}>): Promise<HappierInstallation[]> {
  const runner = params.commands?.run ?? defaultCommandRunner;
  const npmExecutable = resolveCommandPathsOnPath('npm', params.processEnv)[0];
  if (!npmExecutable && params.commands?.run === undefined) {
    return [];
  }

  const prefix = String(runner({ cmd: npmExecutable || 'npm', args: ['prefix', '-g'] }) ?? '').trim();
  const npmRoot = String(runner({ cmd: npmExecutable || 'npm', args: ['root', '-g'] }) ?? '').trim();
  if (!prefix && !npmRoot) {
    return [];
  }

  const packageRoots = [
    {
      packageDir: npmRoot ? join(npmRoot, '@happier-dev', 'cli') : '',
      components: ['happier-cli', 'happier-daemon'],
    },
    {
      packageDir: npmRoot ? join(npmRoot, '@happier-dev', 'stack') : '',
      components: ['hstack'],
    },
  ];

  const entries: HappierInstallation[] = [];
  for (const packageRoot of packageRoots) {
    if (!packageRoot.packageDir || !(await pathExists(packageRoot.packageDir, params.fsApi))) {
      continue;
    }
    const version = await readJsonVersion(join(packageRoot.packageDir, 'package.json'), params.fsApi);
    entries.push({
      id: `npmGlobal:${packageRoot.packageDir}`,
      source: 'npmGlobal',
      components: [...packageRoot.components],
      ring: packageRoot.components.includes('hstack') ? null : inferRingFromVersion(version),
      version,
      path: packageRoot.packageDir,
      realPath: await resolveRealPathSafe(packageRoot.packageDir, params.fsApi),
      shimName: null,
      onPath: false,
      pathOrder: null,
      managedRoot: prefix || null,
      packageManager: packageRoot.components.includes('happier-cli')
        ? {
          kind: 'npmGlobal',
          executablePath: npmExecutable || null,
          packageName: '@happier-dev/cli',
        }
        : {
          kind: 'npmGlobal',
          executablePath: npmExecutable || null,
          packageName: '@happier-dev/stack',
        },
    });
  }
  return entries;
}

async function findNearestPackageVersion(startPath: string, fsApi: DiscoverFs): Promise<string | null> {
  let currentDir = dirname(startPath);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(currentDir, 'package.json');
    const version = await readJsonVersion(candidate, fsApi);
    if (version) {
      return version;
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  return null;
}

function classifyPathInstallation(params: Readonly<{
  commandName: string;
  commandPath: string;
  realPath: string | null;
  managedInstallations: readonly HappierInstallation[];
}>): Readonly<{
  source: HappierInstallationSource;
  ring: PublicReleaseRingLabel | null;
  components: string[];
  managedMatch: HappierInstallation | null;
}> {
  const resolvedPath = params.realPath ?? params.commandPath;
  const managedMatch = params.managedInstallations.find((entry) => {
    const candidates = [entry.path, entry.realPath].filter((value): value is string => Boolean(value));
    return candidates.some((candidate) => resolvedPath === candidate || resolvedPath.startsWith(`${candidate}/`));
  }) ?? null;
  if (managedMatch) {
    return {
      source: managedMatch.source,
      ring: managedMatch.ring,
      components: managedMatch.components,
      managedMatch,
    };
  }
  if (resolvedPath.includes('/node_modules/@happier-dev/cli/') || resolvedPath.includes('\\node_modules\\@happier-dev\\cli\\')) {
    return { source: 'npmGlobal', ring: params.commandName === 'hprev' ? 'preview' : params.commandName === 'hdev' ? 'dev' : 'stable', components: ['happier-cli', 'happier-daemon'], managedMatch: null };
  }
  if (resolvedPath.includes('/node_modules/@happier-dev/stack/') || resolvedPath.includes('\\node_modules\\@happier-dev\\stack\\')) {
    return { source: 'npmGlobal', ring: null, components: ['hstack'], managedMatch: null };
  }
  if (resolvedPath.endsWith('/apps/cli/bin/happier-dev.mjs') || resolvedPath.endsWith('\\apps\\cli\\bin\\happier-dev.mjs')) {
    return {
      source: 'fromSource',
      ring: 'dev',
      components: ['happier-cli', 'happier-daemon'],
      managedMatch: null,
    };
  }
  if (resolvedPath.endsWith('/apps/cli/bin/happier.mjs') || resolvedPath.endsWith('\\apps\\cli\\bin\\happier.mjs')) {
    return {
      source: 'fromSource',
      ring: (() => {
        const ringId = resolvePublicReleaseRingIdForCliInvokerName(params.commandName);
        return ringId ? getReleaseRingCatalogEntry(ringId).publicLabel : 'stable';
      })(),
      components: ['happier-cli', 'happier-daemon'],
      managedMatch: null,
    };
  }
  if (resolvedPath.endsWith('/apps/stack/bin/hstack.mjs') || resolvedPath.endsWith('\\apps\\stack\\bin\\hstack.mjs')) {
    return { source: 'fromSource', ring: null, components: ['hstack'], managedMatch: null };
  }
  return {
    source: 'pathBinary',
    ring: params.commandName === 'hprev' ? 'preview' : params.commandName === 'hdev' ? 'dev' : params.commandName === 'happier' ? 'stable' : null,
    components: params.commandName === 'hstack' ? ['hstack'] : params.commandName === 'happier-server' ? ['happier-server'] : ['happier-cli', 'happier-daemon'],
    managedMatch: null,
  };
}

async function discoverPathInstallationEntries(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  fsApi: DiscoverFs;
  managedInstallations: readonly HappierInstallation[];
}>): Promise<HappierInstallation[]> {
  const commandNames = ['happier', 'hprev', 'hdev', 'hstack', 'happier-server'] as const;
  const results: HappierInstallation[] = [];
  for (const commandName of commandNames) {
    const commandPaths = resolveCommandPathsOnPath(commandName, params.processEnv);
    for (const commandPath of commandPaths) {
      const pathOrder = commandPaths.indexOf(commandPath);
      const realPath = await resolveRealPathSafe(commandPath, params.fsApi);
      const classified = classifyPathInstallation({
        commandName,
        commandPath,
        realPath,
        managedInstallations: params.managedInstallations,
      });
      if (classified.managedMatch) {
        results.push({
          ...classified.managedMatch,
          onPath: true,
          shimName: commandName,
          pathOrder,
        });
        continue;
      }
      results.push({
        id: `${classified.source}:${realPath ?? commandPath}`,
        source: classified.source,
        components: classified.components,
        ring: classified.ring,
        version: await findNearestPackageVersion(realPath ?? commandPath, params.fsApi),
        path: commandPath,
        realPath,
        shimName: commandName,
        onPath: true,
        pathOrder,
        managedRoot: null,
        packageManager: null,
      });
    }
  }
  return results;
}

function installationContainsInvocationPath(entry: HappierInstallation, invocationPath: string): boolean {
  const normalizedInvocationPath = normalizeHappierRuntimePath(invocationPath);
  if (!normalizedInvocationPath) {
    return false;
  }
  const roots = [entry.path, entry.realPath]
    .map(normalizeHappierRuntimePath)
    .filter((value): value is string => Boolean(value));
  return roots.some((root) => isHappierRuntimePathWithinRoot(normalizedInvocationPath, root));
}

function scoreActiveInvocationMatch(entry: HappierInstallation, invocationPath: string): number {
  const normalizedInvocationPath = normalizeHappierRuntimePath(invocationPath);
  if (!normalizedInvocationPath) {
    return Number.NEGATIVE_INFINITY;
  }

  const normalizedPath = normalizeHappierRuntimePath(entry.path);
  const normalizedRealPath = normalizeHappierRuntimePath(entry.realPath);
  const roots = [normalizedPath, normalizedRealPath].filter((value): value is string => Boolean(value));
  const longestContainingRootLength = roots
    .filter((root) => isHappierRuntimePathWithinRoot(normalizedInvocationPath, root))
    .reduce((longest, root) => Math.max(longest, root.length), 0);

  return (
    (entry.packageManager ? 1_000_000 : 0)
    + (entry.onPath ? 0 : 100_000)
    + longestContainingRootLength
  );
}

async function buildActiveInvocation(params: Readonly<{
  invokedPath: string | null;
  invokerName: string | null;
  installations: readonly HappierInstallation[];
  fsApi: DiscoverFs;
}>): Promise<HappierActiveInvocation | null> {
  const invokedPath = String(params.invokedPath ?? '').trim();
  const invokerName = String(params.invokerName ?? '').trim() || null;
  if (!invokedPath && !invokerName) {
    return null;
  }

  if (invokedPath) {
    const invokedRealPath = await resolveRealPathSafe(invokedPath, params.fsApi);
    const directMatches = params.installations.filter((entry) => {
      const candidates = [entry.path, entry.realPath].filter((value): value is string => Boolean(value));
      return candidates.includes(invokedPath)
        || (invokedRealPath ? candidates.includes(invokedRealPath) : false)
        || installationContainsInvocationPath(entry, invokedRealPath ?? invokedPath);
    });
    const directMatch = directMatches
      .sort((left, right) => (
        scoreActiveInvocationMatch(right, invokedRealPath ?? invokedPath)
        - scoreActiveInvocationMatch(left, invokedRealPath ?? invokedPath)
      ))[0] ?? null;

    if (directMatch) {
      const invocationRing = directMatch.source === 'npmGlobal' && invokerName
        ? (() => {
            const ringId = resolvePublicReleaseRingIdForCliInvokerName(invokerName);
            return ringId ? getReleaseRingCatalogEntry(ringId).publicLabel : directMatch.ring ?? null;
          })()
        : directMatch.ring ?? null;
      return {
        path: invokedPath,
        realPath: invokedRealPath ?? directMatch.realPath ?? null,
        invokerName,
        ring: invocationRing,
        version: directMatch.version ?? null,
        installationId: directMatch.id ?? null,
      };
    }

    const classified = classifyPathInstallation({
      commandName: invokerName ?? basename(invokedPath).replace(/\.exe$/i, '').replace(/\.m?js$/i, ''),
      commandPath: invokedPath,
      realPath: invokedRealPath,
      managedInstallations: params.installations,
    });

    if (classified.managedMatch) {
      return {
        path: invokedPath,
        realPath: classified.managedMatch.realPath ?? invokedRealPath,
        invokerName,
        ring: classified.managedMatch.ring ?? null,
        version: classified.managedMatch.version ?? null,
        installationId: classified.managedMatch.id ?? null,
      };
    }

    return {
      path: invokedPath,
      realPath: invokedRealPath,
      invokerName,
      ring: classified.ring ?? null,
      version: await findNearestPackageVersion(invokedRealPath ?? invokedPath, params.fsApi),
      installationId: `${classified.source}:${invokedRealPath ?? invokedPath}`,
    };
  }

  const installation = params.installations.find((entry) => invokerName && entry.shimName === invokerName) ?? null;
  return {
    path: invokedPath || installation?.path || '',
    realPath: installation?.realPath ?? null,
    invokerName,
    ring: installation?.ring ?? null,
    version: installation?.version ?? null,
    installationId: installation?.id ?? null,
  };
}

export async function discoverHappierInstallations(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  invokedPath?: string | null;
  invokerName?: string | null;
  fs?: DiscoverFs;
  commands?: DiscoverCommandRunner;
}> = {}): Promise<HappierInstallationInventory> {
  const processEnv = params.processEnv ?? process.env;
  const fsApi = params.fs ?? {};
  const firstPartyManagedInstallations = await discoverManagedInstallationEntries({ processEnv, fsApi });
  const selfHostInstallations = await discoverSelfHostInstallationEntries({ processEnv, fsApi });
  const managedInstallations = uniqueById([...firstPartyManagedInstallations, ...selfHostInstallations]);
  const pathInstallations = await discoverPathInstallationEntries({
    processEnv,
    fsApi,
    managedInstallations,
  });
  const npmInstallations = await discoverNpmInstallationEntries({
    processEnv,
    fsApi,
    commands: params.commands,
  });
  const installations = uniqueById([...managedInstallations, ...pathInstallations, ...npmInstallations])
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    activeInvocation: await buildActiveInvocation({
      invokedPath: params.invokedPath ?? null,
      invokerName: params.invokerName ?? null,
      installations,
      fsApi,
    }),
    installations,
  };
}
