import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, win32 as win32Path } from 'node:path';

import {
    applyServicePlan,
    buildServiceDefinition,
    planServiceAction,
    resolveServiceBackend,
    type ServiceBackend,
    type ServiceSpec,
} from '../service/index.js';

import { checkRelayRuntimeHealth, resolveRelayRuntimeDefaults } from './relayRuntime.js';
import { resolveNonCollidingRelayPort } from './resolveNonCollidingRelayPort.js';
import {
    mergeSelfHostServerEnvText,
    parseEnvText,
    renderSelfHostServerEnvText,
    resolveConfiguredSelfHostBaseUrl,
} from './selfHostServerEnv.js';

const RELAY_RUNTIME_PERSISTENT_ROOT_ENTRIES = new Set([
    'config',
    'data',
    'logs',
    'self-host-state.json',
]);
const DEFAULT_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS = 120_000;
const MAX_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS = 600_000;

type LegacyRelayRuntimeInstallRootMigration = Readonly<{
    platform: NodeJS.Platform;
    backend: ServiceBackend;
    homeDir: string;
    migratedInstallRoot: string;
    originalInstallRoot: string;
    runServiceCommands: boolean;
    serverBinaryName: string;
    serviceName: string;
    shimPath: string;
    stdoutPath: string;
    stderrPath: string;
}>;

