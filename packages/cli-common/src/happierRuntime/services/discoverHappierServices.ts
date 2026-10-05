import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, join, win32 as win32Path } from 'node:path';

import { resolvePublicReleaseRingLabelForId, type PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { resolveHappyHomeDirFromEnvironment } from '../../agents/resolveHappyHomeDir.js';
import { readDefaultManagedReleaseChannelSync } from '../../firstPartyRuntime/defaultReleaseChannelState.js';
import { splitQualifiedWindowsScheduledTaskName } from '../../service/windows.js';
import {
    listKnownServiceDefinitionFiles,
    parseLaunchdPlist,
    parseSystemdUnit,
    parseWindowsScheduledTaskWrapperPs1,
    readLaunchdLoadedStatus,
    readLaunchdServiceEnabled,
    readScheduledTaskStatus,
    readSystemdUnitStatus,
    resolveDaemonServiceTargetMode,
    type ParsedLaunchdPlist,
    type ParsedSystemdUnit,
    type ParsedWindowsScheduledTaskWrapperPs1,
    type ServiceDefinitionFile,
    type ServiceDiscoveryRoot,
} from '../../service/discovery/index.js';
import type {
    HappierService,
    HappierServiceBackend,
    HappierServiceInventory,
    HappierServicePlatform,
    HappierServiceTargetMode,
    HappierServiceType,
    HappierServiceVerification,
} from '../types.js';

type ServiceDefinition =
    | ParsedLaunchdPlist
    | ParsedSystemdUnit
    | ParsedWindowsScheduledTaskWrapperPs1;

type DiscoverFs = Readonly<{
    readFile?: typeof readFile;
}>;

type DiscoverCommandRunner = Readonly<{
    run?: (input: Readonly<{ cmd: string; args: readonly string[] }>) => string | null | Readonly<{
        stdout: string;
        stderr?: string;
        status: number | null;
        error?: unknown;
    }>;
}>;

type DiscoveredServiceIdentity = Readonly<{
    serviceType: HappierServiceType;
    targetMode: HappierServiceTargetMode;
    ring: PublicReleaseRingLabel | null;
    instanceId: string | null;
    serviceInstanceId?: string | null;
}>;

const DAEMON_LAUNCHD_LABEL_PREFIX = 'com.happier.cli.daemon';
const DAEMON_SYSTEMD_LABEL_PREFIX = 'happier-daemon';
const SELF_HOST_LAUNCHD_LABEL_PREFIX = 'happier-server';
const STACK_LABEL_PREFIX = 'dev.happier.stack';
const WINDOWS_SYSTEM_HAPPIER_SERVICES_DIR = 'C:\\ProgramData\\happier\\services';
const EXECUTABLE_NAMES = new Set(['happier', 'hprev', 'hdev', 'hstack', 'happier-server']);
const JAVASCRIPT_RUNTIME_NAMES = new Set(['node', 'node.exe', 'bun', 'bun.exe']);

function normalizePlatform(platform: string | undefined): HappierServicePlatform {
    if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
        return platform;
    }
    return process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
        ? process.platform
        : 'linux';
}

function resolveUserHomeDir(processEnv: NodeJS.ProcessEnv): string {
    const explicit = String(processEnv.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR ?? '').trim();
    if (explicit) return explicit;
    const envHome = String(processEnv.HOME ?? processEnv.USERPROFILE ?? '').trim();
    if (envHome) return envHome;
    try {
        const fromUserInfo = String(userInfo().homedir ?? '').trim();
        if (fromUserInfo) return fromUserInfo;
    } catch {
        // ignore
    }
    return homedir();
}

function resolveDefaultRoots(params: Readonly<{
    platform: HappierServicePlatform;
    processEnv: NodeJS.ProcessEnv;
}>): readonly ServiceDiscoveryRoot[] {
    const userHomeDir = resolveUserHomeDir(params.processEnv);
    const explicitHappierHomeDir = String(params.processEnv.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR ?? '').trim();
    const happierHomeDir = explicitHappierHomeDir || resolveHappyHomeDirFromEnvironment(params.processEnv);
    if (params.platform === 'darwin') {
        return [
            { path: join(userHomeDir, 'Library', 'LaunchAgents'), scope: 'user' },
            { path: join('/Library', 'LaunchDaemons'), scope: 'system' },
        ];
    }
    if (params.platform === 'win32') {
        return [
            { path: join(happierHomeDir, 'services'), scope: 'user' },
            { path: WINDOWS_SYSTEM_HAPPIER_SERVICES_DIR, scope: 'system' },
        ];
    }
    return [
        { path: join(userHomeDir, '.config', 'systemd', 'user'), scope: 'user' },
        { path: join('/etc', 'systemd', 'system'), scope: 'system' },
    ];
}

