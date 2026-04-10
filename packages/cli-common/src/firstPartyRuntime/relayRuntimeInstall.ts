import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
import {
    mergeSelfHostServerEnvText,
    parseEnvText,
    renderSelfHostServerEnvText,
    resolveConfiguredSelfHostBaseUrl,
} from './selfHostServerEnv.js';

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

async function installPersistentPayload(params: Readonly<{
    sourceDir: string;
    destDir: string;
    executablePath: string;
}>): Promise<void> {
    await mkdir(params.destDir, { recursive: true });
    await rm(params.destDir, { recursive: true, force: true });
    await copyDirectoryContents({
        sourceDir: params.sourceDir,
        destDir: params.destDir,
    });
    await chmod(params.executablePath, 0o755).catch(() => undefined);
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

    const migrationsSourceDir = join(dirname(params.serverBinaryPath), 'prisma', 'sqlite', 'migrations');
    const migrationsDestDir = join(defaults.dataDir, 'migrations', 'sqlite');
    await mkdir(migrationsDestDir, { recursive: true });
    if (existsSync(migrationsSourceDir)) {
        await copyDirectoryContents({
            sourceDir: migrationsSourceDir,
            destDir: migrationsDestDir,
        });
    }

    await installPersistentPayload({
        sourceDir: dirname(params.serverBinaryPath),
        destDir: dirname(installServerBinaryPath),
        executablePath: installServerBinaryPath,
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
        serverBinDir: dirname(installServerBinaryPath),
        arch,
        platform,
    });
    const existingEnvText = existsSync(configEnvPath) ? await readFile(configEnvPath, 'utf8').catch(() => '') : '';
    const envText = mergeSelfHostServerEnvText({
        baseEnvText,
        existingEnvText,
        overrides: params.env,
    });
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

    const baseUrl = resolveConfiguredSelfHostBaseUrl({
        fallbackBaseUrl: `http://${defaults.serverHost}:${defaults.serverPort}`,
        envText,
    });
    if (params.skipHealthCheck !== true && params.runServiceCommands !== false) {
        const baseUrlObject = new URL(baseUrl);
        const result = await checkRelayRuntimeHealth({
            host: baseUrlObject.hostname,
            port: Number.parseInt(baseUrlObject.port, 10),
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