function tryParseJsonObject(text: string): Record<string, unknown> | null {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function relayRuntimeStateMatchesRequestedLane(params: Readonly<{
    state: Record<string, unknown>;
    channel: 'preview' | 'publicdev';
    mode: 'user' | 'system';
}>): boolean {
    const stateChannel = String(params.state.channel ?? '').trim();
    const stateMode = String(params.state.mode ?? '').trim();
    const channelMatches = stateChannel === params.channel
        || (params.channel === 'publicdev' && stateChannel === 'dev');
    const modeMatches = !stateMode || stateMode === params.mode;
    return channelMatches && modeMatches;
}

export async function shouldMigrateLegacyUnsuffixedRelayRuntimeInstallRoot(params: Readonly<{
    platform: NodeJS.Platform;
    mode: 'user' | 'system';
    channel: 'stable' | 'preview' | 'publicdev';
    homeDir: string;
    legacyInstallRoot?: string;
}>): Promise<boolean> {
    if (params.mode !== 'user') return false;
    if (params.channel === 'stable') return false;

    const defaults = resolveRelayRuntimeDefaults({
        platform: params.platform,
        mode: params.mode,
        channel: params.channel,
        homeDir: params.homeDir,
    });
    if (existsSync(defaults.installRoot)) return false;

    const legacyDefaults = resolveRelayRuntimeDefaults({
        platform: params.platform,
        mode: params.mode,
        channel: 'stable',
        homeDir: params.homeDir,
    });
    const legacyInstallRoot = String(params.legacyInstallRoot ?? '').trim() || legacyDefaults.installRoot;
    if (legacyInstallRoot === defaults.installRoot) return false;
    if (!existsSync(legacyInstallRoot)) return false;

    const legacyStatePath = join(legacyInstallRoot, 'self-host-state.json');
    if (!existsSync(legacyStatePath)) return true;

    const legacyStateText = await readFile(legacyStatePath, 'utf8').catch(() => '');
    const legacyState = tryParseJsonObject(legacyStateText);
    return Boolean(legacyState && relayRuntimeStateMatchesRequestedLane({
        state: legacyState,
        channel: params.channel,
        mode: params.mode,
    }));
}

async function migrateLegacyUnsuffixedRelayRuntimeInstallRootIfNeeded(params: Readonly<{
    platform: NodeJS.Platform;
    mode: 'user' | 'system';
    channel: 'stable' | 'preview' | 'publicdev';
    homeDir: string;
    runServiceCommands: boolean;
    legacyInstallRoot?: string;
}>): Promise<LegacyRelayRuntimeInstallRootMigration | null> {
    const shouldMigrate = await shouldMigrateLegacyUnsuffixedRelayRuntimeInstallRoot(params);
    if (!shouldMigrate) return null;

    const defaults = resolveRelayRuntimeDefaults({
        platform: params.platform,
        mode: params.mode,
        channel: params.channel,
        homeDir: params.homeDir,
    });
    const legacyDefaults = resolveRelayRuntimeDefaults({
        platform: params.platform,
        mode: params.mode,
        channel: 'stable',
        homeDir: params.homeDir,
    });
    const legacyInstallRoot = String(params.legacyInstallRoot ?? '').trim() || legacyDefaults.installRoot;

    if (params.runServiceCommands) {
        const backend: ServiceBackend = resolveServiceBackend({
            platform: params.platform,
            mode: params.mode,
        });
        const serverBinaryPath = join(
            legacyInstallRoot,
            'bin',
            params.platform === 'win32' ? 'happier-server.exe' : 'happier-server',
        );
        const stdoutPath = join(legacyInstallRoot, 'logs', 'server.out.log');
        const stderrPath = join(legacyInstallRoot, 'logs', 'server.err.log');

        const serviceNamesToStop = new Set([legacyDefaults.serviceName, defaults.serviceName]);
        for (const serviceName of serviceNamesToStop) {
            const spec = buildRelayRuntimeServiceSpec({
                serviceName,
                installRoot: legacyInstallRoot,
                serverBinaryPath,
                env: {},
                stdoutPath,
                stderrPath,
            });
            const definition = buildServiceDefinition({
                backend,
                homeDir: params.homeDir,
                spec,
            });
            const stopPlan = planServiceAction({
                backend,
                action: 'stop',
                label: spec.label,
                definitionPath: definition.path,
                persistent: true,
            });
            await applyServicePlan(stopPlan, { runCommands: true }).catch(() => undefined);
        }
    }

    await mkdir(dirname(defaults.installRoot), { recursive: true });
    await rename(legacyInstallRoot, defaults.installRoot);
    if (params.runServiceCommands) {
        const backend: ServiceBackend = resolveServiceBackend({
            platform: params.platform,
            mode: params.mode,
        });
        const serverBinaryPath = join(
            legacyInstallRoot,
            'bin',
            params.platform === 'win32' ? 'happier-server.exe' : 'happier-server',
        );
        const legacyServiceSpec = buildRelayRuntimeServiceSpec({
            serviceName: legacyDefaults.serviceName,
            installRoot: legacyInstallRoot,
            serverBinaryPath,
            env: {},
            stdoutPath: join(legacyInstallRoot, 'logs', 'server.out.log'),
            stderrPath: join(legacyInstallRoot, 'logs', 'server.err.log'),
        });
        const legacyServiceDefinition = buildServiceDefinition({
            backend,
            homeDir: params.homeDir,
            spec: legacyServiceSpec,
        });
        const uninstallLegacyPlan = planServiceAction({
            backend,
            action: 'uninstall',
            label: legacyServiceSpec.label,
            definitionPath: legacyServiceDefinition.path,
            persistent: true,
        });
        await applyServicePlan(uninstallLegacyPlan, { runCommands: true }).catch(() => undefined);
        await rm(legacyServiceDefinition.path, { force: true }).catch(() => undefined);
    }
    const serverBinaryName = params.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    return {
        platform: params.platform,
        migratedInstallRoot: defaults.installRoot,
        backend: resolveServiceBackend({
            platform: params.platform,
            mode: params.mode,
        }),
        homeDir: params.homeDir,
        originalInstallRoot: legacyInstallRoot,
        runServiceCommands: params.runServiceCommands !== false,
        serverBinaryName,
        serviceName: legacyDefaults.serviceName,
        shimPath: join(defaults.binDir, serverBinaryName),
        stdoutPath: join(legacyInstallRoot, 'logs', 'server.out.log'),
        stderrPath: join(legacyInstallRoot, 'logs', 'server.err.log'),
    };
}

async function rollbackLegacyUnsuffixedRelayRuntimeInstallRootMigration(
    migration: LegacyRelayRuntimeInstallRootMigration,
): Promise<void> {
    if (!existsSync(migration.migratedInstallRoot)) return;
    if (existsSync(migration.originalInstallRoot)) return;

    await mkdir(dirname(migration.originalInstallRoot), { recursive: true });
    await rename(migration.migratedInstallRoot, migration.originalInstallRoot);

    const restoredServerBinaryPath = join(migration.originalInstallRoot, 'bin', migration.serverBinaryName);
    if (existsSync(restoredServerBinaryPath)) {
        await installBinaryShim({
            platform: migration.platform,
            sourcePath: restoredServerBinaryPath,
            destPath: migration.shimPath,
        });
    }

    if (migration.runServiceCommands) {
        const restoreServiceSpec = buildRelayRuntimeServiceSpec({
            serviceName: migration.serviceName,
            installRoot: migration.originalInstallRoot,
            serverBinaryPath: restoredServerBinaryPath,
            env: {},
            stdoutPath: migration.stdoutPath,
            stderrPath: migration.stderrPath,
        });
        const restoreServiceDefinition = buildServiceDefinition({
            backend: migration.backend,
            homeDir: migration.homeDir,
            spec: restoreServiceSpec,
        });
        const restoreServicePlan = planServiceAction({
            backend: migration.backend,
            action: 'install',
            label: restoreServiceSpec.label,
            definitionPath: restoreServiceDefinition.path,
            definitionContents: restoreServiceDefinition.contents,
            persistent: true,
        });
        await applyServicePlan(restoreServicePlan, { runCommands: true }).catch(() => undefined);
    }
}

async function copyDirectoryContents(params: Readonly<{
    sourceDir: string;
    destDir: string;
}>): Promise<void> {
    await mkdir(params.destDir, { recursive: true });
    const entries = await readdir(params.sourceDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.name || entry.name === '.' || entry.name === '..') continue;
        if (entry.name.startsWith('._')) continue;
        const sourcePath = join(params.sourceDir, entry.name);
        const destPath = join(params.destDir, entry.name);
        if (entry.isDirectory()) {
            await copyDirectoryContents({ sourceDir: sourcePath, destDir: destPath });
            continue;
        }
        if (entry.isFile()) {
            await mkdir(dirname(destPath), { recursive: true });
            await copyFile(sourcePath, destPath);
            continue;
        }
        try {
            const info = await stat(sourcePath);
            if (info.isDirectory()) {
                await copyDirectoryContents({ sourceDir: sourcePath, destDir: destPath });
            } else if (info.isFile()) {
                await mkdir(dirname(destPath), { recursive: true });
                await copyFile(sourcePath, destPath);
            }
        } catch {
            continue;
        }
    }
}