function parseReleaseRingLabel(raw: string | null | undefined): PublicReleaseRingLabel | null {
    const normalized = String(raw ?? '').trim().toLowerCase();
    if (normalized === 'stable' || normalized === 'preview' || normalized === 'dev') return normalized;
    return null;
}

function splitLabelAfterPrefix(label: string, prefix: string): string[] {
    const remainder = label === prefix ? '' : label.startsWith(`${prefix}.`) ? label.slice(prefix.length + 1) : '';
    return remainder.split('.').map((value) => value.trim()).filter(Boolean);
}

/**
 * The ring a default-following service runs, resolved the way the service itself does: the ring its
 * definition's env names (the service owner writes `HAPPIER_PUBLIC_RELEASE_CHANNEL`), else the
 * default release channel of its Happier home (`default-cli-release-channel.json`, `stable` when
 * none is recorded). Never `null`, so ring-scoped consumers (R12 convergence) see this service.
 */
function resolveDefaultFollowingServiceRing(definition: ServiceDefinition): PublicReleaseRingLabel {
    const envRing = parseReleaseRingLabel(definition.env.HAPPIER_PUBLIC_RELEASE_CHANNEL);
    if (envRing) return envRing;
    const happierHomeDir = String(definition.env.HAPPIER_HOME_DIR ?? '').trim();
    if (!happierHomeDir) return 'stable';
    return resolvePublicReleaseRingLabelForId(readDefaultManagedReleaseChannelSync({ processEnv: { HAPPIER_HOME_DIR: happierHomeDir } }));
}

function resolveDaemonIdentity(label: string, definition: ServiceDefinition): DiscoveredServiceIdentity | null {
    const parts = label.startsWith(DAEMON_LAUNCHD_LABEL_PREFIX)
        ? splitLabelAfterPrefix(label, DAEMON_LAUNCHD_LABEL_PREFIX)
        : label.startsWith(DAEMON_SYSTEMD_LABEL_PREFIX)
            ? splitLabelAfterPrefix(label, DAEMON_SYSTEMD_LABEL_PREFIX)
            : null;
    if (parts === null) return null;

    const labelRing = parts.length > 1 ? parseReleaseRingLabel(parts[0]) : null;
    const serviceInstanceId = (labelRing ? parts.slice(1) : parts).join('.') || 'default';
    const targetMode = resolveDaemonServiceTargetMode(
        definition.env.HAPPIER_DAEMON_SERVICE_TARGET_MODE,
        serviceInstanceId === 'default' ? 'default-following' : 'pinned',
    );

    if (targetMode === 'default-following') {
        return {
            serviceType: 'daemon',
            targetMode,
            ring: resolveDefaultFollowingServiceRing(definition),
            instanceId: null,
            serviceInstanceId,
        };
    }

    const envRing = parseReleaseRingLabel(definition.env.HAPPIER_PUBLIC_RELEASE_CHANNEL);
    const ring = envRing ?? labelRing ?? 'stable';
    const instanceId = String(
        definition.env.HAPPIER_ACTIVE_SERVER_ID ?? serviceInstanceId,
    ).trim() || 'cloud';

    return {
        serviceType: 'daemon',
        targetMode,
        ring,
        instanceId,
        serviceInstanceId,
    };
}

