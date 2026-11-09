import { createReadStream, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { spawnBackgroundSync } from '../process/spawnBackgroundSync.js';
import { runCommandStreaming } from '../process/runCommandStreaming.js';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, win32 as win32Path } from 'node:path';

import {
    applyServicePlan,
    buildServiceDefinition,
    planServiceAction,
    preflightServiceInstallAssets,
    resolveServiceBackend,
    type ServiceBackend,
    type ServiceSpec,
} from '../service/index.js';

import { checkRelayRuntimeHealth, resolveRelayRuntimeDefaults } from './relayRuntime.js';
import { removeRuntimePayloadPath } from './copyRuntimePayloadTree.js';
import {
    mergeSelfHostServerEnvText,
    parseEnvText,
    renderSelfHostServerEnvText,
    resolveSelfHostServerMigrationPlan,
    resolveConfiguredSelfHostBaseUrl,
} from './selfHostServerEnv.js';
import {
    relocateServerRuntimeArtifactClosure,
    resolveServerRuntimePrismaEngineFileName,
    resolveServerRuntimePayloadRootFromBinaryPath,
} from './serverRuntimeArtifactLayout.js';
import { copyDirectoryTreePreservingSymlinks } from './copyDirectoryTreePreservingSymlinks.js';
import { resolveNonCollidingRelayPort } from './resolveNonCollidingRelayPort.js';
import { computeUiDeploymentDigest, resolveUiDeploymentIdentity } from './uiDeploymentIdentity.js';
import { isPidPresent } from '../process/processLiveness.js';
import {
    assertPersonalHomeEnvironmentKeys,
    createPersonalHomeRuntimeSpec,
    parsePersonalHomeRuntimePurpose,
    renderPersonalHomeRuntimeEnv,
    type ManagedRelayPurpose,
} from './personalHome/personalHomeRuntimeSpec.js';
import { withPersonalHomeOperationAdmission } from './personalHome/operationAdmission.js';
import { assertPersonalHomeServerArtifactCapability } from './personalHome/artifactContract.js';
import { readPersonalHomeIdentityValueFromSqlite, validateCanonicalPersonalHomeLayout } from './personalHome/productionAdapters.js';
import { resolvePersonalHomeRuntimeLayout } from './personalHome/layout.js';
import type { PersonalHomeRuntimeLayout } from './personalHome/layout.js';
import type { PersonalHomeRestorePoint } from './personalHome/restorePoint.js';
import type { PersonalHomeRestoreHooks } from './personalHome/restore.js';
import { syncPersonalHomeParentDirectory, syncPersonalHomeTree } from './personalHome/durableFile.js';
import { parsePersonalHomeAuthenticatedReadiness, type PersonalHomeAuthenticatedReadiness } from './personalHome/readiness.js';
import {
    readPersonalHomeUpdateRecoveryRecord,
    removePersonalHomeUpdateRecoveryRecord,
    resolvePersonalHomeUpdateRecoveryReferences,
    writePersonalHomeUpdateRecoveryRecord,
    type PersonalHomeUpdateCandidateState,
    type PersonalHomeUpdateRecoveryRecordV1,
} from './personalHome/updateRecovery.js';
import { readEffectivePersonalHomeSignupPolicy } from './personalHomeSignupPolicy.js';
import { withFirstPartyPayloadMutationLock } from './withFirstPartyPayloadMutationLock.js';
import {
    PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY,
    PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY_ENV,
    RELAY_RUNTIME_IRREVERSIBLE_MIGRATIONS,
} from './serverRuntimeContract.js';

export {
    PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY,
    PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY_ENV,
    RELAY_RUNTIME_IRREVERSIBLE_MIGRATIONS,
} from './serverRuntimeContract.js';

const RELAY_RUNTIME_MANAGED_ROOT_ENTRIES = Object.freeze([
    'bin',
    'ui-web',
] as const);
const DEFAULT_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS = 120_000;
const MAX_RELAY_RUNTIME_INSTALL_HEALTHCHECK_TIMEOUT_MS = 600_000;
const RELAY_RUNTIME_STARTUP_RECEIPT_WAIT_MS = 10_000;
const RELAY_RUNTIME_STARTUP_RECEIPT_POLL_MS = 100;
const SERVER_STARTUP_RECEIPT_PATH_ENV = 'HAPPIER_SERVER_STARTUP_RECEIPT_PATH';
const SERVER_STARTUP_RECEIPT_NONCE_ENV = 'HAPPIER_SERVER_STARTUP_RECEIPT_NONCE';
const MANAGED_RELAY_PURPOSE_ENV = 'HAPPIER_MANAGED_RELAY_PURPOSE';
const MIGRATION_NOT_APPLIED_EXIT_CODE = 3;

type MigrationAppliedCheckRunner = (params: Readonly<{
    command: string;
    args: readonly string[];
    cwd: string;
    env: Record<string, string>;
}>) => Promise<Readonly<{
    error?: Error;
    status: number | null;
    signal: NodeJS.Signals | null;
    stderr?: string;
}>>;

export type RelayRuntimeInstallRollbackFailure = Readonly<{
    phase: 'candidate_stop' | 'irreversible_boundary' | 'runtime_restore' | 'personal_home_restore' | 'service_restore' | 'install_root_restore' | 'artifact_disposal';
    error: unknown;
}>;

export class RelayRuntimeInstallRollbackIncompleteError extends Error {
    readonly code = 'RELAY_RUNTIME_INSTALL_ROLLBACK_INCOMPLETE' as const;

    constructor(
        readonly originalError: unknown,
        readonly rollbackFailures: readonly RelayRuntimeInstallRollbackFailure[],
        readonly recoveryArtifacts: Readonly<{
            runtimeBackupRoot?: string;
            personalHomeRestorePointPath?: string;
            personalHomeRestoreRollbackPaths?: readonly string[];
        }>,
    ) {
        super('[relay-runtime] candidate activation failed and rollback could not be completed; recovery artifacts were preserved', {
            cause: new AggregateError(
                [originalError, ...rollbackFailures.map((failure) => failure.error)],
                'Relay runtime install and rollback failures',
            ),
        });
        this.name = 'RelayRuntimeInstallRollbackIncompleteError';
    }
}

type RelayRuntimeInstallRootMigration = Readonly<{
    platform: NodeJS.Platform;
    backend?: ServiceBackend;
    homeDir?: string;
    migratedInstallRoot: string;
    originalInstallRoot: string;
    runServiceCommands?: boolean;
    serverBinaryName: string;
    serviceName?: string;
    shimPath: string;
    stdoutPath?: string;
    stderrPath?: string;
}>;

type RelayRuntimeInstallRootMigrationSource = Readonly<{
    kind: 'owned-current-lane' | 'legacy-unsuffixed';
    sourceInstallRoot: string;
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

function normalizeComparablePathKey(value: string | null | undefined): string | null {
    const trimmed = String(value ?? '').trim().replace(/[\\/]+$/, '');
    return trimmed || null;
}

function parseSystemdUnitWorkingDirectory(unitText: string): string | null {
    const lines = String(unitText ?? '').split(/\r?\n/u);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
        if (!trimmed.toLowerCase().startsWith('workingdirectory=')) continue;
        const value = trimmed.slice('WorkingDirectory='.length).trim();
        return value || null;
    }
    return null;
}

function xmlUnescape(value: string): string {
    return String(value ?? '')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&gt;', '>')
        .replaceAll('&lt;', '<')
        .replaceAll('&amp;', '&');
}

function parseLaunchdPlistWorkingDirectory(plistText: string): string | null {
    const match = String(plistText ?? '').match(/<key>\s*WorkingDirectory\s*<\/key>\s*<string>([\s\S]*?)<\/string>/iu);
    const value = match?.[1]?.trim();
    return value ? xmlUnescape(value) : null;
}

function parseServiceDefinitionWorkingDirectory(params: Readonly<{
    backend: 'systemd-user' | 'systemd-system' | 'launchd-user' | 'launchd-system';
    definitionText: string;
}>): string | null {
    if (params.backend === 'systemd-user' || params.backend === 'systemd-system') {
        return parseSystemdUnitWorkingDirectory(params.definitionText);
    }
    if (params.backend === 'launchd-user' || params.backend === 'launchd-system') {
        return parseLaunchdPlistWorkingDirectory(params.definitionText);
    }
    return null;
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
    if (!existsSync(legacyDefaults.installRoot)) return false;

    const legacyStatePath = join(legacyDefaults.installRoot, 'self-host-state.json');
    if (!existsSync(legacyStatePath)) return true;

    const legacyStateText = await readFile(legacyStatePath, 'utf8').catch(() => '');
    const legacyState = tryParseJsonObject(legacyStateText);
    return Boolean(legacyState && relayRuntimeStateMatchesRequestedLane({
        state: legacyState,
        channel: params.channel,
        mode: params.mode,
    }));
}

async function resolveOwnedCurrentLaneRelayRuntimeInstallRootMigrationSource(params: Readonly<{
    platform: NodeJS.Platform;
    mode: 'user' | 'system';
    channel: 'stable' | 'preview' | 'publicdev';
    homeDir: string;
}>): Promise<string | null> {
    if (params.mode !== 'user' || params.channel === 'stable') return null;

    const defaults = resolveRelayRuntimeDefaults(params);
    if (existsSync(defaults.installRoot)) return null;

    const backend: ServiceBackend = resolveServiceBackend({
        platform: params.platform,
        mode: params.mode,
    });
    if (backend !== 'systemd-user' && backend !== 'launchd-user') return null;

    const serverBinaryName = params.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    const serviceDefinition = buildServiceDefinition({
        backend,
        homeDir: params.homeDir,
        spec: buildRelayRuntimeServiceSpec({
            serviceName: defaults.serviceName,
            installRoot: defaults.installRoot,
            serverBinaryPath: join(defaults.installRoot, 'bin', serverBinaryName),
            env: {},
            stdoutPath: join(defaults.logDir, 'server.out.log'),
            stderrPath: join(defaults.logDir, 'server.err.log'),
        }),
    });
    if (!existsSync(serviceDefinition.path)) return null;

    const definitionText = await readFile(serviceDefinition.path, 'utf8').catch(() => '');
    const ownedInstallRoot = definitionText.trim()
        ? normalizeComparablePathKey(parseServiceDefinitionWorkingDirectory({ backend, definitionText }))
        : null;
    const canonicalInstallRoot = normalizeComparablePathKey(defaults.installRoot);
    if (!ownedInstallRoot || !canonicalInstallRoot || ownedInstallRoot === canonicalInstallRoot) return null;
    return existsSync(ownedInstallRoot) ? ownedInstallRoot : null;
}

async function resolveRelayRuntimeInstallRootMigrationSource(params: Readonly<{
    platform: NodeJS.Platform;
    mode: 'user' | 'system';
    channel: 'stable' | 'preview' | 'publicdev';
    homeDir: string;
}>): Promise<RelayRuntimeInstallRootMigrationSource | null> {
    const ownedInstallRoot = await resolveOwnedCurrentLaneRelayRuntimeInstallRootMigrationSource(params);
    if (ownedInstallRoot) {
        return { kind: 'owned-current-lane', sourceInstallRoot: ownedInstallRoot };
    }
    if (!(await shouldMigrateLegacyUnsuffixedRelayRuntimeInstallRoot(params))) return null;
    return {
        kind: 'legacy-unsuffixed',
        sourceInstallRoot: resolveRelayRuntimeDefaults({ ...params, channel: 'stable' }).installRoot,
    };
}