function assertRootIfRequired(params: Readonly<{ platform: NodeJS.Platform; mode: 'user' | 'system' }>): void {
    if (params.mode !== 'system') return;
    if (params.platform === 'win32') return;
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== 0) {
        throw new Error('[relay-runtime] system install requires root privileges');
    }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function probePortOpen(params: Readonly<{ host: string; port: number; timeoutMs: number }>): Promise<boolean> {
    return await new Promise((resolve) => {
        const socket = createConnection({
            host: params.host,
            port: params.port,
        });
        const finish = (value: boolean): void => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(params.timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

async function fetchJson(params: Readonly<{ url: string; timeoutMs: number }>): Promise<{
    ok: boolean;
    status: number;
    body: unknown;
}> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
        const response = await fetch(params.url, {
            signal: controller.signal,
            headers: {
                accept: 'application/json',
            },
        });
        return {
            ok: response.ok,
            status: response.status,
            body: await response.json().catch(() => ({})),
        };
    } finally {
        clearTimeout(timeout);
    }
}

function resolveRelayRuntimeInstallHealthcheckTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = String(
        env.HAPPIER_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS
        ?? env.HAPPIER_RELAY_HOST_LOCAL_HEALTHCHECK_TIMEOUT_MS
        ?? '',
    ).trim();
    if (!raw) return DEFAULT_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS;
    }
    return Math.min(MAX_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS, Math.floor(parsed));
}

async function installBinaryShim(params: Readonly<{
    platform: NodeJS.Platform;
    sourcePath: string;
    destPath: string;
}>): Promise<void> {
    await mkdir(dirname(params.destPath), { recursive: true });
    await rm(params.destPath, { force: true });
    if (params.platform !== 'win32') {
        await symlink(params.sourcePath, params.destPath).catch(async () => {
            await copyFile(params.sourcePath, params.destPath);
            await chmod(params.destPath, 0o755).catch(() => undefined);
        });
        return;
    }
    await copyFile(params.sourcePath, params.destPath);
}