function resolveSelfHostIdentity(label: string, definition: ServiceDefinition): DiscoveredServiceIdentity | null {
    if (!label.startsWith(SELF_HOST_LAUNCHD_LABEL_PREFIX)) return null;

    const remainder = label.slice(SELF_HOST_LAUNCHD_LABEL_PREFIX.length).replace(/^[._-]+/u, '');
    const parts = remainder ? remainder.split(/[._-]+/u).map((value) => value.trim()).filter(Boolean) : [];
    const envRing = parseReleaseRingLabel(definition.env.HAPPIER_PUBLIC_RELEASE_CHANNEL);
    const ring = envRing ?? parseReleaseRingLabel(parts[0]) ?? null;

    return {
        serviceType: 'self-host-service',
        targetMode: 'pinned',
        ring,
        instanceId: null,
    };
}

function resolveStackIdentity(label: string): DiscoveredServiceIdentity | null {
    if (!label.startsWith(STACK_LABEL_PREFIX)) return null;
    const parts = splitLabelAfterPrefix(label, STACK_LABEL_PREFIX);
    return {
        serviceType: 'stack-service',
        targetMode: 'pinned',
        ring: null,
        instanceId: String(parts[0] ?? 'main').trim() || 'main',
    };
}

function resolveServiceIdentity(label: string, definition: ServiceDefinition): DiscoveredServiceIdentity | null {
    return resolveDaemonIdentity(label, definition) ?? resolveSelfHostIdentity(label, definition) ?? resolveStackIdentity(label);
}

function basenameForAnyPlatform(pathValue: string): string {
    const text = String(pathValue ?? '').trim();
    if (!text) return '';
    return text.includes('\\') ? win32Path.basename(text) : basename(text);
}

function resolveExecutablePath(programArgs: readonly string[]): string | null {
    if (programArgs.length === 0) return null;
    const primaryBase = basenameForAnyPlatform(String(programArgs[0] ?? '')).toLowerCase();
    if (JAVASCRIPT_RUNTIME_NAMES.has(primaryBase)) {
        return String(programArgs[1] ?? '').trim() || String(programArgs[0] ?? '').trim() || null;
    }
    for (const arg of programArgs) {
        const normalized = basenameForAnyPlatform(String(arg ?? '').trim()).replace(/\.(exe|mjs|js)$/iu, '').toLowerCase();
        if (EXECUTABLE_NAMES.has(normalized)) {
            return String(arg ?? '').trim() || null;
        }
    }
    return String(programArgs[0] ?? '').trim() || null;
}

export function isDaemonStartSyncCommand(programArgs: readonly string[]): boolean {
    return /\bdaemon\b\s+\bstart-sync\b/iu.test(programArgs.join(' '));
}

function resolveVerification(params: Readonly<{
    identity: DiscoveredServiceIdentity;
    definition: ServiceDefinition;
    executablePath: string | null;
    expectedLabel: string;
}>): HappierServiceVerification {
    const programArgs = params.definition.programArgs.map((value) => String(value ?? '').trim().toLowerCase());
    const executableName = basenameForAnyPlatform(String(params.executablePath ?? '')).replace(/\.(exe|mjs|js)$/iu, '').toLowerCase();
    if (params.identity.serviceType === 'daemon') {
        if (params.definition.kind === 'launchd-plist' && params.definition.label !== params.expectedLabel) return 'candidate';
        return isDaemonStartSyncCommand(params.definition.programArgs) ? 'verified' : 'candidate';
    }
    if (params.identity.serviceType === 'self-host-service') {
        return executableName === 'happier-server' || programArgs.some((value) => basenameForAnyPlatform(value).replace(/\.(exe|mjs|js)$/iu, '').toLowerCase() === 'happier-server')
            ? 'verified'
            : 'candidate';
    }
    return executableName === 'hstack' || programArgs.some((value) => basenameForAnyPlatform(value).replace(/\.(exe|mjs|js)$/iu, '').toLowerCase() === 'hstack')
        ? 'verified'
        : 'candidate';
}

function resolveBackend(params: Readonly<{
    platform: HappierServicePlatform;
    definitionFile: ServiceDefinitionFile;
}>): HappierServiceBackend {
    if (params.platform === 'darwin') return 'launchd';
    if (params.platform === 'win32') return params.definitionFile.scope === 'system' ? 'schtasks-system' : 'schtasks-user';
    return params.definitionFile.scope === 'system' ? 'systemd-system' : 'systemd-user';
}