async function resolvePersonalHomeRuntimeLayoutForInstallRoot(params: Readonly<{
    platform: NodeJS.Platform;
    mode: 'user' | 'system';
    channel: 'stable' | 'preview' | 'publicdev';
    homeDir: string;
    installRoot: string;
}>): Promise<PersonalHomeRuntimeLayout> {
    const defaults = resolveRelayRuntimeDefaults(params);
    const configDir = params.mode === 'user' ? join(params.installRoot, 'config') : defaults.configDir;
    const logsDir = params.mode === 'user' ? join(params.installRoot, 'logs') : defaults.logDir;
    const envPath = join(configDir, 'server.env');
    const envText = existsSync(envPath) ? await readFile(envPath, 'utf8').catch(() => '') : '';
    const persistedEnv = parseEnvText(envText);
    return resolvePersonalHomeRuntimeLayout({
        env: {
            ...persistedEnv,
            HAPPIER_SELF_HOST_INSTALL_ROOT: params.installRoot,
            HAPPIER_SELF_HOST_CONFIG_DIR: configDir,
            HAPPIER_SELF_HOST_LOG_DIR: logsDir,
            ...(
                persistedEnv.HAPPIER_SERVER_LIGHT_DATA_DIR || persistedEnv.HAPPY_SERVER_LIGHT_DATA_DIR
                    ? {}
                    : { HAPPIER_SERVER_LIGHT_DATA_DIR: params.mode === 'user' ? join(params.installRoot, 'data') : defaults.dataDir }
            ),
        },
        homeDir: params.homeDir,
        platform: params.platform,
        mode: params.mode,
        channel: params.channel,
    });
}

async function migrateOwnedCurrentLaneRelayRuntimeInstallRootIfNeeded(params: Readonly<{
    platform: NodeJS.Platform;
    mode: 'user' | 'system';
    channel: 'stable' | 'preview' | 'publicdev';
    homeDir: string;
    runServiceCommands: boolean;
    sourceInstallRoot?: string;
    assertPersonalHomeStopped?: () => Promise<void>;
}>): Promise<RelayRuntimeInstallRootMigration | null> {
    const defaults = resolveRelayRuntimeDefaults({
        platform: params.platform,
        mode: params.mode,
        channel: params.channel,
        homeDir: params.homeDir,
    });
    if (existsSync(defaults.installRoot)) return null;
    const ownedInstallRootKey = normalizeComparablePathKey(
        params.sourceInstallRoot
        ?? await resolveOwnedCurrentLaneRelayRuntimeInstallRootMigrationSource(params),
    );
    if (!ownedInstallRootKey || !existsSync(ownedInstallRootKey)) return null;
    const backend = resolveServiceBackend({ platform: params.platform, mode: params.mode });
    if (backend !== 'systemd-user' && backend !== 'launchd-user') return null;
    const serverBinaryName = params.platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    if (params.assertPersonalHomeStopped) {
        if (params.runServiceCommands) {
            const stopSpec = buildRelayRuntimeServiceSpec({
                serviceName: defaults.serviceName,
                installRoot: ownedInstallRootKey,
                serverBinaryPath: join(ownedInstallRootKey, 'bin', serverBinaryName),
                env: {},
                stdoutPath: join(ownedInstallRootKey, 'logs', 'server.out.log'),
                stderrPath: join(ownedInstallRootKey, 'logs', 'server.err.log'),
            });
            const stopDefinition = buildServiceDefinition({ backend, homeDir: params.homeDir, spec: stopSpec });
            const stopPlan = planServiceAction({
                backend,
                action: 'stop',
                label: stopSpec.label,
                definitionPath: stopDefinition.path,
                persistent: true,
            });
            await applyServicePlan(stopPlan, { runCommands: true }).catch(() => undefined);
        }
        await params.assertPersonalHomeStopped();
    }

    await mkdir(dirname(defaults.installRoot), { recursive: true });
    await rename(ownedInstallRootKey, defaults.installRoot);

    return {
        platform: params.platform,
        migratedInstallRoot: defaults.installRoot,
        originalInstallRoot: ownedInstallRootKey,
        serverBinaryName,
        shimPath: join(defaults.binDir, serverBinaryName),
    };
}