async function listRelayRuntimeManagedRootEntries(rootDir: string): Promise<string[]> {
    const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
    return entries
        .map((entry) => entry.name)
        .filter((name) => name && name !== '.' && name !== '..')
        .filter((name) => !name.startsWith('.relay-runtime-backup-'))
        .filter((name) => !RELAY_RUNTIME_PERSISTENT_ROOT_ENTRIES.has(name));
}

function mergeUniqueEntryNames(...lists: ReadonlyArray<readonly string[]>): string[] {
    const merged = new Set<string>();
    for (const list of lists) {
        for (const entryName of list) {
            if (entryName) {
                merged.add(entryName);
            }
        }
    }
    return [...merged];
}

async function copyNamedRootEntries(params: Readonly<{
    sourceDir: string;
    destDir: string;
    entryNames: readonly string[];
}>): Promise<void> {
    await mkdir(params.destDir, { recursive: true });
    for (const entryName of params.entryNames) {
        const sourcePath = join(params.sourceDir, entryName);
        const destPath = join(params.destDir, entryName);
        await rm(destPath, { recursive: true, force: true });

        const info = await stat(sourcePath).catch(() => null);
        if (!info) continue;

        if (info.isDirectory()) {
            await copyDirectoryContents({
                sourceDir: sourcePath,
                destDir: destPath,
            });
            continue;
        }

        if (info.isFile()) {
            await mkdir(dirname(destPath), { recursive: true });
            await copyFile(sourcePath, destPath);
        }
    }
}

async function clearNamedRootEntries(params: Readonly<{
    rootDir: string;
    entryNames: readonly string[];
}>): Promise<void> {
    for (const entryName of params.entryNames) {
        await rm(join(params.rootDir, entryName), { recursive: true, force: true });
    }
}

async function installPersistentPayload(params: Readonly<{
    sourceDir: string;
    destDir: string;
    executablePath: string;
}>): Promise<void> {
    await mkdir(params.destDir, { recursive: true });
    const desiredEntryNames = await listRelayRuntimeManagedRootEntries(params.sourceDir);
    const existingEntryNames = await listRelayRuntimeManagedRootEntries(params.destDir);
    const entryNamesToReplace = mergeUniqueEntryNames(desiredEntryNames, existingEntryNames);
    await clearNamedRootEntries({
        rootDir: params.destDir,
        entryNames: entryNamesToReplace,
    });
    await copyNamedRootEntries({
        sourceDir: params.sourceDir,
        destDir: params.destDir,
        entryNames: desiredEntryNames,
    });
    if (!existsSync(params.executablePath)) {
        throw new Error(`[relay-runtime] failed to install server binary (${params.executablePath})`);
    }
    await chmod(params.executablePath, 0o755).catch(() => undefined);
}

function resolveRelayRuntimePayloadRootFromServerBinaryPath(serverBinaryPath: string): string {
    const binaryPath = String(serverBinaryPath ?? '').trim();
    const binaryDir = dirname(binaryPath);
    return basename(binaryDir) === 'bin'
        ? dirname(binaryDir)
        : binaryDir;
}

async function prepareRelayRuntimePayloadForInstall(params: Readonly<{
    serverBinaryPath: string;
    serverBinaryName: string;
}>): Promise<Readonly<{
    payloadRoot: string;
    cleanupPath: string | null;
}>> {
    const payloadRoot = resolveRelayRuntimePayloadRootFromServerBinaryPath(params.serverBinaryPath);
    const serverBinaryIsNestedUnderBin = basename(dirname(params.serverBinaryPath)) === 'bin';
    if (serverBinaryIsNestedUnderBin) {
        return {
            payloadRoot,
            cleanupPath: null,
        };
    }

    const stagingRoot = await mkdtemp(join(tmpdir(), '.relay-runtime-payload-'));
    try {
        await copyDirectoryContents({
            sourceDir: payloadRoot,
            destDir: stagingRoot,
        });

        const stagedServerBinaryPath = join(stagingRoot, params.serverBinaryName);
        if (!existsSync(stagedServerBinaryPath)) {
            throw new Error(`[relay-runtime] staged server binary missing (${stagedServerBinaryPath})`);
        }

        const stagedBinDir = join(stagingRoot, 'bin');
        await mkdir(stagedBinDir, { recursive: true });
        await rename(stagedServerBinaryPath, join(stagedBinDir, params.serverBinaryName));

        for (const runtimeSidecarName of ['generated', 'node_modules']) {
            const stagedSidecarPath = join(stagingRoot, runtimeSidecarName);
            if (!existsSync(stagedSidecarPath)) continue;
            await rename(stagedSidecarPath, join(stagedBinDir, runtimeSidecarName));
        }
    } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }

    return {
        payloadRoot: stagingRoot,
        cleanupPath: stagingRoot,
    };
}

