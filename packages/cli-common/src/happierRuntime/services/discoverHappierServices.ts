import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, join, win32 as win32Path } from 'node:path';

import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { resolveHappyHomeDirFromEnvironment } from '../../agents/resolveHappyHomeDir.js';
import {
    listKnownServiceDefinitionFiles,
    parseLaunchdPlist,
    parseSystemdUnit,
    parseWindowsScheduledTaskWrapperPs1,
    readLaunchdLoadedStatus,
    readScheduledTaskStatus,
    readSystemdUnitStatus,
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
    run?: (input: Readonly<{ cmd: string; args: readonly string[] }>) => string | null;
}>;

type DiscoveredServiceIdentity = Readonly<{
    serviceType: HappierServiceType;
    targetMode: HappierServiceTargetMode;
    ring: PublicReleaseRingLabel | null;
    instanceId: string | null;
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

function resolveDaemonIdentity(label: string, definition: ServiceDefinition): DiscoveredServiceIdentity | null {
    const parts = label.startsWith(DAEMON_LAUNCHD_LABEL_PREFIX)
        ? splitLabelAfterPrefix(label, DAEMON_LAUNCHD_LABEL_PREFIX)
        : label.startsWith(DAEMON_SYSTEMD_LABEL_PREFIX)
            ? splitLabelAfterPrefix(label, DAEMON_SYSTEMD_LABEL_PREFIX)
            : null;
    if (parts === null) return null;

    const targetMode =
        String(definition.env.HAPPIER_DAEMON_SERVICE_TARGET_MODE ?? '').trim().toLowerCase() === 'default-following'
            || parts[0] === 'default'
            ? 'default-following'
            : 'pinned';

    if (targetMode === 'default-following') {
        return {
            serviceType: 'daemon',
            targetMode,
            ring: null,
            instanceId: null,
        };
    }

    const envRing = parseReleaseRingLabel(definition.env.HAPPIER_PUBLIC_RELEASE_CHANNEL);
    const ring = envRing ?? parseReleaseRingLabel(parts[0]) ?? 'stable';
    const instanceId = String(
        definition.env.HAPPIER_ACTIVE_SERVER_ID ??
        (parts.length >= 2 && parseReleaseRingLabel(parts[0]) ? parts[1] : parts[0] ?? 'cloud'),
    ).trim() || 'cloud';

    return {
        serviceType: 'daemon',
        targetMode,
        ring,
        instanceId,
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

function resolveVerification(params: Readonly<{
    identity: DiscoveredServiceIdentity;
    definition: ServiceDefinition;
    executablePath: string | null;
}>): HappierServiceVerification {
    const programArgs = params.definition.programArgs.map((value) => String(value ?? '').trim().toLowerCase());
    const executableName = basenameForAnyPlatform(String(params.executablePath ?? '')).replace(/\.(exe|mjs|js)$/iu, '').toLowerCase();
    if (params.identity.serviceType === 'daemon') {
        return programArgs.includes('daemon') && programArgs.includes('start-sync') ? 'verified' : 'candidate';
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
}>): Readonly<{ installed: boolean; running: boolean }> {
    const run = params.runner.run;
    if (!run) {
        return { installed: true, running: false };
    }

    if (params.platform === 'darwin') {
        const output = run({ cmd: 'launchctl', args: ['list', params.label] });
        const status = readLaunchdLoadedStatus({ output: output ?? '' });
        return { installed: true, running: status.pid !== null || status.state === 'loaded' };
    }

    if (params.platform === 'win32') {
        const output = run({
            cmd: 'schtasks',
            args: ['/Query', '/TN', `\\${params.label.startsWith('Happier\\') ? params.label : `Happier\\${params.label}`}`, '/V', '/FO', 'LIST'],
        });
        const status = readScheduledTaskStatus({ output: output ?? '' });
        return { installed: true, running: status.running === true };
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
    return { installed: true, running: status.activeState === 'active' || status.subState === 'running' };
}

function defaultCommandRunner(input: Readonly<{ cmd: string; args: readonly string[] }>): string | null {
    try {
        const result = spawnSync(input.cmd, [...input.args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: process.env,
        });
        const output = `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`.trim();
        return output || null;
    } catch {
        return null;
    }
}

async function parseServiceDefinition(params: Readonly<{
    definitionFile: ServiceDefinitionFile;
    fsApi: DiscoverFs;
}>): Promise<ServiceDefinition | null> {
    const contents = await (params.fsApi.readFile ?? readFile)(params.definitionFile.path, 'utf8').catch(() => null);
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
}> = {}): Promise<HappierServiceInventory> {
    const processEnv = params.processEnv ?? process.env;
    const platform = normalizePlatform(params.platform);
    const roots = params.roots ?? resolveDefaultRoots({ platform, processEnv });
    const runner = params.commands ?? { run: defaultCommandRunner };
    const definitionFiles = await listKnownServiceDefinitionFiles({ roots });
    const services: HappierService[] = [];

    for (const definitionFile of definitionFiles) {
        const definition = await parseServiceDefinition({ definitionFile, fsApi: params.fs ?? {} });
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
        });

        const service: HappierService = {
            id: `${backend}:${definition.label}`,
            serviceType: identity.serviceType,
            platform,
            backend,
            label: definition.label,
            targetMode: identity.targetMode,
            verification: resolveVerification({ identity, definition, executablePath }),
            ring: identity.ring,
            instanceId: identity.instanceId,
            scope: definitionFile.scope,
            definitionPath: definitionFile.path,
            executablePath,
            happierHomeDir: String(definition.env.HAPPIER_HOME_DIR ?? '').trim() || null,
            serverUrl: String(definition.env.HAPPIER_SERVER_URL ?? '').trim() || null,
            publicServerUrl: String(definition.env.HAPPIER_PUBLIC_SERVER_URL ?? '').trim() || null,
            installed: status.installed,
            running: status.running,
        };
        if (service.verification === 'candidate' && params.deep !== true) {
            continue;
        }
        services.push(service);
    }

    services.sort((left, right) => left.label.localeCompare(right.label) || left.definitionPath.localeCompare(right.definitionPath));
    return { services };
}
