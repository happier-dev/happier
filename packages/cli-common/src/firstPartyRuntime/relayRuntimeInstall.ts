import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
    applyServicePlan,
    buildServiceDefinition,
    planServiceAction,
    resolveServiceBackend,
    type ServiceBackend,
    type ServiceSpec,
} from '../service/index.js';

import { checkRelayRuntimeHealth, resolveRelayRuntimeDefaults } from './relayRuntime.js';
import { applyEnvOverridesToEnvText, parseEnvText, renderSelfHostServerEnvText } from './selfHostServerEnv.js';

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
    const serverBinaryName = platform === 'win32' ? 'happier-server.exe' : 'happier-server';
    const installServerBinaryPath = join(defaults.installRoot, 'bin', serverBinaryName);
    const statePath = join(defaults.installRoot, 'self-host-state.json');
    const configEnvPath = join(defaults.configDir, 'server.env');
    const filesDir = join(defaults.dataDir, 'files');
    const dbDir = join(defaults.dataDir, 'pglite');
    const stdoutPath = join(defaults.logDir, 'server.out.log');
    const stderrPath = join(defaults.logDir, 'server.err.log');

    if (!existsSync(params.serverBinaryPath)) {
        throw new Error('[relay-runtime] server binary not found');
    }

    await mkdir(defaults.installRoot, { recursive: true });
    await mkdir(defaults.configDir, { recursive: true });
    await mkdir(defaults.dataDir, { recursive: true });
    await mkdir(filesDir, { recursive: true });
    await mkdir(dbDir, { recursive: true });
    await mkdir(defaults.logDir, { recursive: true });

    await installBinaryShim({
        platform,
        sourcePath: params.serverBinaryPath,
        destPath: installServerBinaryPath,
    });
    await installBinaryShim({
        platform,
        sourcePath: installServerBinaryPath,
        destPath: join(defaults.binDir, serverBinaryName),
    });

    const baseEnvText = renderSelfHostServerEnvText({
        port: defaults.serverPort,
        host: defaults.serverHost,
        dataDir: defaults.dataDir,
        filesDir,
        dbDir,
        uiDir: '',
        serverBinDir: dirname(params.serverBinaryPath),
        arch,
        platform,
    });
    const envText = params.env && Object.keys(params.env).length > 0
        ? applyEnvOverridesToEnvText(baseEnvText, params.env)
        : baseEnvText;
    await writeFile(configEnvPath, envText, 'utf8');
    const env = parseEnvText(envText);

    const serviceSpec = buildRelayRuntimeServiceSpec({
        serviceName: defaults.serviceName,
        installRoot: defaults.installRoot,
        serverBinaryPath: installServerBinaryPath,
        env,
        stdoutPath,
        stderrPath,
    });
    const backend: ServiceBackend = resolveServiceBackend({
        platform,
        mode,
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

    const baseUrl = `http://${defaults.serverHost}:${defaults.serverPort}`;
    if (params.skipHealthCheck !== true && params.runServiceCommands !== false) {
        const result = await checkRelayRuntimeHealth({
            host: defaults.serverHost,
            port: defaults.serverPort,
            timeoutMs: 30_000,
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
}