async function backupRelayRuntimeInstallState(params: Readonly<{
    installRoot: string;
    payloadDir: string;
    payloadEntryNames: readonly string[];
    serverBinaryName: string;
    migrationsDir: string;
    envPath: string;
    statePath: string;
}>): Promise<Readonly<{
    backupRoot: string;
    payloadBackupDir: string | null;
    migrationsBackupDir: string | null;
    previousEnvText: string | null;
    previousStateText: string | null;
}>> {
    const backupRoot = await mkdtemp(join(dirname(params.installRoot), '.relay-runtime-backup-'));
    const payloadBackupDir = join(backupRoot, 'payload');
    const migrationsBackupDir = join(backupRoot, 'migrations');
    const existingPayloadEntryNames = params.payloadEntryNames.filter((entryName) => existsSync(join(params.payloadDir, entryName)));
    const hasPayload = existingPayloadEntryNames.length > 0;
    const hasMigrations = existsSync(params.migrationsDir);
    if (hasPayload) {
        await copyNamedRootEntries({
            sourceDir: params.payloadDir,
            destDir: payloadBackupDir,
            entryNames: existingPayloadEntryNames,
        });
    }
    if (hasMigrations) {
        await copyDirectoryContents({
            sourceDir: params.migrationsDir,
            destDir: migrationsBackupDir,
        });
    }
    return {
        backupRoot,
        payloadBackupDir: hasPayload ? payloadBackupDir : null,
        migrationsBackupDir: hasMigrations ? migrationsBackupDir : null,
        previousEnvText: existsSync(params.envPath)
            ? await readFile(params.envPath, 'utf8').catch(() => null)
            : null,
        previousStateText: existsSync(params.statePath)
            ? await readFile(params.statePath, 'utf8').catch(() => null)
            : null,
    };
}

async function restoreRelayRuntimeInstallState(params: Readonly<{
    platform: NodeJS.Platform;
    payloadDir: string;
    payloadEntryNames: readonly string[];
    shimPath: string;
    migrationsDir: string;
    envPath: string;
    statePath: string;
    payloadBackupDir: string | null;
    migrationsBackupDir: string | null;
    previousEnvText: string | null;
    previousStateText: string | null;
}>): Promise<void> {
    await clearNamedRootEntries({
        rootDir: params.payloadDir,
        entryNames: params.payloadEntryNames,
    });
    if (params.payloadBackupDir) {
        const backupEntryNames = await listRelayRuntimeManagedRootEntries(params.payloadBackupDir);
        await copyNamedRootEntries({
            sourceDir: params.payloadBackupDir,
            destDir: params.payloadDir,
            entryNames: backupEntryNames,
        });
    }
    await rm(params.shimPath, { force: true });
    if (params.payloadBackupDir) {
        const serverBinaryName = params.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
        const sourcePath = join(params.payloadDir, 'bin', serverBinaryName);
        if (existsSync(sourcePath)) {
            await installBinaryShim({
                platform: params.platform,
                sourcePath,
                destPath: params.shimPath,
            });
        }
    }
    await rm(params.migrationsDir, { recursive: true, force: true });
    if (params.migrationsBackupDir) {
        await copyDirectoryContents({
            sourceDir: params.migrationsBackupDir,
            destDir: params.migrationsDir,
        });
    }
    if (typeof params.previousEnvText === 'string') {
        await mkdir(dirname(params.envPath), { recursive: true });
        await writeFile(params.envPath, params.previousEnvText, 'utf8');
    } else {
        await rm(params.envPath, { force: true });
    }
    if (typeof params.previousStateText === 'string') {
        await mkdir(dirname(params.statePath), { recursive: true });
        await writeFile(params.statePath, params.previousStateText, 'utf8');
        return;
    }
    await rm(params.statePath, { force: true });
}