async function migrateLegacyUnsuffixedRelayRuntimeInstallRootIfNeeded(params: Readonly<{
    platform: NodeJS.Platform;
    mode: 'user' | 'system';
    channel: 'stable' | 'preview' | 'publicdev';
    homeDir: string;
    runServiceCommands: boolean;
    sourceInstallRoot?: string;
    assertPersonalHomeStopped?: () => Promise<void>;
}>): Promise<RelayRuntimeInstallRootMigration | null> {
    const defaults = resolveRelayRuntimeDefaults({
        platform: params.platform,
        mode: params.mode,
        channel: params.channel,
        homeDir: params.homeDir,
    });
    if (existsSync(defaults.installRoot)) return null;

    const legacyDefaults = resolveRelayRuntimeDefaults({
        platform: params.platform,
        mode: params.mode,
        channel: 'stable',
        homeDir: params.homeDir,
    });
    const sourceInstallRoot = normalizeComparablePathKey(params.sourceInstallRoot ?? legacyDefaults.installRoot);
    if (!sourceInstallRoot || !existsSync(sourceInstallRoot)) return null;

    if (params.runServiceCommands) {
        const backend: ServiceBackend = resolveServiceBackend({
            platform: params.platform,
            mode: params.mode,
        });
        const serverBinaryPath = join(
            legacyDefaults.installRoot,
            'bin',
            params.platform === 'win32' ? 'happier-server.exe' : 'happier-server',
        );
        const stdoutPath = join(legacyDefaults.logDir, 'server.out.log');
        const stderrPath = join(legacyDefaults.logDir, 'server.err.log');

        const serviceNamesToStop = new Set([legacyDefaults.serviceName, defaults.serviceName]);
        for (const serviceName of serviceNamesToStop) {
            const spec = buildRelayRuntimeServiceSpec({
                serviceName,
                installRoot: legacyDefaults.installRoot,
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
    await params.assertPersonalHomeStopped?.();

    await mkdir(dirname(defaults.installRoot), { recursive: true });
    await rename(sourceInstallRoot, defaults.installRoot);
    if (params.runServiceCommands) {
        const backend: ServiceBackend = resolveServiceBackend({
            platform: params.platform,
            mode: params.mode,
        });
        const serverBinaryPath = join(
            legacyDefaults.installRoot,
            'bin',
            params.platform === 'win32' ? 'happier-server.exe' : 'happier-server',
        );
        const legacyServiceSpec = buildRelayRuntimeServiceSpec({
            serviceName: legacyDefaults.serviceName,
            installRoot: legacyDefaults.installRoot,
            serverBinaryPath,
            env: {},
            stdoutPath: join(legacyDefaults.logDir, 'server.out.log'),
            stderrPath: join(legacyDefaults.logDir, 'server.err.log'),
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
        backend: resolveServiceBackend({
            platform: params.platform,
            mode: params.mode,
        }),
        homeDir: params.homeDir,
        migratedInstallRoot: defaults.installRoot,
        originalInstallRoot: sourceInstallRoot,
        runServiceCommands: params.runServiceCommands !== false,
        serverBinaryName,
        serviceName: legacyDefaults.serviceName,
        shimPath: join(defaults.binDir, serverBinaryName),
        stdoutPath: join(legacyDefaults.logDir, 'server.out.log'),
        stderrPath: join(legacyDefaults.logDir, 'server.err.log'),
    };
}

async function rollbackRelayRuntimeInstallRootMigration(
    migration: RelayRuntimeInstallRootMigration,
): Promise<void> {
    if (!existsSync(migration.migratedInstallRoot)) return;
    if (existsSync(migration.originalInstallRoot)) return;

    await mkdir(dirname(migration.originalInstallRoot), { recursive: true });
    await rename(migration.migratedInstallRoot, migration.originalInstallRoot);

    const restoredServerBinaryPath = join(migration.originalInstallRoot, 'bin', migration.serverBinaryName);
    const hasRestoredServerBinary = existsSync(restoredServerBinaryPath);
    if (hasRestoredServerBinary) {
        await installBinaryShim({
            platform: migration.platform,
            sourcePath: restoredServerBinaryPath,
            destPath: migration.shimPath,
        });
    }

    if (
        migration.runServiceCommands
        && hasRestoredServerBinary
        && migration.backend
        && migration.homeDir
        && migration.serviceName
        && migration.stdoutPath
        && migration.stderrPath
    ) {
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
    // Some payload roots are symlinked (for example `current -> versions/x.y.z`).
    // The staging destination directory is created via `mkdtemp(...)` and already exists, so we must
    // dereference the root symlink and copy the resolved directory contents into the existing folder.
    const resolvedSourceDir = await realpath(params.sourceDir).catch(() => params.sourceDir);
    await copyDirectoryTreePreservingSymlinks({
        sourceDir: resolvedSourceDir,
        destinationDir: params.destDir,
        shouldSkipRelativePath: (relativePath) => relativePath.split(/[\\/]/u).some((segment) => segment.startsWith('._')),
    });
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

export async function waitForRelayRuntimeStartupReceipt(params: Readonly<{
    path: string;
    nonce: string;
}>): Promise<Readonly<{ nonce: string; pid: number; host: string; port: number; readiness: PersonalHomeAuthenticatedReadiness | null }>> {
    const deadline = Date.now() + RELAY_RUNTIME_STARTUP_RECEIPT_WAIT_MS;
    while (Date.now() <= deadline) {
        const receipt = await readFile(params.path, 'utf8')
            .then(tryParseJsonObject)
            .catch(() => null);
        const nonce = typeof receipt?.nonce === 'string' ? receipt.nonce : '';
        const pid = typeof receipt?.pid === 'number' && Number.isSafeInteger(receipt.pid)
            ? receipt.pid
            : 0;
        const rawHost = typeof receipt?.host === 'string' ? receipt.host.trim().toLowerCase() : '';
        const host = rawHost.startsWith('::ffff:') ? rawHost.slice('::ffff:'.length) : rawHost;
        const port = typeof receipt?.port === 'number' && Number.isInteger(receipt.port)
            ? receipt.port
            : 0;
        const readiness = parsePersonalHomeAuthenticatedReadiness(receipt?.personalHomeReadiness);
        if (nonce === params.nonce && pid > 0 && isPidPresent(pid) && host && port >= 1 && port <= 65535) {
            return { nonce, pid, host, port, readiness };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, RELAY_RUNTIME_STARTUP_RECEIPT_POLL_MS));
    }
    throw new Error('[relay-runtime] relay runtime startup attestation did not arrive');
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
    const result: string[] = [];
    for (const entryName of RELAY_RUNTIME_MANAGED_ROOT_ENTRIES) {
        if (await lstat(join(rootDir, entryName)).catch(() => null)) result.push(entryName);
    }
    return result;
}

async function computeRelayRuntimePayloadDigest(rootDir: string): Promise<string> {
    const digest = createHash('sha256');
    digest.update('happier:relay-runtime-payload:v1\0');

    const visit = async (relativeDirectory: string): Promise<void> => {
        const directoryPath = relativeDirectory ? join(rootDir, relativeDirectory) : rootDir;
        const entries = await readdir(directoryPath, { withFileTypes: true });
        entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const entry of entries) {
            const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
            const normalizedPath = relativePath.replaceAll('\\', '/');
            const entryPath = join(rootDir, relativePath);
            if (entry.isDirectory()) {
                digest.update(`dir\0${normalizedPath}\0`);
                await visit(relativePath);
                continue;
            }
            if (entry.isSymbolicLink()) {
                digest.update(`link\0${normalizedPath}\0${await readlink(entryPath)}\0`);
                continue;
            }
            if (!entry.isFile()) throw new Error(`[relay-runtime] unsupported managed payload entry (${entryPath})`);
            digest.update(`file\0${normalizedPath}\0`);
            for await (const chunk of createReadStream(entryPath)) digest.update(chunk);
            digest.update('\0');
        }
    };

    await visit('');
    return `sha256:${digest.digest('hex')}`;
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
        await removeRuntimePayloadPath(destPath);

        const info = await lstat(sourcePath).catch(() => null);
        if (!info) continue;

        if (info.isDirectory()) {
            await copyDirectoryContents({
                sourceDir: sourcePath,
                destDir: destPath,
            });
            continue;
        }

        if (info.isSymbolicLink()) {
            const linkTarget = await readlink(sourcePath).catch(() => null);
            if (!linkTarget) continue;
            await mkdir(dirname(destPath), { recursive: true });
            const targetInfo = await stat(join(dirname(sourcePath), linkTarget)).catch(() => null);
            await symlink(linkTarget, destPath, process.platform === 'win32' && targetInfo?.isDirectory() ? 'junction' : 'file');
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
    await removeRuntimePayloadPath(join(params.rootDir, entryName));
  }
}

/**
 * Remove only the executable payload from a relay install.
 *
 * The config and data roots intentionally live below installRoot for user-mode
 * relays, so uninstall must never recursively remove that root. The persistent
 * root allowlist is shared with install/update state handling above.
 */
export async function uninstallRelayRuntimePayloadLocal(params: Readonly<{
  installRoot: string;
  shimPath: string;
  statePath: string;
  logDir: string;
  retainedPurpose?: ManagedRelayPurpose;
  retainedVersion?: string;
}>): Promise<void> {
  const entryNames = await listRelayRuntimeManagedRootEntries(params.installRoot);
  await clearNamedRootEntries({
    rootDir: params.installRoot,
    entryNames,
  });
  await removeRuntimePayloadPath(params.shimPath);
  if (params.retainedPurpose) {
    await writeJsonFile(params.statePath, {
      ...(params.retainedVersion ? { retainedPersonalHomeVersion: params.retainedVersion } : {}),
      purpose: params.retainedPurpose,
    });
  } else {
    await rm(params.statePath, { force: true });
  }
  await rm(params.logDir, { recursive: true, force: true });
}

async function installPersistentPayload(params: Readonly<{
    sourceDir: string;
    destDir: string;
    executablePath: string;
}>): Promise<void> {
    await mkdir(params.destDir, { recursive: true });
    const existingEntryNames = await listRelayRuntimeManagedRootEntries(params.destDir);
    await clearNamedRootEntries({
        rootDir: params.destDir,
        entryNames: existingEntryNames,
    });
    const entryNames = await listRelayRuntimeManagedRootEntries(params.sourceDir);
    await copyNamedRootEntries({
        sourceDir: params.sourceDir,
        destDir: params.destDir,
        entryNames,
    });
    if (!existsSync(params.executablePath)) {
        throw new Error(`[relay-runtime] failed to install server binary (${params.executablePath})`);
    }
    await chmod(params.executablePath, 0o755).catch(() => undefined);
}

async function prepareRelayRuntimePayloadForInstall(params: Readonly<{
    serverBinaryPath: string;
    serverBinaryName: string;
}>): Promise<Readonly<{
    payloadRoot: string;
    cleanupPath: string | null;
}>> {
    const payloadRoot = resolveServerRuntimePayloadRootFromBinaryPath(params.serverBinaryPath);
    const serverBinaryIsNestedUnderBin = dirname(params.serverBinaryPath) === join(payloadRoot, 'bin');
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

        await relocateServerRuntimeArtifactClosure({
            payloadRoot: stagingRoot,
            platform: params.serverBinaryName.endsWith('.exe') ? 'win32' : process.platform,
        });
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
    serverBinaryName: string;
    migrationsDir: string;
    envPath: string;
    statePath: string;
}>): Promise<Readonly<{
    backupRoot: string;
    payloadBackupDir: string | null;
    hasRestorableServerBinary: boolean;
    migrationsBackupDir: string | null;
    previousEnvText: string | null;
    previousStateText: string | null;
}>> {
    // The backup root is created beside the install root, which does not exist
    // yet on a Home's first install. Owning that precondition here keeps it true
    // for every caller-selected root (incumbent Personal Home or default lane).
    await mkdir(params.installRoot, { recursive: true });
    const backupRoot = await mkdtemp(join(dirname(params.installRoot), '.relay-runtime-backup-'));
    const payloadBackupDir = join(backupRoot, 'payload');
    const migrationsBackupDir = join(backupRoot, 'migrations');
    const existingEntryNames = await listRelayRuntimeManagedRootEntries(params.payloadDir);
    const hasPayloadEntries = existingEntryNames.length > 0;
    const hasRestorableServerBinary = existsSync(join(params.payloadDir, 'bin', params.serverBinaryName));
    const hasMigrations = existsSync(params.migrationsDir);
    if (hasPayloadEntries) {
        await copyNamedRootEntries({
            sourceDir: params.payloadDir,
            destDir: payloadBackupDir,
            entryNames: existingEntryNames,
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
        payloadBackupDir: hasPayloadEntries ? payloadBackupDir : null,
        hasRestorableServerBinary,
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
    shimPath: string;
    migrationsDir: string;
    envPath: string;
    statePath: string;
    payloadBackupDir: string | null;
    migrationsBackupDir: string | null;
    previousEnvText: string | null;
    previousStateText: string | null;
}>): Promise<void> {
    const currentEntryNames = await listRelayRuntimeManagedRootEntries(params.payloadDir);
    await clearNamedRootEntries({
        rootDir: params.payloadDir,
        entryNames: currentEntryNames,
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

async function assertIrreversibleMigrationRollbackAllowed(params: Readonly<{
    migration: (typeof RELAY_RUNTIME_IRREVERSIBLE_MIGRATIONS)[number];
    platform: NodeJS.Platform;
    installRoot: string;
    env: Record<string, string>;
    runCommand?: MigrationAppliedCheckRunner;
}>): Promise<void> {
    const migrationBinaryName = params.platform === 'win32'
        ? 'happier-server-migrate.exe'
        : 'happier-server-migrate';
    const command = join(params.installRoot, 'bin', migrationBinaryName);
    const args = [`--is-migration-applied=${params.migration.name}`];
    const completion = params.runCommand
        ? await params.runCommand({ command, args, cwd: params.installRoot, env: params.env })
        : spawnBackgroundSync(command, args, {
            cwd: params.installRoot,
            env: { ...process.env, ...params.env },
            encoding: 'utf8',
            stdio: 'pipe',
        });
    if (!completion.error && completion.signal === null && completion.status === MIGRATION_NOT_APPLIED_EXIT_CODE) return;

    const detail = completion.error?.message
        || String(completion.stderr ?? '').trim()
        || `migration ledger check exited with status ${completion.status ?? 'unknown'}`;
    const applied = !completion.error && completion.signal === null && completion.status === 0;
    throw new Error(
        applied
            ? `[relay-runtime] ${params.migration.label} is applied; old-server rollback is prohibited`
            : `[relay-runtime] cannot determine whether ${params.migration.label} is applied; refusing old-server rollback: ${detail}`,
    );
}

export class PersonalHomeUpdateRecoveryRequiredError extends Error {
    readonly code: 'personal_home_update_retry_required';
    constructor(
        readonly recoveryAction: 'retry_prior_runtime' | 'retry_exact_candidate',
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'PersonalHomeUpdateRecoveryRequiredError';
        this.code = 'personal_home_update_retry_required';
    }
}

async function runInstalledRelayRuntimeMigrations(params: Readonly<{
    serverBinaryPath: string;
    installRoot: string;
    platform: NodeJS.Platform;
    env: Record<string, string>;
    runMigrationCommand?: (params: Readonly<{ command: string; args: readonly string[]; cwd: string; env: Record<string, string> }>) => Promise<void>;
}>): Promise<void> {
    const plan = resolveSelfHostServerMigrationPlan(params);
    if (!plan) return;
    if (params.runMigrationCommand) {
        await params.runMigrationCommand({ ...plan, cwd: params.installRoot, env: params.env });
        return;
    }
    await runCommandStreaming({
        cmd: plan.command,
        args: [...plan.args],
        cwd: params.installRoot,
        env: { ...process.env, ...params.env },
        context: 'relay-runtime database migration',
    });
}

async function reconcileInterruptedPersonalHomeUpdate(params: Readonly<{
    layout: PersonalHomeRuntimeLayout;
    record: PersonalHomeUpdateRecoveryRecordV1;
    homeDir: string;
    backend: ServiceBackend;
    serviceName: string;
    serverBinaryName: string;
    installRoot: string;
    shimPath: string;
    stdoutPath: string;
    stderrPath: string;
    runServiceCommands: boolean;
    assertPersonalHomeStopped: () => Promise<void>;
    openPersonalHomeRestorePoint?: (context: Readonly<{
        archivePath: string;
        expectedHomeServerIdentityId: string;
        schemaVersion: string;
        layout: PersonalHomeRuntimeLayout;
    }>) => Promise<PersonalHomeRestorePoint>;
    personalHomeRestoreHooks?: PersonalHomeRestoreHooks;
    runMigrationCommand?: (params: Readonly<{ command: string; args: readonly string[]; cwd: string; env: Record<string, string> }>) => Promise<void>;
}>): Promise<Readonly<{ baseUrl: string; version: string | null }>> {
    const references = resolvePersonalHomeUpdateRecoveryReferences({ layout: params.layout, record: params.record });
    const cleanup = async () => {
        await rm(references.runtimeBackupRoot, { recursive: true, force: true });
        await rm(references.restorePointPath, { force: true });
        await removePersonalHomeUpdateRecoveryRecord(params.layout);
    };
    const serverBinaryPath = join(params.installRoot, 'bin', params.serverBinaryName);
    if (params.record.phase === 'committed') {
        // The state file was written before this terminal phase, including by the earlier
        // record shape without candidate metadata. Only cleanup remains; do not restart it
        // or let the retry's input silently replace the completed installation.
        const state = tryParseJsonObject(await readFile(join(params.installRoot, 'self-host-state.json'), 'utf8'));
        const purpose = parsePersonalHomeRuntimePurpose(state?.purpose);
        if (!(await lstat(serverBinaryPath)).isFile()) throw new Error('The committed Personal Home runtime is unavailable');
        const result = { baseUrl: purpose.canonicalServerUrl, version: typeof state?.version === 'string' ? state.version : null };
        await cleanup();
        return result;
    }
    const candidateSpec = buildRelayRuntimeServiceSpec({
        serviceName: params.serviceName, installRoot: params.installRoot, serverBinaryPath,
        env: {}, stdoutPath: params.stdoutPath, stderrPath: params.stderrPath,
    });
    const candidateDefinition = buildServiceDefinition({ backend: params.backend, homeDir: params.homeDir, spec: candidateSpec });
    const quarantine = async () => {
        await applyServicePlan(planServiceAction({
            backend: params.backend, action: 'quarantine', label: candidateSpec.label,
            definitionPath: candidateDefinition.path, persistent: true,
        }), { runCommands: params.runServiceCommands });
    };
    const candidate = params.record.candidate;
    const nonce = params.record.expectedStartupNonce;
    if (!candidate || !nonce) {
        try {
            if (!params.openPersonalHomeRestorePoint) {
                throw new Error('The canonical Personal Home restore-point owner is unavailable');
            }
            await quarantine();
            await params.assertPersonalHomeStopped();
            await restoreRelayRuntimeInstallState({
                platform: params.layout.platform,
                payloadDir: params.installRoot,
                shimPath: params.shimPath,
                migrationsDir: join(params.layout.dataDir, 'migrations', 'sqlite'),
                envPath: join(params.layout.configDir, 'server.env'),
                statePath: join(params.installRoot, 'self-host-state.json'),
                payloadBackupDir: references.payloadBackupDir,
                migrationsBackupDir: references.migrationsBackupDir,
                previousEnvText: params.record.runtimeBackup.previousEnvText,
                previousStateText: params.record.runtimeBackup.previousStateText,
            });
            const restorePoint = await params.openPersonalHomeRestorePoint({
                archivePath: references.restorePointPath,
                expectedHomeServerIdentityId: params.record.restorePoint.homeServerIdentityId,
                schemaVersion: params.record.restorePoint.schemaVersion,
                layout: params.layout,
            });
            const restored = await restorePoint.restore(params.personalHomeRestoreHooks ?? {});
            if (restored.outcome !== 'restored') {
                throw new Error(`Personal Home restore did not complete (${restored.outcome})${restored.error ? `: ${restored.error}` : ''}`);
            }
            if (params.record.previousServiceDefinitionExisted) {
                const priorEnv = parseEnvText(params.record.runtimeBackup.previousEnvText ?? '');
                const priorSpec = buildRelayRuntimeServiceSpec({
                    serviceName: params.serviceName,
                    installRoot: params.installRoot,
                    serverBinaryPath,
                    env: priorEnv,
                    stdoutPath: params.stdoutPath,
                    stderrPath: params.stderrPath,
                });
                const priorDefinition = buildServiceDefinition({ backend: params.backend, homeDir: params.homeDir, spec: priorSpec });
                await applyServicePlan(planServiceAction({
                    backend: params.backend,
                    action: 'install',
                    label: priorSpec.label,
                    definitionPath: priorDefinition.path,
                    definitionContents: priorDefinition.contents,
                    persistent: true,
                }), { runCommands: params.runServiceCommands && params.record.priorRunning });
                if (params.runServiceCommands && params.record.priorRunning) {
                    const priorBaseUrl = resolveConfiguredSelfHostBaseUrl({
                        fallbackBaseUrl: 'http://127.0.0.1:3005',
                        envText: params.record.runtimeBackup.previousEnvText ?? '',
                    });
                    const origin = new URL(priorBaseUrl);
                    const health = await checkRelayRuntimeHealth({
                        host: origin.hostname,
                        port: Number(origin.port),
                        timeoutMs: resolveRelayRuntimeInstallHealthcheckTimeoutMs(),
                        probePortOpen,
                        fetchJson,
                    });
                    if (!health.reachable) throw new Error('The prior Personal Home runtime did not become healthy');
                }
            }
            const finalization = await restorePoint.finalize();
            if (finalization.outcome !== 'finalized' && finalization.outcome !== 'none') {
                throw new Error(`Personal Home restore finalization did not complete (${finalization.outcome})${finalization.error ? `: ${finalization.error}` : ''}`);
            }
            await restorePoint.dispose();
            const priorState = tryParseJsonObject(params.record.runtimeBackup.previousStateText ?? '');
            const priorBaseUrl = resolveConfiguredSelfHostBaseUrl({
                fallbackBaseUrl: 'http://127.0.0.1:3005',
                envText: params.record.runtimeBackup.previousEnvText ?? '',
            });
            await cleanup();
            return { baseUrl: priorBaseUrl, version: typeof priorState?.version === 'string' ? priorState.version : null };
        } catch (error) {
            await quarantine().catch(() => undefined);
            throw new PersonalHomeUpdateRecoveryRequiredError('retry_prior_runtime',
                '[relay-runtime] interrupted Personal Home update has no completed candidate selection; retry recovery of the prior runtime', { cause: error });
        }
    }
    const result = { baseUrl: candidate.state.purpose.canonicalServerUrl, version: candidate.state.version };
    try {
        // Both the Home and payload mutation locks are held. Every managed payload writer
        // reconciles here before considering the retry's input. New records retain the exact
        // staged payload under the existing runtime-backup owner, so interruption immediately
        // after the durable boundary can still finish that candidate. Earlier candidate-bearing
        // records remain reachable when their already-installed bytes are intact.
        if (candidate.payload) {
            if (!references.candidatePayloadDir
                || await computeRelayRuntimePayloadDigest(references.candidatePayloadDir) !== candidate.payload.sha256) {
                throw new Error('The selected Personal Home update payload is unavailable or does not match its durable digest');
            }
        } else if (await readFile(join(params.layout.configDir, 'server.env'), 'utf8') !== candidate.envText
            || !(await lstat(serverBinaryPath)).isFile()) {
            throw new Error('The completed candidate payload or configuration is no longer available');
        }
        if (!params.runServiceCommands) throw new Error('Exact candidate recovery requires service activation and authenticated readiness');
        await quarantine();
        await params.assertPersonalHomeStopped();
        if (candidate.payload && references.candidatePayloadDir) {
            const candidateMigrationsSource = join(references.candidatePayloadDir, 'bin', 'prisma', 'sqlite', 'migrations');
            const migrationsDir = join(params.layout.dataDir, 'migrations', 'sqlite');
            await mkdir(migrationsDir, { recursive: true });
            if (existsSync(candidateMigrationsSource)) {
                await copyDirectoryContents({ sourceDir: candidateMigrationsSource, destDir: migrationsDir });
            }
            await installPersistentPayload({
                sourceDir: references.candidatePayloadDir,
                destDir: params.installRoot,
                executablePath: serverBinaryPath,
            });
            await installBinaryShim({ platform: params.layout.platform, sourcePath: serverBinaryPath, destPath: params.shimPath });
            await mkdir(params.layout.configDir, { recursive: true });
            await writeFile(join(params.layout.configDir, 'server.env'), candidate.envText, 'utf8');
        }
        const receiptPath = join(params.layout.dataDir, 'startup-receipt.json');
        const env = {
            ...parseEnvText(candidate.envText),
            [PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY_ENV]: PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY,
            [SERVER_STARTUP_RECEIPT_PATH_ENV]: receiptPath,
            [SERVER_STARTUP_RECEIPT_NONCE_ENV]: nonce,
        };
        await runInstalledRelayRuntimeMigrations({ serverBinaryPath, installRoot: params.installRoot,
            platform: params.layout.platform, env, runMigrationCommand: params.runMigrationCommand });
        await rm(receiptPath, { force: true });
        const definition = buildServiceDefinition({ backend: params.backend, homeDir: params.homeDir,
            spec: { ...candidateSpec, env } });
        await applyServicePlan(planServiceAction({ backend: params.backend, action: 'install',
            label: candidateSpec.label, definitionPath: definition.path, definitionContents: definition.contents,
            persistent: true }), { runCommands: true });
        const origin = new URL(result.baseUrl);
        const health = await checkRelayRuntimeHealth({ host: origin.hostname, port: Number(origin.port),
            timeoutMs: resolveRelayRuntimeInstallHealthcheckTimeoutMs(), probePortOpen, fetchJson });
        if (!health.reachable) throw new Error('The exact update candidate did not become healthy');
        const receipt = await waitForRelayRuntimeStartupReceipt({ path: receiptPath, nonce });
        if (receipt.host !== '127.0.0.1' || receipt.port !== Number(origin.port)
            || receipt.readiness?.homeServerIdentityId !== params.record.restorePoint.homeServerIdentityId) {
            throw new Error('The exact update candidate did not authenticate the expected Home and listener');
        }
        const activated = { ...params.record, phase: 'activated' as const,
            activation: { nonce, pid: receipt.pid, host: receipt.host, port: receipt.port, readiness: receipt.readiness } };
        await writePersonalHomeUpdateRecoveryRecord(params.layout, activated);
        await writeJsonFile(join(params.installRoot, 'self-host-state.json'), candidate.state);
        await writePersonalHomeUpdateRecoveryRecord(params.layout, { ...activated, phase: 'committed' });
    } catch (error) {
        await quarantine();
        throw new PersonalHomeUpdateRecoveryRequiredError('retry_exact_candidate',
            '[relay-runtime] the selected Personal Home update remains quarantined; retry Install/update to finish this exact candidate without restoring older data', { cause: error });
    }
    await cleanup();
    return result;
}

function removeEnvironmentAssignments(envText: string, keys: ReadonlySet<string>): string {
    const lines = envText.split('\n').filter((line) => {
        const trimmed = line.trim();
        const separatorIndex = trimmed.indexOf('=');
        return separatorIndex < 0 || !keys.has(trimmed.slice(0, separatorIndex).trim());
    });
    const rendered = lines.join('\n');
    return rendered.endsWith('\n') ? rendered : `${rendered}\n`;
}

function removeLegacyPersonalHomePublicOrigin(envText: string, canonicalServerUrl: string): string {
    const env = parseEnvText(envText);
    const publicServerUrl = String(env.HAPPIER_PUBLIC_SERVER_URL ?? '').trim().replace(/\/+$/u, '');
    const canonical = canonicalServerUrl.trim().replace(/\/+$/u, '');
    if (!publicServerUrl || publicServerUrl !== canonical) return envText;

    return removeEnvironmentAssignments(envText, new Set([
        'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_PUBLIC_SERVER_URL_INFERRED',
    ]));
}

async function installOrUpdateRelayRuntimeLocalUnderMutationLocks(params: Readonly<{
    serverBinaryPath: string;
    channel: 'stable' | 'preview' | 'publicdev';
    mode: 'user' | 'system';
    env?: Record<string, string>;
    platform?: NodeJS.Platform;
    homeDir?: string;
    arch?: string;
    version?: string | null;
    serviceNameOverride?: string;
    runServiceCommands?: boolean;
    skipHealthCheck?: boolean;
    purpose?: ManagedRelayPurpose;
    runMigrationCommand?: (params: Readonly<{
        command: string;
        args: readonly string[];
        cwd: string;
        env: Record<string, string>;
    }>) => Promise<void>;
    runMigrationAppliedCheckCommand?: MigrationAppliedCheckRunner;
    /** Verified lease-held Personal Home restore point; an empty first install returns null. */
    createPersonalHomeRestorePoint?: (context: Readonly<{
        happierVersion: string | null;
        layout: PersonalHomeRuntimeLayout;
    }>) => Promise<PersonalHomeRestorePoint | null>;
    /** Actual pre-stop service state, persisted so recovery does not start a previously stopped Home. */
    readPersonalHomeWasRunning?: () => Promise<boolean>;
    /** Reopens the exact verified archive named by the durable update-recovery record. */
    openPersonalHomeRestorePoint?: (context: Readonly<{
        archivePath: string;
        expectedHomeServerIdentityId: string;
        schemaVersion: string;
        layout: PersonalHomeRuntimeLayout;
    }>) => Promise<PersonalHomeRestorePoint>;
    /** Exact persisted layout used by both restore-point creation and interrupted-update recovery. */
    resolvePersonalHomeUpdateLayout?: () => Promise<PersonalHomeRuntimeLayout>;
    /** Canonical owner hooks used to restore the verified snapshot under the held Home lease. */
    personalHomeRestoreHooks?: PersonalHomeRestoreHooks;
    /** RelayHostEngine-owned lifecycle assertion, required for Personal Home mutation. */
    assertPersonalHomeStopped?: () => Promise<void>;
    /** RelayHostEngine-owned bootstrap state check, evaluated under the incumbent Home lock. */
    assertPersonalHomeMutationPrecondition?: () => Promise<void>;
    /** RelayHostEngine-owned legacy service cleanup, executed only after mutation locks are held. */
    cleanupLegacyServiceBeforeInstall?: () => Promise<void>;
}>, rootMigrationSource: RelayRuntimeInstallRootMigrationSource | null): Promise<Readonly<{ baseUrl: string; version: string | null }>> {
    const platform = (String(params.platform ?? '').trim() || process.platform) as NodeJS.Platform;
    const homeDir = String(params.homeDir ?? '').trim() || homedir();
    const arch = String(params.arch ?? '').trim() || process.arch;
    const mode = params.mode === 'system' ? 'system' : 'user';
    const serverBinaryName = platform === 'win32' ? 'happier-server.exe' : 'happier-server';

    assertRootIfRequired({ platform, mode });

    const defaults = resolveRelayRuntimeDefaults({
        platform,
        mode,
        channel: params.channel,
        homeDir,
    });
    if (params.purpose?.kind === 'personal-home') {
        assertPersonalHomeEnvironmentKeys(params.env ?? {});
        if (!params.assertPersonalHomeStopped) {
            throw new Error('[relay-runtime] Personal Home upgrade requires the canonical stopped-Home assertion');
        }
    }
    const serviceName = String(params.serviceNameOverride ?? '').trim() || defaults.serviceName;
    const incumbentInstallRoot = rootMigrationSource?.sourceInstallRoot ?? defaults.installRoot;
    const incumbentConfigDir = rootMigrationSource && mode === 'user'
        ? join(incumbentInstallRoot, 'config')
        : defaults.configDir;
    const incumbentStatePath = join(incumbentInstallRoot, 'self-host-state.json');
    const incumbentConfigEnvPath = join(incumbentConfigDir, 'server.env');
    const installServerBinaryPath = join(defaults.installRoot, 'bin', serverBinaryName);
    const statePath = join(defaults.installRoot, 'self-host-state.json');
    const configEnvPath = join(defaults.configDir, 'server.env');
    const filesDir = join(defaults.dataDir, 'files');
    const dbDir = join(defaults.dataDir, 'pglite');
    const migrationsDir = join(defaults.dataDir, 'migrations', 'sqlite');
    const stdoutPath = join(defaults.logDir, 'server.out.log');
    const stderrPath = join(defaults.logDir, 'server.err.log');
    let startupReceiptPath = join(defaults.dataDir, 'startup-receipt.json');
    const startupReceiptNonce = randomUUID();
    const backend: ServiceBackend = resolveServiceBackend({
        platform,
        mode,
    });
    const migrateInstallRootAfterCandidateBoundary = async (): Promise<Readonly<{
        owned: RelayRuntimeInstallRootMigration | null;
        legacy: RelayRuntimeInstallRootMigration | null;
    }>> => {
        const owned = rootMigrationSource?.kind === 'owned-current-lane'
            ? await migrateOwnedCurrentLaneRelayRuntimeInstallRootIfNeeded({
                platform,
                mode,
                channel: params.channel,
                homeDir,
                runServiceCommands: params.runServiceCommands !== false,
                sourceInstallRoot: rootMigrationSource.sourceInstallRoot,
                assertPersonalHomeStopped: params.assertPersonalHomeStopped,
            })
            : null;
        const legacy = owned
            ? null
            : rootMigrationSource?.kind === 'legacy-unsuffixed'
                ? await migrateLegacyUnsuffixedRelayRuntimeInstallRootIfNeeded({
                    platform,
                    mode,
                    channel: params.channel,
                    homeDir,
                    runServiceCommands: params.runServiceCommands !== false,
                    sourceInstallRoot: rootMigrationSource.sourceInstallRoot,
                    assertPersonalHomeStopped: params.assertPersonalHomeStopped,
                })
                : null;
        return { owned, legacy };
    };
    const previousServiceSpec = buildRelayRuntimeServiceSpec({
        serviceName,
        installRoot: incumbentInstallRoot,
        serverBinaryPath: join(incumbentInstallRoot, 'bin', serverBinaryName),
        env: {},
        stdoutPath: rootMigrationSource && mode === 'user' ? join(incumbentInstallRoot, 'logs', 'server.out.log') : stdoutPath,
        stderrPath: rootMigrationSource && mode === 'user' ? join(incumbentInstallRoot, 'logs', 'server.err.log') : stderrPath,
    });
    const previousServiceDefinition = buildServiceDefinition({
        backend,
        homeDir,
        spec: previousServiceSpec,
    });
    const previousServiceDefinitionExisted = existsSync(previousServiceDefinition.path);

    let personalHomeUpdateLayout = params.purpose?.kind === 'personal-home' && params.resolvePersonalHomeUpdateLayout
        ? rootMigrationSource
            ? await resolvePersonalHomeRuntimeLayoutForInstallRoot({
                platform,
                mode,
                channel: params.channel,
                homeDir,
                installRoot: incumbentInstallRoot,
            })
            : await params.resolvePersonalHomeUpdateLayout()
        : null;
    const interruptedUpdate = personalHomeUpdateLayout
        ? await readPersonalHomeUpdateRecoveryRecord(personalHomeUpdateLayout)
        : null;
    if (interruptedUpdate && personalHomeUpdateLayout) {
        if (rootMigrationSource) {
            await migrateInstallRootAfterCandidateBoundary();
            personalHomeUpdateLayout = await resolvePersonalHomeRuntimeLayoutForInstallRoot({
                platform,
                mode,
                channel: params.channel,
                homeDir,
                installRoot: defaults.installRoot,
            });
        }
        return await reconcileInterruptedPersonalHomeUpdate({
            layout: personalHomeUpdateLayout,
            record: interruptedUpdate,
            homeDir,
            backend,
            serviceName,
            serverBinaryName,
            installRoot: defaults.installRoot,
            shimPath: join(defaults.binDir, serverBinaryName),
            stdoutPath,
            stderrPath,
            runServiceCommands: params.runServiceCommands !== false,
            assertPersonalHomeStopped: params.assertPersonalHomeStopped!,
            openPersonalHomeRestorePoint: params.openPersonalHomeRestorePoint,
            personalHomeRestoreHooks: params.personalHomeRestoreHooks,
            runMigrationCommand: params.runMigrationCommand,
        });
    }

    if (!existsSync(params.serverBinaryPath)) {
        throw new Error('[relay-runtime] server binary not found');
    }

    const preparedPayload = await prepareRelayRuntimePayloadForInstall({
        serverBinaryPath: params.serverBinaryPath,
        serverBinaryName,
    });
    let previousInstallState: Awaited<ReturnType<typeof backupRelayRuntimeInstallState>> | null = null;
    let ownedRootMigration: RelayRuntimeInstallRootMigration | null = null;
    let legacyRootMigration: RelayRuntimeInstallRootMigration | null = null;
    let restoreInstallRoot = defaults.installRoot;
    let candidateServiceActivationAttempted = false;
    let candidateIrreversibleMigrations: ReadonlyArray<(typeof RELAY_RUNTIME_IRREVERSIBLE_MIGRATIONS)[number]> = [];
    let candidateEnv: Record<string, string> | null = null;
    let personalHomeRestorePoint: PersonalHomeRestorePoint | null = null;
    let personalHomeRestoreRollbackPaths: readonly string[] | undefined;
    let preserveRecoveryArtifacts = false;
    let candidateStateCommitted = false;
    let personalHomeWasRunning = previousServiceDefinitionExisted;
    let personalHomeUpdateRecoveryRecord: PersonalHomeUpdateRecoveryRecordV1 | null = null;
    let pendingPersonalHomeUpdateRecoveryRecord: PersonalHomeUpdateRecoveryRecordV1 | null = null;

    try {
        if (params.purpose?.kind === 'personal-home') {
            await assertPersonalHomeServerArtifactCapability({
                payloadRoot: preparedPayload.payloadRoot,
                provenance: { channel: params.channel, version: params.version ?? null },
            });
            await params.cleanupLegacyServiceBeforeInstall?.();
        }
        if (params.purpose?.kind !== 'personal-home') {
            const migrated = await migrateInstallRootAfterCandidateBoundary();
            ownedRootMigration = migrated.owned;
            legacyRootMigration = migrated.legacy;
        }

        restoreInstallRoot = ownedRootMigration?.originalInstallRoot
            ?? legacyRootMigration?.originalInstallRoot
            ?? (params.purpose?.kind === 'personal-home' ? incumbentInstallRoot : defaults.installRoot);

        const backupInstallRoot = params.purpose?.kind === 'personal-home'
            ? incumbentInstallRoot
            : defaults.installRoot;
        const backupMigrationsDir = params.purpose?.kind === 'personal-home' && personalHomeUpdateLayout
            ? join(personalHomeUpdateLayout.dataDir, 'migrations', 'sqlite')
            : migrationsDir;
        previousInstallState = await backupRelayRuntimeInstallState({
            installRoot: backupInstallRoot,
            payloadDir: backupInstallRoot,
            serverBinaryName,
            migrationsDir: backupMigrationsDir,
            envPath: params.purpose?.kind === 'personal-home' ? incumbentConfigEnvPath : configEnvPath,
            statePath: params.purpose?.kind === 'personal-home' ? incumbentStatePath : statePath,
        });

        if (params.purpose?.kind === 'personal-home' && !params.createPersonalHomeRestorePoint) {
            const previousState = tryParseJsonObject(previousInstallState.previousStateText ?? '');
            // The existing state file is the runtime-classification owner. Publish the immutable
            // requested purpose before a fresh install's first service or payload mutation. An
            // existing Home instead remains byte-for-byte on its prior runtime until the durable
            // candidate-bearing recovery boundary below has been committed.
            await mkdir(dirname(incumbentStatePath), { recursive: true });
            await writeJsonFile(incumbentStatePath, {
                ...(previousState ?? {}),
                purpose: params.purpose,
            });
        }

        if (params.purpose?.kind === 'personal-home' && params.readPersonalHomeWasRunning) {
            personalHomeWasRunning = await params.readPersonalHomeWasRunning();
        }

        if (params.runServiceCommands !== false) {
            const stopServiceSpec = buildRelayRuntimeServiceSpec({
                serviceName,
                installRoot: params.purpose?.kind === 'personal-home' ? incumbentInstallRoot : defaults.installRoot,
                serverBinaryPath: params.purpose?.kind === 'personal-home'
                    ? join(incumbentInstallRoot, 'bin', serverBinaryName)
                    : installServerBinaryPath,
                env: {},
                stdoutPath: params.purpose?.kind === 'personal-home' && rootMigrationSource && mode === 'user'
                    ? join(incumbentInstallRoot, 'logs', 'server.out.log')
                    : stdoutPath,
                stderrPath: params.purpose?.kind === 'personal-home' && rootMigrationSource && mode === 'user'
                    ? join(incumbentInstallRoot, 'logs', 'server.err.log')
                    : stderrPath,
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
        await params.assertPersonalHomeStopped?.();

        if (params.createPersonalHomeRestorePoint) {
            const restorePointLayout = personalHomeUpdateLayout ?? await resolvePersonalHomeRuntimeLayoutForInstallRoot({
                platform,
                mode,
                channel: params.channel,
                homeDir,
                installRoot: incumbentInstallRoot,
            });
            const previousState = tryParseJsonObject(previousInstallState.previousStateText ?? '');
            const previousVersion = typeof previousState?.version === 'string' && previousState.version.trim()
              ? previousState.version.trim()
              : typeof previousState?.retainedPersonalHomeVersion === 'string' && previousState.retainedPersonalHomeVersion.trim()
                ? previousState.retainedPersonalHomeVersion.trim()
                : null;
            const candidateVersion = typeof params.version === 'string' && params.version.trim()
                ? params.version.trim()
                : null;
            personalHomeRestorePoint = await params.createPersonalHomeRestorePoint({
                happierVersion: previousVersion ?? candidateVersion,
                layout: restorePointLayout,
            });
            if (personalHomeRestorePoint && personalHomeUpdateLayout) {
                if (!params.openPersonalHomeRestorePoint || !params.readPersonalHomeWasRunning) {
                    throw new Error('[relay-runtime] Personal Home update recovery requires the canonical running-state and restore-point owners');
                }
                pendingPersonalHomeUpdateRecoveryRecord = Object.freeze({
                    version: 1,
                    phase: 'prepared',
                    expectedStartupNonce: startupReceiptNonce,
                    activation: null,
                    priorRunning: personalHomeWasRunning,
                    previousServiceDefinitionExisted,
                    runtimeBackup: Object.freeze({
                        directoryName: basename(previousInstallState.backupRoot),
                        hasPayload: previousInstallState.payloadBackupDir !== null,
                        hasRestorableServerBinary: previousInstallState.hasRestorableServerBinary,
                        hasMigrations: previousInstallState.migrationsBackupDir !== null,
                        previousEnvText: previousInstallState.previousEnvText,
                        previousStateText: previousInstallState.previousStateText,
                    }),
                    restorePoint: Object.freeze({
                        fileName: basename(personalHomeRestorePoint.backup.path),
                        homeServerIdentityId: personalHomeRestorePoint.backup.manifest.homeServerIdentityId,
                        schemaVersion: personalHomeRestorePoint.backup.manifest.schemaVersion,
                    }),
                });
            }
        }

        const payloadRoot = preparedPayload.payloadRoot;
        const uiDir = platform === 'win32'
            ? win32Path.join(defaults.installRoot, 'ui-web', 'current')
            : join(defaults.installRoot, 'ui-web', 'current');
        const candidateUiDir = platform === 'win32'
            ? win32Path.join(payloadRoot, 'ui-web', 'current')
            : join(payloadRoot, 'ui-web', 'current');
        const candidateUiIndexPath = join(candidateUiDir, 'index.html');
        const uiDeployment = existsSync(candidateUiIndexPath)
            ? resolveUiDeploymentIdentity({
                digest: await computeUiDeploymentDigest(candidateUiDir),
                previousStateText: previousInstallState.previousStateText,
                generateId: randomUUID,
            })
            : null;
        const existingEnvTextRaw = previousInstallState.previousEnvText ?? '';
        const normalizedExistingEnvText = params.purpose?.kind === 'personal-home'
            ? removeLegacyPersonalHomePublicOrigin(existingEnvTextRaw, params.purpose.canonicalServerUrl)
            : existingEnvTextRaw;
        const relayPolicyOverride = String(params.env?.HAPPIER_IROH_RELAY_POLICY ?? '').trim().toLowerCase();
        const existingEnvText = params.purpose?.kind === 'personal-home'
            && (relayPolicyOverride === 'automatic' || relayPolicyOverride === 'disabled')
            && !Object.prototype.hasOwnProperty.call(params.env ?? {}, 'HAPPIER_IROH_RELAY_URLS')
            ? removeEnvironmentAssignments(normalizedExistingEnvText, new Set(['HAPPIER_IROH_RELAY_URLS']))
            : normalizedExistingEnvText;
        const existingEnv = parseEnvText(existingEnvText);
        const existingPortRaw = String(existingEnv.PORT ?? '').trim();
        const overridePortRaw = String((params.env ?? {}).PORT ?? '').trim();
        const configuredPortRaw = overridePortRaw || existingPortRaw;
        const configuredPort = configuredPortRaw && Number.isInteger(Number.parseInt(configuredPortRaw, 10))
            ? Number.parseInt(configuredPortRaw, 10)
            : null;
        const resolvedPort = await resolveNonCollidingRelayPort({
            platform,
            mode,
            channel: params.channel,
            homeDir,
            defaultPort: defaults.serverPort,
            configuredPort,
            explicitConfiguredPort: Boolean(overridePortRaw),
        });
        // Personal Home uninstall intentionally retains server.env because it is
        // the storage-location authority. An omitted-purpose reinstall must
        // therefore render from those persisted locations rather than silently
        // relocating the Home back under this install lane's defaults.
        const renderedDataDir = params.purpose?.kind === 'personal-home'
            ? String(existingEnv.HAPPIER_SERVER_LIGHT_DATA_DIR ?? existingEnv.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').trim()
                || defaults.dataDir
            : defaults.dataDir;
        const renderedFilesDir = params.purpose?.kind === 'personal-home'
            ? String(existingEnv.HAPPIER_SERVER_LIGHT_FILES_DIR ?? existingEnv.HAPPY_SERVER_LIGHT_FILES_DIR ?? '').trim()
                || join(renderedDataDir, 'files')
            : filesDir;
        const renderedDbDir = params.purpose?.kind === 'personal-home'
            ? String(existingEnv.HAPPIER_SERVER_LIGHT_DB_DIR ?? existingEnv.HAPPY_SERVER_LIGHT_DB_DIR ?? '').trim()
                || join(renderedDataDir, 'pglite')
            : dbDir;
        startupReceiptPath = join(renderedDataDir, 'startup-receipt.json');
        const prismaEngineFileName = resolveServerRuntimePrismaEngineFileName({ platform, arch });
        const candidatePrismaEngineRelativePath = [
            join('bin', 'node_modules', '.prisma', 'client', prismaEngineFileName),
            join('bin', 'generated', 'sqlite-client', prismaEngineFileName),
        ].find((relativePath) => existsSync(join(payloadRoot, relativePath)));
        const baseEnvText = renderSelfHostServerEnvText({
            port: resolvedPort,
            host: defaults.serverHost,
            dataDir: renderedDataDir,
            filesDir: renderedFilesDir,
            dbDir: renderedDbDir,
            uiDir,
            uiDeploymentId: uiDeployment?.deploymentId,
            serverBinDir: dirname(installServerBinaryPath),
            ...(candidatePrismaEngineRelativePath
                ? { prismaEnginePath: join(defaults.installRoot, candidatePrismaEngineRelativePath) }
                : {}),
            arch,
            platform,
        });
        const preservedClosedSignup = params.purpose?.kind === 'personal-home'
            && readEffectivePersonalHomeSignupPolicy(existingEnvText) === 'disabled';
        const personalHomeEnv = params.purpose?.kind === 'personal-home'
            ? renderPersonalHomeRuntimeEnv({
                spec: createPersonalHomeRuntimeSpec({ canonicalServerUrl: params.purpose.canonicalServerUrl }),
                port: resolvedPort,
                overrides: {
                    ...(params.env ?? {}),
                    ...(preservedClosedSignup ? { AUTH_ANONYMOUS_SIGNUP_ENABLED: '0' } : {}),
                },
                baseEnv: existingEnv,
            })
            : null;
        // Home device approval is owned by the Home auth/enrollment path. It is
        // intentionally not part of the Personal Home fixed renderer, but a
        // process-level setting must survive the first managed env write when
        // no prior server.env exists. Preserve an existing file value above;
        // only carry the inherited setting when the file has no assignment.
        const approvalKey = 'HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED';
        const inheritedApproval = params.purpose?.kind === 'personal-home'
            && !Object.prototype.hasOwnProperty.call(existingEnv, approvalKey)
            && Object.prototype.hasOwnProperty.call(process.env, approvalKey)
            ? String(process.env[approvalKey] ?? '')
            : null;
        const envText = mergeSelfHostServerEnvText({
            baseEnvText,
            existingEnvText,
            overrides: {
                ...(params.env ?? {}),
                ...(personalHomeEnv ?? {}),
                ...(params.purpose ? { [MANAGED_RELAY_PURPOSE_ENV]: params.purpose.kind } : {}),
                ...(inheritedApproval !== null ? { [approvalKey]: inheritedApproval } : {}),
                PORT: String(resolvedPort),
            },
        });
        const state: Omit<PersonalHomeUpdateCandidateState, 'purpose'> & { purpose?: ManagedRelayPurpose } = {
            channel: params.channel,
            mode,
            version: typeof params.version === 'string' && params.version.trim() ? params.version.trim() : null,
            updatedAt: new Date().toISOString(),
            ...(params.purpose ? { purpose: params.purpose } : {}),
            ...(uiDeployment ? {
                uiDeploymentDigest: uiDeployment.digest,
                uiDeploymentId: uiDeployment.deploymentId,
            } : {}),
        };
        let selectedPayloadRoot = payloadRoot;
        if (pendingPersonalHomeUpdateRecoveryRecord && personalHomeUpdateLayout && params.purpose?.kind === 'personal-home') {
            selectedPayloadRoot = join(previousInstallState.backupRoot, 'candidate');
            const candidateEntryNames = await listRelayRuntimeManagedRootEntries(payloadRoot);
            await copyNamedRootEntries({
                sourceDir: payloadRoot,
                destDir: selectedPayloadRoot,
                entryNames: candidateEntryNames,
            });
            if (!existsSync(join(selectedPayloadRoot, 'bin', serverBinaryName))) {
                throw new Error('[relay-runtime] staged Personal Home update candidate has no server binary');
            }
            const candidatePayloadSha256 = await computeRelayRuntimePayloadDigest(selectedPayloadRoot);
            // The record is allowed to select this candidate only after both its exact payload and
            // the prior-runtime rollback bytes it references have reached the durable boundary.
            await syncPersonalHomeTree(previousInstallState.backupRoot, { allowSymbolicLinks: true });
            await syncPersonalHomeParentDirectory(previousInstallState.backupRoot);
            const nextPersonalHomeUpdateRecoveryRecord = Object.freeze({
                ...pendingPersonalHomeUpdateRecoveryRecord,
                candidate: {
                    envText,
                    state: { ...state, purpose: params.purpose },
                    payload: { directoryName: 'candidate', sha256: candidatePayloadSha256 },
                },
            } satisfies PersonalHomeUpdateRecoveryRecordV1);
            personalHomeUpdateRecoveryRecord = nextPersonalHomeUpdateRecoveryRecord;
            await writePersonalHomeUpdateRecoveryRecord(personalHomeUpdateLayout, nextPersonalHomeUpdateRecoveryRecord);
            pendingPersonalHomeUpdateRecoveryRecord = null;
        }

        if (params.purpose?.kind === 'personal-home' && rootMigrationSource) {
            // The source root, its payload/configuration, and its persisted classification stay
            // untouched until the exact candidate and rollback facts above are durable. The root
            // move is the first incumbent-runtime mutation after that boundary.
            const migrated = await migrateInstallRootAfterCandidateBoundary();
            ownedRootMigration = migrated.owned;
            legacyRootMigration = migrated.legacy;
            restoreInstallRoot = ownedRootMigration?.originalInstallRoot
                ?? legacyRootMigration?.originalInstallRoot
                ?? incumbentInstallRoot;
            personalHomeUpdateLayout = await resolvePersonalHomeRuntimeLayoutForInstallRoot({
                platform,
                mode,
                channel: params.channel,
                homeDir,
                installRoot: defaults.installRoot,
            });
            if (personalHomeUpdateRecoveryRecord && personalHomeRestorePoint) {
                if (!params.openPersonalHomeRestorePoint) {
                    throw new Error('[relay-runtime] Personal Home update recovery requires the canonical restore-point owner');
                }
                const references = resolvePersonalHomeUpdateRecoveryReferences({
                    layout: personalHomeUpdateLayout,
                    record: personalHomeUpdateRecoveryRecord,
                });
                personalHomeRestorePoint = null;
                personalHomeRestorePoint = await params.openPersonalHomeRestorePoint({
                    archivePath: references.restorePointPath,
                    expectedHomeServerIdentityId: personalHomeUpdateRecoveryRecord.restorePoint.homeServerIdentityId,
                    schemaVersion: personalHomeUpdateRecoveryRecord.restorePoint.schemaVersion,
                    layout: personalHomeUpdateLayout,
                });
            }
        }

        if (params.purpose?.kind === 'personal-home' && !personalHomeUpdateRecoveryRecord && params.createPersonalHomeRestorePoint) {
            const previousState = tryParseJsonObject(previousInstallState.previousStateText ?? '');
            await mkdir(dirname(statePath), { recursive: true });
            await writeJsonFile(statePath, {
                ...(previousState ?? {}),
                purpose: params.purpose,
            });
        }

        await mkdir(defaults.installRoot, { recursive: true });
        await mkdir(defaults.configDir, { recursive: true });
        await mkdir(defaults.dataDir, { recursive: true });
        await mkdir(filesDir, { recursive: true });
        await mkdir(dbDir, { recursive: true });
        await mkdir(defaults.logDir, { recursive: true });

        const migrationsSourceDir = join(selectedPayloadRoot, 'bin', 'prisma', 'sqlite', 'migrations');
        await mkdir(migrationsDir, { recursive: true });
        if (existsSync(migrationsSourceDir)) {
            await copyDirectoryContents({
                sourceDir: migrationsSourceDir,
                destDir: migrationsDir,
            });
        }
        await installPersistentPayload({
            sourceDir: selectedPayloadRoot,
            destDir: defaults.installRoot,
            executablePath: installServerBinaryPath,
        });
        await installBinaryShim({
            platform,
            sourcePath: installServerBinaryPath,
            destPath: join(defaults.binDir, serverBinaryName),
        });
        await writeFile(configEnvPath, envText, 'utf8');
        const env = parseEnvText(envText);
        const migrationEnv = {
            ...env,
            [PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY_ENV]: PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY,
            ...(personalHomeUpdateRecoveryRecord ? { [SERVER_STARTUP_RECEIPT_NONCE_ENV]: startupReceiptNonce } : {}),
        };
        candidateEnv = migrationEnv;
        const provider = String(env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER ?? 'sqlite').trim().toLowerCase();
        const candidateMigrationsDir = provider === 'mysql'
            ? join(defaults.installRoot, 'bin', 'prisma', 'mysql', 'migrations')
            : provider === 'sqlite'
                ? migrationsDir
                : join(defaults.installRoot, 'bin', 'prisma', 'migrations');
        candidateIrreversibleMigrations = RELAY_RUNTIME_IRREVERSIBLE_MIGRATIONS.filter(
            ({ name }) => existsSync(join(candidateMigrationsDir, name)),
        );
        await runInstalledRelayRuntimeMigrations({
            serverBinaryPath: installServerBinaryPath,
            installRoot: defaults.installRoot,
            env: migrationEnv,
            platform,
            runMigrationCommand: params.runMigrationCommand,
        });

        await rm(startupReceiptPath, { force: true });
        const serviceSpec = buildRelayRuntimeServiceSpec({
            serviceName,
            installRoot: defaults.installRoot,
            serverBinaryPath: installServerBinaryPath,
            env: {
                ...env,
                [PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY_ENV]: PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY,
                [SERVER_STARTUP_RECEIPT_PATH_ENV]: startupReceiptPath,
                [SERVER_STARTUP_RECEIPT_NONCE_ENV]: startupReceiptNonce,
            },
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
        candidateServiceActivationAttempted = params.runServiceCommands !== false;
        await applyServicePlan(plan, {
            runCommands: params.runServiceCommands !== false,
        });

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
            const startupReceipt = await waitForRelayRuntimeStartupReceipt({
                path: startupReceiptPath,
                nonce: startupReceiptNonce,
            });
            if (params.purpose?.kind === 'personal-home') {
                if (
                    startupReceipt.host !== baseUrlObject.hostname
                    || startupReceipt.host !== '127.0.0.1'
                    || startupReceipt.port !== Number.parseInt(baseUrlObject.port, 10)
                ) {
                    throw new Error('[relay-runtime] Personal Home startup listener does not match its stable loopback origin');
                }
                if (personalHomeUpdateRecoveryRecord && personalHomeUpdateLayout) {
                    if (!startupReceipt.readiness
                        || startupReceipt.readiness.homeServerIdentityId !== personalHomeUpdateRecoveryRecord.restorePoint.homeServerIdentityId) {
                        throw new Error('[relay-runtime] Personal Home update startup receipt did not authenticate the expected Home identity');
                    }
                    personalHomeUpdateRecoveryRecord = Object.freeze({
                        ...personalHomeUpdateRecoveryRecord,
                        phase: 'activated',
                        activation: {
                            nonce: startupReceipt.nonce,
                            pid: startupReceipt.pid,
                            host: startupReceipt.host,
                            port: startupReceipt.port,
                            readiness: startupReceipt.readiness,
                        },
                    });
                    await writePersonalHomeUpdateRecoveryRecord(personalHomeUpdateLayout, personalHomeUpdateRecoveryRecord);
                }
            }
        }

        if (
            personalHomeRestorePoint
            && params.personalHomeRestoreHooks?.verifyIdentity
            && !(await params.personalHomeRestoreHooks.verifyIdentity(personalHomeRestorePoint.backup.manifest))
        ) {
            throw new Error('[relay-runtime] Personal Home identity verification failed after activation');
        }

        await writeJsonFile(statePath, state);
        if (personalHomeUpdateRecoveryRecord && personalHomeUpdateLayout) {
            personalHomeUpdateRecoveryRecord = Object.freeze({ ...personalHomeUpdateRecoveryRecord, phase: 'committed' });
            await writePersonalHomeUpdateRecoveryRecord(personalHomeUpdateLayout, personalHomeUpdateRecoveryRecord);
        }
        candidateStateCommitted = true;
        if (personalHomeRestorePoint) {
            await personalHomeRestorePoint.dispose();
            personalHomeRestorePoint = null;
        }
        if (personalHomeUpdateLayout && personalHomeUpdateRecoveryRecord) {
            await removePersonalHomeUpdateRecoveryRecord(personalHomeUpdateLayout);
            personalHomeUpdateRecoveryRecord = null;
        }

        return {
            baseUrl,
            version: state.version,
        };
    } catch (error) {
        if (candidateStateCommitted) throw error;
        const candidateMayHaveAcceptedWrites = personalHomeUpdateRecoveryRecord?.phase === 'activated';
        const candidateActivationAmbiguous = personalHomeUpdateRecoveryRecord?.phase === 'prepared';
        if (!candidateMayHaveAcceptedWrites && !candidateActivationAmbiguous) {
            await rm(startupReceiptPath, { force: true }).catch(() => undefined);
        }
        const rollbackFailures: RelayRuntimeInstallRollbackFailure[] = [];
        let rollbackCanProceed = !candidateMayHaveAcceptedWrites && !candidateActivationAmbiguous;

        if (candidateServiceActivationAttempted || candidateMayHaveAcceptedWrites || candidateActivationAmbiguous) {
            try {
                const candidateStopSpec = buildRelayRuntimeServiceSpec({
                    serviceName,
                    installRoot: defaults.installRoot,
                    serverBinaryPath: installServerBinaryPath,
                    env: {},
                    stdoutPath,
                    stderrPath,
                });
                const candidateStopDefinition = buildServiceDefinition({
                    backend,
                    homeDir,
                    spec: candidateStopSpec,
                });
                const candidateStopPlan = planServiceAction({
                    backend,
                    action: candidateMayHaveAcceptedWrites || candidateActivationAmbiguous ? 'quarantine' : 'stop',
                    label: candidateStopSpec.label,
                    definitionPath: candidateStopDefinition.path,
                    persistent: true,
                });
                await applyServicePlan(candidateStopPlan, { runCommands: params.runServiceCommands !== false });
                await params.assertPersonalHomeStopped?.();
            } catch (rollbackError) {
                rollbackFailures.push({ phase: 'candidate_stop', error: rollbackError });
                rollbackCanProceed = false;
            }
        }

        if (candidateMayHaveAcceptedWrites || candidateActivationAmbiguous) {
            preserveRecoveryArtifacts = true;
            throw error;
        }

        if (rollbackCanProceed && candidateEnv) {
            try {
                for (const migration of candidateIrreversibleMigrations) {
                    await assertIrreversibleMigrationRollbackAllowed({
                        migration,
                        platform,
                        installRoot: defaults.installRoot,
                        env: candidateEnv,
                        runCommand: params.runMigrationAppliedCheckCommand,
                    });
                }
            } catch (rollbackError) {
                rollbackFailures.push({ phase: 'irreversible_boundary', error: rollbackError });
                rollbackCanProceed = false;
            }
        }

        if (rollbackCanProceed && previousInstallState) {
            try {
                await restoreRelayRuntimeInstallState({
                    platform,
                    payloadDir: defaults.installRoot,
                    shimPath: join(defaults.binDir, serverBinaryName),
                    migrationsDir,
                    envPath: configEnvPath,
                    statePath,
                    payloadBackupDir: previousInstallState.payloadBackupDir,
                    migrationsBackupDir: previousInstallState.migrationsBackupDir,
                    previousEnvText: previousInstallState.previousEnvText,
                    previousStateText: previousInstallState.previousStateText,
                });
            } catch (rollbackError) {
                rollbackFailures.push({ phase: 'runtime_restore', error: rollbackError });
                rollbackCanProceed = false;
            }
        }

        if (rollbackCanProceed && personalHomeRestorePoint) {
            try {
                const restoreResult = await personalHomeRestorePoint.restore(params.personalHomeRestoreHooks ?? {});
                personalHomeRestoreRollbackPaths = restoreResult.rollbackPaths;
                if (restoreResult.outcome !== 'restored') {
                    throw new Error(`[relay-runtime] Personal Home restore did not complete (${restoreResult.outcome})${restoreResult.error ? `: ${restoreResult.error}` : ''}`);
                }
            } catch (rollbackError) {
                rollbackFailures.push({ phase: 'personal_home_restore', error: rollbackError });
                rollbackCanProceed = false;
            }
        }

        if (rollbackCanProceed && previousInstallState && (ownedRootMigration || legacyRootMigration) && params.runServiceCommands !== false) {
            try {
                const migratedRollbackSpec = buildRelayRuntimeServiceSpec({
                    serviceName,
                    installRoot: defaults.installRoot,
                    serverBinaryPath: join(defaults.installRoot, 'bin', serverBinaryName),
                    env: {},
                    stdoutPath,
                    stderrPath,
                });
                const migratedRollbackDefinition = buildServiceDefinition({
                    backend,
                    homeDir,
                    spec: migratedRollbackSpec,
                });
                const migratedRollbackPlan = planServiceAction({
                    backend,
                    action: 'uninstall',
                    label: migratedRollbackSpec.label,
                    definitionPath: migratedRollbackDefinition.path,
                    persistent: true,
                });
                await applyServicePlan(migratedRollbackPlan, { runCommands: true });
                await rm(migratedRollbackDefinition.path, { force: true }).catch(() => undefined);
            } catch (rollbackError) {
                rollbackFailures.push({ phase: 'service_restore', error: rollbackError });
                rollbackCanProceed = false;
            }
        }

        if (rollbackCanProceed) {
            for (const migration of [ownedRootMigration, legacyRootMigration]) {
                if (!migration) continue;
                try {
                    await rollbackRelayRuntimeInstallRootMigration(migration);
                } catch (rollbackError) {
                    rollbackFailures.push({ phase: 'install_root_restore', error: rollbackError });
                    rollbackCanProceed = false;
                    break;
                }
            }
        }

        if (rollbackCanProceed && previousInstallState && !ownedRootMigration && !legacyRootMigration) {
            try {
                if (previousServiceDefinitionExisted && previousInstallState.hasRestorableServerBinary) {
                    const restoreEnv = parseEnvText(previousInstallState.previousEnvText ?? '');
                    const rollbackReceiptNonce = randomUUID();
                    const rollbackDataDir = String(
                        restoreEnv.HAPPIER_SERVER_LIGHT_DATA_DIR
                        ?? restoreEnv.HAPPY_SERVER_LIGHT_DATA_DIR
                        ?? defaults.dataDir,
                    ).trim();
                    const rollbackReceiptPath = join(rollbackDataDir, 'startup-receipt.json');
                    const restoreServiceEnv = params.purpose?.kind === 'personal-home'
                        ? {
                            ...restoreEnv,
                            [SERVER_STARTUP_RECEIPT_PATH_ENV]: rollbackReceiptPath,
                            [SERVER_STARTUP_RECEIPT_NONCE_ENV]: rollbackReceiptNonce,
                        }
                        : restoreEnv;
                    if (params.purpose?.kind === 'personal-home') {
                        await rm(rollbackReceiptPath, { force: true });
                    }
                    const restoreSpec = buildRelayRuntimeServiceSpec({
                        serviceName,
                        installRoot: restoreInstallRoot,
                        serverBinaryPath: join(restoreInstallRoot, 'bin', serverBinaryName),
                        env: restoreServiceEnv,
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
                        runCommands: params.runServiceCommands !== false
                            && (params.purpose?.kind !== 'personal-home' || personalHomeWasRunning),
                    });
                    if (params.runServiceCommands !== false
                        && params.skipHealthCheck !== true
                        && (params.purpose?.kind !== 'personal-home' || personalHomeWasRunning)) {
                        const rollbackBaseUrl = resolveConfiguredSelfHostBaseUrl({
                            fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
                            envText: previousInstallState.previousEnvText ?? '',
                        });
                        const rollbackBaseUrlObject = new URL(rollbackBaseUrl);
                        const rollbackHealth = await checkRelayRuntimeHealth({
                            host: rollbackBaseUrlObject.hostname,
                            port: Number.parseInt(rollbackBaseUrlObject.port, 10),
                            timeoutMs: resolveRelayRuntimeInstallHealthcheckTimeoutMs(),
                            probePortOpen: async ({ host, port, timeoutMs }) => await probePortOpen({ host, port, timeoutMs }),
                            fetchJson: async ({ url, timeoutMs }) => await fetchJson({ url, timeoutMs }),
                        });
                        if (!rollbackHealth.reachable) {
                            throw new Error(`[relay-runtime] previous relay runtime did not become healthy after rollback (${rollbackHealth.url})`);
                        }
                        if (params.purpose?.kind === 'personal-home') {
                            const rollbackReceipt = await waitForRelayRuntimeStartupReceipt({
                                path: rollbackReceiptPath,
                                nonce: rollbackReceiptNonce,
                            });
                            if (rollbackReceipt.host !== rollbackBaseUrlObject.hostname
                                || rollbackReceipt.host !== '127.0.0.1'
                                || rollbackReceipt.port !== Number.parseInt(rollbackBaseUrlObject.port, 10)
                                || !rollbackReceipt.readiness
                                || (personalHomeRestorePoint
                                    && rollbackReceipt.readiness.homeServerIdentityId
                                        !== personalHomeRestorePoint.backup.manifest.homeServerIdentityId)) {
                                throw new Error('[relay-runtime] previous Personal Home did not produce a fresh matching rollback receipt');
                            }
                        }
                    }
                } else if (params.runServiceCommands !== false) {
                    const rollbackSpec = buildRelayRuntimeServiceSpec({
                        serviceName,
                        installRoot: restoreInstallRoot,
                        serverBinaryPath: join(restoreInstallRoot, 'bin', serverBinaryName),
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
                    await applyServicePlan(rollbackPlan, { runCommands: true });
                    if (!previousServiceDefinitionExisted) {
                        await rm(rollbackDefinition.path, { force: true }).catch(() => undefined);
                    }
                }
            } catch (rollbackError) {
                rollbackFailures.push({ phase: 'service_restore', error: rollbackError });
                rollbackCanProceed = false;
            }
        }

        if (rollbackCanProceed && personalHomeRestorePoint) {
            try {
                const finalization = await personalHomeRestorePoint.finalize();
                if (finalization.outcome !== 'finalized' && finalization.outcome !== 'none') {
                    throw new Error(`[relay-runtime] Personal Home restore finalization did not complete (${finalization.outcome})${finalization.error ? `: ${finalization.error}` : ''}`);
                }
                personalHomeRestoreRollbackPaths = undefined;
                if (personalHomeUpdateLayout && personalHomeUpdateRecoveryRecord) {
                    personalHomeUpdateRecoveryRecord = Object.freeze({ ...personalHomeUpdateRecoveryRecord, phase: 'committed' });
                    await writePersonalHomeUpdateRecoveryRecord(personalHomeUpdateLayout, personalHomeUpdateRecoveryRecord);
                }
                await personalHomeRestorePoint.dispose();
                personalHomeRestorePoint = null;
                if (personalHomeUpdateLayout && personalHomeUpdateRecoveryRecord) {
                    await removePersonalHomeUpdateRecoveryRecord(personalHomeUpdateLayout);
                    personalHomeUpdateRecoveryRecord = null;
                }
            } catch (rollbackError) {
                rollbackFailures.push({ phase: 'artifact_disposal', error: rollbackError });
                rollbackCanProceed = false;
            }
        }

        if (!rollbackCanProceed || rollbackFailures.length > 0) {
            preserveRecoveryArtifacts = true;
            throw new RelayRuntimeInstallRollbackIncompleteError(error, rollbackFailures, {
                ...(previousInstallState ? { runtimeBackupRoot: previousInstallState.backupRoot } : {}),
                ...(personalHomeRestorePoint ? { personalHomeRestorePointPath: personalHomeRestorePoint.backup.path } : {}),
                ...(personalHomeRestoreRollbackPaths ? { personalHomeRestoreRollbackPaths } : {}),
            });
        }
        throw error;
    } finally {
        if (preparedPayload.cleanupPath) {
            await rm(preparedPayload.cleanupPath, { recursive: true, force: true }).catch(() => undefined);
        }
        if (previousInstallState && !preserveRecoveryArtifacts) {
            await rm(previousInstallState.backupRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}

export async function installOrUpdateRelayRuntimeLocal(
    params: Parameters<typeof installOrUpdateRelayRuntimeLocalUnderMutationLocks>[0],
): ReturnType<typeof installOrUpdateRelayRuntimeLocalUnderMutationLocks> {
    const platform = (String(params.platform ?? '').trim() || process.platform) as NodeJS.Platform;
    const homeDir = String(params.homeDir ?? '').trim() || homedir();
    const mode = params.mode === 'system' ? 'system' : 'user';
    assertRootIfRequired({ platform, mode });
    const defaults = resolveRelayRuntimeDefaults({
        platform,
        mode,
        channel: params.channel,
        homeDir,
    });

    return withFirstPartyPayloadMutationLock({
        installRoot: defaults.installRoot,
        lockParentDir: dirname(defaults.installRoot),
        operation: async () => {
            const rootMigrationSource = await resolveRelayRuntimeInstallRootMigrationSource({
                platform,
                mode,
                channel: params.channel,
                homeDir,
            });
            const installUnderHeldLocks = async () => {
                await params.assertPersonalHomeMutationPrecondition?.();
                // Activation and recovery require the task host before incumbent cleanup or stop.
                await preflightServiceInstallAssets({ backend: resolveServiceBackend({ platform, mode }) });
                if (params.purpose?.kind !== 'personal-home') {
                    await params.cleanupLegacyServiceBeforeInstall?.();
                }
                return installOrUpdateRelayRuntimeLocalUnderMutationLocks(params, rootMigrationSource);
            };
            if (params.purpose?.kind === 'personal-home') {
                // A user-mode legacy migration renames the complete install root, including its
                // persistent data directory. Lock that existing Home before the move; creating a
                // second destination lock would itself create the destination and defeat the
                // atomic rename. The lock owner releases the same token at its moved path.
                const readLayout = () => resolvePersonalHomeRuntimeLayoutForInstallRoot({
                    platform,
                    mode,
                    channel: params.channel,
                    homeDir,
                    installRoot: rootMigrationSource?.sourceInstallRoot ?? defaults.installRoot,
                });
                const sourceLayout = await readLayout();
                const destinationLayout = rootMigrationSource
                    ? await resolvePersonalHomeRuntimeLayoutForInstallRoot({
                        platform,
                        mode,
                        channel: params.channel,
                        homeDir,
                        installRoot: defaults.installRoot,
                    })
                    : sourceLayout;
                const purpose = params.purpose;
                return withPersonalHomeOperationAdmission({
                    request: { kind: 'upgrade' },
                    readValidatedTarget: async () => {
                        const layout = await readLayout();
                        await validateCanonicalPersonalHomeLayout(layout, {
                            homeDir,
                            installRoot: rootMigrationSource?.sourceInstallRoot ?? defaults.installRoot,
                            configDir: rootMigrationSource && mode === 'user' ? join(rootMigrationSource.sourceInstallRoot, 'config') : defaults.configDir,
                        });
                        const envText = await readFile(join(layout.configDir, 'server.env'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '' : Promise.reject(error));
                        const canonicalServerUrl = parseEnvText(envText).HAPPIER_CANONICAL_SERVER_URL ?? purpose.canonicalServerUrl;
                        if (canonicalServerUrl !== purpose.canonicalServerUrl) throw new Error('Personal Home canonical origin changed before update admission.');
                        return {
                            layout,
                            canonicalServerUrl,
                            homeServerIdentityId: existsSync(layout.databasePath) ? (await readPersonalHomeIdentityValueFromSqlite(layout.databasePath)).homeServerIdentityId : null,
                        };
                    },
                    isHomeRunning: async () => params.readPersonalHomeWasRunning ? await params.readPersonalHomeWasRunning() : false,
                    ...(rootMigrationSource && sourceLayout.dataDir !== destinationLayout.dataDir ? { movedToDataDir: destinationLayout.dataDir } : {}),
                }, installUnderHeldLocks);
            }
            return installUnderHeldLocks();
        },
    });
}