function resolveInstalledAndRunning(params: Readonly<{
    platform: HappierServicePlatform;
    backend: HappierServiceBackend;
    label: string;
    scope: 'user' | 'system';
    definitionPath: string;
    runner: DiscoverCommandRunner;
    uid: number | null;
}>): Readonly<{ installed: boolean; running: boolean | null; enabled: boolean | null }> {
    const rawRun = params.runner.run;
    const run = rawRun ? (input: Readonly<{ cmd: string; args: readonly string[] }>) => {
        try {
            const result = rawRun(input);
            const output = typeof result === 'string' || result === null ? result
                : result.status === 0 && !result.error ? result.stdout : null;
            return output?.trim() ? output : null;
        } catch {
            return null;
        }
    } : undefined;
    if (!run) {
        return { installed: true, running: null, enabled: null };
    }

    if (params.platform === 'darwin') {
        const output = run({ cmd: 'launchctl', args: ['list', params.label] });
        const status = readLaunchdLoadedStatus({ output: output ?? '' });
        const domain = params.scope === 'system' ? 'system' : params.uid !== null ? `gui/${params.uid}` : null;
        const enabled = domain
            ? readLaunchdServiceEnabled({ output: run({ cmd: 'launchctl', args: ['print-disabled', domain] }), label: params.label })
            : null;
        return { installed: true, running: status.state === 'unknown' ? null : status.pid !== null || status.state === 'loaded', enabled };
    }

    if (params.platform === 'win32') {
        const output = run({
            cmd: 'schtasks',
            args: ['/Query', '/TN', `\\${params.label.startsWith('Happier\\') ? params.label : `Happier\\${params.label}`}`, '/V', '/FO', 'LIST'],
        });
        const status = readScheduledTaskStatus({ output: output ?? '' });
        return { installed: true, running: status.running, enabled: status.enabled };
    }

    const args = [
        ...(params.scope === 'user' ? ['--user'] : []),
        'show',
        `${params.label}.service`,
        '--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,MainPID',
        '--no-pager',
    ];
    const output = run({ cmd: 'systemctl', args });
    const status = readSystemdUnitStatus({ output: output ?? '' });
    return {
        installed: true,
        running: status.activeState === null && status.subState === null ? null : status.activeState === 'active' || status.subState === 'running',
        enabled: readSystemdUnitFileEnabled(status.unitFileState),
    };
}

/** `systemctl` unit-file states: disabled or masked units are not started at login/boot. */
function readSystemdUnitFileEnabled(unitFileState: string | null): boolean | null {
    const state = String(unitFileState ?? '').trim().toLowerCase();
    if (!state) return null;
    if (state === 'disabled' || state.startsWith('masked')) return false;
    if (state.startsWith('enabled') || state === 'static' || state === 'linked' || state === 'alias' || state === 'indirect' || state === 'generated') return true;
    return null;
}

function defaultCommandRunner(input: Readonly<{ cmd: string; args: readonly string[] }>): ReturnType<NonNullable<DiscoverCommandRunner['run']>> {
    const requestedTimeout = Number(process.env.HAPPIER_WINDOWS_SCHTASKS_TIMEOUT_MS);
    const result = spawnSync(input.cmd, [...input.args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
        encoding: 'utf8',
        // Preserve the Scheduler discovery owner's existing configurable deadline.
        ...(input.cmd === 'schtasks' ? { timeout: Number.isInteger(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 15_000 } : {}),
    });
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? ''), status: result.status, error: result.error };
}