function buildRelayRuntimeServiceSpec(params: Readonly<{
    serviceName: string;
    installRoot: string;
    serverBinaryPath: string;
    env: Record<string, string>;
    stdoutPath: string;
    stderrPath: string;
}>): ServiceSpec {
    return {
        label: params.serviceName,
        description: `Happier Relay Runtime (${params.serviceName})`,
        programArgs: [params.serverBinaryPath],
        workingDirectory: params.installRoot,
        env: params.env,
        stdoutPath: params.stdoutPath,
        stderrPath: params.stderrPath,
    };
}

export async function installOrUpdateRelayRuntimeLocal(params: Readonly<{
    serverBinaryPath: string;
    channel: 'stable' | 'preview' | 'publicdev';
    mode: 'user' | 'system';
    env?: Record<string, string>;
    platform?: NodeJS.Platform;
    homeDir?: string;
    arch?: string;
    version?: string | null;
    serviceNameOverride?: string;
    legacyInstallRoot?: string;
    runServiceCommands?: boolean;
    skipHealthCheck?: boolean;
}>): Promise<Readonly<{ baseUrl: string; version: string | null }>> {
    const platform = (String(params.platform ?? '').trim() || process.platform) as NodeJS.Platform;
    const homeDir = String(params.homeDir ?? '').trim() || homedir();
    const arch = String(params.arch ?? '').trim() || process.arch;
    const mode = params.mode === 'system' ? 'system' : 'user';

    assertRootIfRequired({ platform, mode });

    const defaults = resolveRelayRuntimeDefaults({
        platform,
        mode,
        channel: params.channel,
        homeDir,
    });
    const serviceName = String(params.serviceNameOverride ?? '').trim() || defaults.serviceName;
    const serverBinaryName = platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    const installServerBinaryPath = join(defaults.installRoot, 'bin', serverBinaryName);
    const statePath = join(defaults.installRoot, 'self-host-state.json');
    const configEnvPath = join(defaults.configDir, 'server.env');
    const filesDir = join(defaults.dataDir, 'files');
    const dbDir = join(defaults.dataDir, 'pglite');
    const migrationsDir = join(defaults.dataDir, 'migrations', 'sqlite');
    const stdoutPath = join(defaults.logDir, 'server.out.log');
    const stderrPath = join(defaults.logDir, 'server.err.log');
    const backend: ServiceBackend = resolveServiceBackend({
        platform,
        mode,
    });
    const previousServiceSpec = buildRelayRuntimeServiceSpec({
        serviceName,
        installRoot: defaults.installRoot,
        serverBinaryPath: installServerBinaryPath,
        env: {},
        stdoutPath,
        stderrPath,
    });
    const previousServiceDefinition = buildServiceDefinition({
        backend,
        homeDir,
        spec: previousServiceSpec,
    });
    const previousServiceDefinitionExisted = existsSync(previousServiceDefinition.path);

    if (!existsSync(params.serverBinaryPath)) {
        throw new Error('[relay-runtime] server binary not found');
    }

    const preparedPayload = await prepareRelayRuntimePayloadForInstall({
        serverBinaryPath: params.serverBinaryPath,
        serverBinaryName,
    });
    const desiredPayloadEntryNames = await listRelayRuntimeManagedRootEntries(preparedPayload.payloadRoot);
    let payloadEntryNames = desiredPayloadEntryNames;
    let legacyRootMigration: LegacyRelayRuntimeInstallRootMigration | null = null;
    let previousInstallState: Awaited<ReturnType<typeof backupRelayRuntimeInstallState>> | null = null;

    try {
        legacyRootMigration = await migrateLegacyUnsuffixedRelayRuntimeInstallRootIfNeeded({
            platform,
            mode,
            channel: params.channel,
            homeDir,
            runServiceCommands: params.runServiceCommands !== false,
            legacyInstallRoot: params.legacyInstallRoot,
        });

        await mkdir(defaults.installRoot, { recursive: true });
        await mkdir(defaults.configDir, { recursive: true });
        await mkdir(defaults.dataDir, { recursive: true });
        await mkdir(filesDir, { recursive: true });
        await mkdir(dbDir, { recursive: true });
        await mkdir(defaults.logDir, { recursive: true });

        const existingPayloadEntryNames = await listRelayRuntimeManagedRootEntries(defaults.installRoot);
        payloadEntryNames = mergeUniqueEntryNames(desiredPayloadEntryNames, existingPayloadEntryNames);
        previousInstallState = await backupRelayRuntimeInstallState({
            installRoot: defaults.installRoot,
            payloadDir: defaults.installRoot,
            payloadEntryNames,
            serverBinaryName,
            migrationsDir,
            envPath: configEnvPath,
            statePath,
        });

        if (params.runServiceCommands !== false) {
            const stopServiceSpec = buildRelayRuntimeServiceSpec({
                serviceName,
                installRoot: defaults.installRoot,
                serverBinaryPath: installServerBinaryPath,
                env: {},
                stdoutPath,
                stderrPath,
            });
            const stopDefinition = buildServiceDefinition({
                backend,
                homeDir,
                spec: stopServiceSpec,
            });
            const stopPlan = planServiceAction({
                backend,
                action: 'stop',
                label: stopServiceSpec.label,
                definitionPath: stopDefinition.path,
                persistent: true,
            });
            await applyServicePlan(stopPlan, {
                runCommands: true,
            });
        }

        const payloadRoot = preparedPayload.payloadRoot;
        const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations');
        await mkdir(migrationsDir, { recursive: true });
        if (existsSync(migrationsSourceDir)) {
            await copyDirectoryContents({
                sourceDir: migrationsSourceDir,
                destDir: migrationsDir,
            });
        }

        await installPersistentPayload({
            sourceDir: payloadRoot,
            destDir: defaults.installRoot,
            executablePath: installServerBinaryPath,
        });
        await installBinaryShim({
            platform,
            sourcePath: installServerBinaryPath,
            destPath: join(defaults.binDir, serverBinaryName),
        });

        const uiDir = platform === 'win32'
            ? win32Path.join(defaults.installRoot, 'ui-web', 'current')
            : join(defaults.installRoot, 'ui-web', 'current');

        // Upstream callers (relayHostEngine.installLocal) inject the resolved
        // PORT into params.env when they pick a non-default port to avoid
        // sibling-channel collisions. Fall back here to an independent
        // collision-avoidance pass for callers that invoke this function
        // directly (tests, SSH installers, tooling) — the helper is cheap and
        // idempotent when params.env.PORT is already set.
        const existingEnvText = existsSync(configEnvPath) ? await readFile(configEnvPath, 'utf8').catch(() => '') : '';
        const existingPortRaw = existingEnvText ? String((parseEnvText(existingEnvText).PORT ?? '')).trim() : '';
        const overridePortRaw = String((params.env ?? {}).PORT ?? '').trim();
        const configuredPortRaw = overridePortRaw || existingPortRaw;
        const configuredPort = configuredPortRaw
          ? (Number.isInteger(Number.parseInt(configuredPortRaw, 10)) ? Number.parseInt(configuredPortRaw, 10) : null)
          : null;
        const resolvedPort = await resolveNonCollidingRelayPort({
          platform,
          mode,
          channel: params.channel,
          homeDir,
          defaultPort: defaults.serverPort,
          configuredPort,
        });

        const baseEnvText = renderSelfHostServerEnvText({
            port: resolvedPort,
            host: defaults.serverHost,
            dataDir: defaults.dataDir,
            filesDir,
            dbDir,
            uiDir,
            serverBinDir: dirname(installServerBinaryPath),
            arch,
            platform,
        });
        const envText = mergeSelfHostServerEnvText({
            baseEnvText,
            existingEnvText,
            overrides: params.env,
        });
        await writeFile(configEnvPath, envText, 'utf8');
        const env = parseEnvText(envText);

        const serviceSpec = buildRelayRuntimeServiceSpec({
            serviceName,
            installRoot: defaults.installRoot,
            serverBinaryPath: installServerBinaryPath,
            env,
            stdoutPath,
            stderrPath,
        });
        const definition = buildServiceDefinition({
            backend,
            homeDir,
            spec: serviceSpec,
        });
        const plan = planServiceAction({
            backend,
            action: 'install',
            label: serviceSpec.label,
            definitionPath: definition.path,
            definitionContents: definition.contents,
            persistent: true,
        });
        await applyServicePlan(plan, {
            runCommands: params.runServiceCommands !== false,
        });

        const state = {
            channel: params.channel,
            mode,
            version: typeof params.version === 'string' && params.version.trim() ? params.version.trim() : null,
            updatedAt: new Date().toISOString(),
        };
        await writeJsonFile(statePath, state);

        const baseUrl = resolveConfiguredSelfHostBaseUrl({
            fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
            envText,
        });
        if (params.skipHealthCheck !== true && params.runServiceCommands !== false) {
            const baseUrlObject = new URL(baseUrl);
            const result = await checkRelayRuntimeHealth({
                host: baseUrlObject.hostname,
                port: Number.parseInt(baseUrlObject.port, 10),
                timeoutMs: resolveRelayRuntimeInstallHealthcheckTimeoutMs(),
                probePortOpen: async ({ host, port, timeoutMs }) => await probePortOpen({ host, port, timeoutMs }),
                fetchJson: async ({ url, timeoutMs }) => await fetchJson({ url, timeoutMs }),
            });
            if (!result.reachable) {
                throw new Error(`[relay-runtime] relay runtime did not become healthy (${result.url})`);
            }
        }

        return {
            baseUrl,
            version: state.version,
        };
    } catch (error) {
        if (previousInstallState) {
            await restoreRelayRuntimeInstallState({
                platform,
                payloadDir: defaults.installRoot,
                payloadEntryNames,
                shimPath: join(defaults.binDir, serverBinaryName),
                migrationsDir,
                envPath: configEnvPath,
                statePath,
                payloadBackupDir: previousInstallState.payloadBackupDir,
                migrationsBackupDir: previousInstallState.migrationsBackupDir,
                previousEnvText: previousInstallState.previousEnvText,
                previousStateText: previousInstallState.previousStateText,
            });

            const canRestoreServiceDefinition = previousServiceDefinitionExisted
                && previousInstallState.payloadBackupDir
                && existsSync(join(previousInstallState.payloadBackupDir, 'bin', serverBinaryName));
            if (canRestoreServiceDefinition) {
                const restoreEnv = parseEnvText(previousInstallState.previousEnvText ?? '');
                const restoreSpec = buildRelayRuntimeServiceSpec({
                    serviceName,
                    installRoot: defaults.installRoot,
                    serverBinaryPath: installServerBinaryPath,
                    env: restoreEnv,
                    stdoutPath,
                    stderrPath,
                });
                const restoreDefinition = buildServiceDefinition({
                    backend,
                    homeDir,
                    spec: restoreSpec,
                });
                const restorePlan = planServiceAction({
                    backend,
                    action: 'install',
                    label: restoreSpec.label,
                    definitionPath: restoreDefinition.path,
                    definitionContents: restoreDefinition.contents,
                    persistent: true,
                });
                await applyServicePlan(restorePlan, {
                    runCommands: params.runServiceCommands !== false,
                });
            } else if (params.runServiceCommands !== false) {
                const rollbackSpec = buildRelayRuntimeServiceSpec({
                    serviceName,
                    installRoot: defaults.installRoot,
                    serverBinaryPath: installServerBinaryPath,
                    env: {},
                    stdoutPath,
                    stderrPath,
                });
                const rollbackDefinition = buildServiceDefinition({
                    backend,
                    homeDir,
                    spec: rollbackSpec,
                });
                const rollbackPlan = planServiceAction({
                    backend,
                    action: 'uninstall',
                    label: rollbackSpec.label,
                    definitionPath: rollbackDefinition.path,
                    persistent: true,
                });
                await applyServicePlan(rollbackPlan, {
                    runCommands: true,
                });
                if (!previousServiceDefinitionExisted) {
                    await rm(rollbackDefinition.path, { force: true }).catch(() => undefined);
                }
            }
        }
        if (legacyRootMigration) {
            if (previousInstallState) {
                await rm(previousInstallState.backupRoot, { recursive: true, force: true }).catch(() => undefined);
            }
            await rollbackLegacyUnsuffixedRelayRuntimeInstallRootMigration(legacyRootMigration);
        }
        throw error;
    } finally {
        if (preparedPayload.cleanupPath) {
            await rm(preparedPayload.cleanupPath, { recursive: true, force: true }).catch(() => undefined);
        }
        if (previousInstallState) {
            await rm(previousInstallState.backupRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