function inventoryUnavailable(subject: string, cause: unknown): Error {
    return Object.assign(new Error(`Background service inventory could not be read (${subject}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause }), { code: 'service_inventory_unavailable' as const });
}

function isKnownHappierLabel(label: string): boolean {
    return /^(?:com\.happier\.cli\.daemon|happier-daemon|dev\.happier\.stack)(?:\.|$)/iu.test(label)
        || /^happier-server(?:[._-]|$)/iu.test(label);
}

function runScheduledTaskCommand(runner: DiscoverCommandRunner, args: readonly string[]): string {
    const result = runner.run?.({ cmd: 'schtasks', args });
    if (typeof result === 'string') return result;
    if (!result) throw new Error('Scheduler query returned no result');
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr?.trim() || `schtasks exited with status ${result.status}`);
    return result.stdout;
}

function listScheduledTaskNames(runner: DiscoverCommandRunner): string[] {
    return runScheduledTaskCommand(runner, ['/Query', '/FO', 'CSV', '/NH']).split(/\r?\n/u).flatMap((line) => {
        const rawName = /^"((?:[^"]|"")*)"/u.exec(line.trim())?.[1]?.replaceAll('""', '"').trim();
        if (!rawName) return [];
        const parsed = splitQualifiedWindowsScheduledTaskName(rawName);
        const name = `${parsed.taskPath}${parsed.taskName}`.replace(/^\\+/u, '');
        if (!name.toLowerCase().startsWith('happier\\') || !isKnownHappierLabel(parsed.taskName)) return [];
        return [name];
    });
}

export function readWindowsScheduledTaskWrapperPath(taskName: string, runner: DiscoverCommandRunner = { run: defaultCommandRunner }): string | null {
    let cause: unknown = new Error('Task inspection returned no wrapper path');
    for (const format of ['xml', 'list'] as const) {
        try {
            const output = runScheduledTaskCommand(runner, ['/Query', '/TN', taskName, ...(format === 'xml' ? ['/XML'] : ['/FO', 'LIST', '/V'])]);
            const argumentsText = format === 'xml' ? /<Arguments>([\s\S]*?)<\/Arguments>/iu.exec(output)?.[1] ?? '' : output;
            const decoded = argumentsText.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
            const path = /-File\s+"([^"]+\.ps1)"/iu.exec(decoded)?.[1] ?? /-File\s+([^\s]+\.ps1)/iu.exec(decoded)?.[1];
            if (path) return path.trim();
        } catch (error) {
            cause = error;
        }
    }
    // A detail error is not absence. Only a successful fresh enumeration proves disappearance.
    try {
        if (!listScheduledTaskNames(runner).some((name) => name.toLowerCase() === taskName.toLowerCase())) return null;
    } catch (error) {
        throw inventoryUnavailable(taskName, error);
    }
    throw inventoryUnavailable(taskName, cause);
}

function syntheticTaskDefinition(file: ServiceDefinitionFile): ParsedWindowsScheduledTaskWrapperPs1 {
    const home = file.path.replace(/[\\/]services[\\/][^\\/]+$/iu, '');
    // A missing wrapper has no channel declaration; retain the ring encoded by its installed name.
    const daemonParts = splitLabelAfterPrefix(file.label, DAEMON_SYSTEMD_LABEL_PREFIX);
    const env = {
        ...(file.label.startsWith(DAEMON_SYSTEMD_LABEL_PREFIX)
            ? { HAPPIER_PUBLIC_RELEASE_CHANNEL: (daemonParts.length > 1 ? parseReleaseRingLabel(daemonParts[0]) : null) ?? 'stable' }
            : {}),
        ...(home === file.path ? {} : { HAPPIER_HOME_DIR: home }),
    };
    return {
        kind: 'windows-wrapper-ps1',
        label: file.label,
        env,
        programArgs: [],
        workingDirectory: null,
        stdoutPath: null,
        stderrPath: null,
    };
}

async function parseServiceDefinition(params: Readonly<{
    definitionFile: ServiceDefinitionFile;
    fsApi: DiscoverFs;
}>): Promise<ServiceDefinition | null> {
    const contents = await (params.fsApi.readFile ?? readFile)(params.definitionFile.path, 'utf8').catch((cause: unknown) => {
        if (!isKnownHappierLabel(params.definitionFile.label) || (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) return null;
        throw inventoryUnavailable(`${params.definitionFile.label} at ${params.definitionFile.path}`, cause);
    });
    if (typeof contents !== 'string') return null;

    if (params.definitionFile.kind === 'launchd-plist') {
        return parseLaunchdPlist({ contents, sourcePath: params.definitionFile.path });
    }
    if (params.definitionFile.kind === 'windows-wrapper-ps1') {
        return parseWindowsScheduledTaskWrapperPs1({ contents, sourcePath: params.definitionFile.path });
    }
    return parseSystemdUnit({ contents, sourcePath: params.definitionFile.path });
}

export async function discoverHappierServices(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
    platform?: HappierServicePlatform;
    roots?: readonly ServiceDiscoveryRoot[];
    fs?: DiscoverFs;
    commands?: DiscoverCommandRunner;
    deep?: boolean;
    /** The user whose launchd `gui/<uid>` domain holds user agents; defaults to this process's. */
    uid?: number | null;
}> = {}): Promise<HappierServiceInventory> {
    const uid = params.uid !== undefined ? params.uid : typeof process.getuid === 'function' ? process.getuid() : null;
    const processEnv = params.processEnv ?? process.env;
    const platform = normalizePlatform(params.platform);
    const roots = params.roots ?? resolveDefaultRoots({ platform, processEnv });
    const runner = params.commands ?? { run: defaultCommandRunner };
    const definitionFiles = [...await listKnownServiceDefinitionFiles({ roots }).catch((cause: unknown) => { throw inventoryUnavailable('service definition directories', cause); })];
    const scheduledPaths = new Set<string>();
    if (platform === 'win32') {
        try {
            for (const taskName of listScheduledTaskNames(runner)) {
                const path = readWindowsScheduledTaskWrapperPath(taskName, runner);
                if (!path) continue;
                const pathKey = path.replaceAll('\\', '/').toLowerCase();
                scheduledPaths.add(pathKey);
                if (!definitionFiles.some((file) => file.path.replaceAll('\\', '/').toLowerCase() === pathKey)) {
                    const scope = path.replaceAll('/', '\\').toLowerCase().startsWith(`${WINDOWS_SYSTEM_HAPPIER_SERVICES_DIR.toLowerCase()}\\`) ? 'system' : 'user';
                    definitionFiles.push({ path, scope, kind: 'windows-wrapper-ps1', label: taskName.slice('Happier\\'.length) });
                }
            }
        } catch (cause) {
            throw inventoryUnavailable('Happier scheduled tasks', cause);
        }
    }
    const services: HappierService[] = [];

    for (const definitionFile of definitionFiles) {
        const isScheduledTask = scheduledPaths.has(definitionFile.path.replaceAll('\\', '/').toLowerCase());
        const definition = await parseServiceDefinition({ definitionFile, fsApi: params.fs ?? {} })
            ?? (isScheduledTask ? syntheticTaskDefinition(definitionFile) : null);
        if (!definition) continue;

        const identity = resolveServiceIdentity(definition.label, definition);
        if (!identity) continue;

        const executablePath = resolveExecutablePath(definition.programArgs);
        const backend = resolveBackend({ platform, definitionFile });
        const status = resolveInstalledAndRunning({
            platform,
            backend,
            label: definition.label,
            scope: definitionFile.scope,
            definitionPath: definitionFile.path,
            runner,
            uid,
        });

        const service: HappierService = {
            id: `${backend}:${definition.label}`,
            serviceType: identity.serviceType,
            platform,
            backend,
            label: definition.label,
            targetMode: identity.targetMode,
            verification: resolveVerification({ identity, definition, executablePath, expectedLabel: definitionFile.label }),
            ring: identity.ring,
            instanceId: identity.instanceId,
            activeServerId: String(definition.env.HAPPIER_ACTIVE_SERVER_ID ?? '').trim() || null,
            serviceInstanceId: identity.serviceInstanceId ?? null,
            startupSource: String(definition.env.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim() || null,
            scope: definitionFile.scope,
            definitionPath: definitionFile.path,
            executablePath,
            happierHomeDir: String(definition.env.HAPPIER_HOME_DIR ?? definition.env.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR ?? '').trim() || null,
            serverUrl: String(definition.env.HAPPIER_SERVER_URL ?? '').trim() || null,
            publicServerUrl: String(definition.env.HAPPIER_PUBLIC_SERVER_URL ?? '').trim() || null,
            managedBy: String(definition.env.HAPPIER_DAEMON_SERVICE_MANAGED_BY ?? '').trim() === 'desktop' ? 'desktop' : null,
            installed: status.installed,
            running: status.running,
            enabled: status.enabled,
        };
        if (service.verification === 'candidate' && params.deep !== true && !isScheduledTask) {
            continue;
        }
        services.push(service);
    }

    services.sort((left, right) => left.label.localeCompare(right.label) || left.definitionPath.localeCompare(right.definitionPath));
    return { services };
}
