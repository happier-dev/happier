import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import { join, delimiter as PATH_DELIMITER } from 'path';

import { AGENTS } from '@/agent/catalog/registry';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import type { CliDetectSpec } from '@/agent/catalog/types';
import type { CliAuthSpec, CliAuthStatus } from '@/capabilities/cliAuth/types';
import { detectNativeAgentCliAuthStatus } from '@/capabilities/cliAuth/detectNativeAgentCliAuthStatus';
import {
    resolveAgentCliCommandForRuntime,
    resolveAgentCliJavaScriptRuntimeOnDaemonPath as resolveJavaScriptRuntimeExecutableForCliSnapshot,
} from '@/packagedRuntime/managedTools/agentCliResolution';
import { resolveAgentCliRuntimeSpecForLookupId } from '@/packagedRuntime/managedTools/requireAgentCliCommand';
import { AsyncTtlCache } from '@happier-dev/protocol/common/asyncTtlCache';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol';
import { resolveAgentSetupInstall, resolveAgentSetupPlatform } from '@happier-dev/protocol/agents/setup';
import { getRuntimeInstallableAdapter } from '@/packagedRuntime/installables/registry';
import {
    resolveAgentRuntimeManagedDependencyId,
    resolveExecutableManagedDependenciesRegistry,
    selectExecutableManagedDependencies,
} from '@/plugins/projection/registry/managedDependencyExecutables';
import {
    type AgentCliRuntimeDescriptor,
    agentCliPathRequiresJavaScriptRuntime,
    resolveAgentCliJavaScriptRuntimeCommand,
    classifyAgentCliInstall,
    resolvePlatformFromNodePlatform,
} from '@happier-dev/cli-common/agents';
import {
    execFileWithDeadline,
    ExecFileTerminationError,
    resolveWindowsCommandInvocation,
    resolveWindowsCommandOnPath,
    type ExecFileWithDeadlineOptions,
} from '@happier-dev/cli-common/process';

/**
 * Version probing reads the CLI's OUTPUT, so the budget must not be `child_process`'s own
 * `timeout`: on a stalled loop that destroys a finished child's banner and still reports success,
 * leaving a genuinely installed CLI with `version: null`.
 */
type ExecFileBestEffortOptions = ExecFileWithDeadlineOptions;

export type DetectCliName = string;

export interface DetectCliRequest {
    /**
     * When true, also probes whether each detected CLI appears to be authenticated.
     * This is best-effort and may return null when unknown/unsupported.
     */
    includeLoginStatus?: boolean;
    bypassCache?: boolean;
    /**
     * Probe versions with the slow-probe budget instead of the ambient one. Used to
     * verify an update, where a slow `--version` must not read as "no version".
     */
    verifyVersion?: boolean;
    requestedCliNames?: readonly DetectCliName[];
}

export interface DetectCliEntry {
    available: boolean;
    /** Own CLI execution, never inferred from an installed dependency. */
    installed?: boolean;
    signIn?: MachineAgentInventoryItem['signIn'];
    platform?: MachineAgentInventoryItem['platform'];
    install?: MachineAgentInventoryItem['install'];
    dependencies?: MachineAgentInventoryItem['dependencies'];
    update?: MachineAgentInventoryItem['update'];
    resolvedPath?: string;
    resolvedCommand?: string;
    resolutionSource?: 'override' | 'system' | 'managed';
    version?: string;
    isLoggedIn?: boolean | null;
    authStatus?: CliAuthStatus | null;
    /**
     * Optional ACP agent capability probe results for CLIs that can run in ACP mode.
     * This is only populated when a capabilities request explicitly asks for it.
     */
    acp?: {
        ok: boolean;
        checkedAt: number;
        loadSession?: boolean | null;
        agentCapabilities?: {
            loadSession: boolean;
            sessionCapabilities: Record<string, unknown>;
            promptCapabilities: {
                image: boolean;
                audio: boolean;
                embeddedContext: boolean;
            };
            mcpCapabilities: {
                http: boolean;
                sse: boolean;
            };
        } | null;
        error?: { message: string };
    };
}

export interface DetectTmuxEntry {
    available: boolean;
    resolvedPath?: string;
    version?: string;
}

export interface DetectWindowsTerminalEntry {
    available: boolean;
    resolvedPath?: string;
}

export interface DetectCliSnapshot {
    path: string | null;
    clis: Record<DetectCliName, DetectCliEntry>;
    tmux: DetectTmuxEntry;
    windowsTerminal: DetectWindowsTerminalEntry;
}

const CLI_SNAPSHOT_TTL_MS = 30_000;
const cliSnapshotCache = new AsyncTtlCache<DetectCliSnapshot>({
    successTtlMs: CLI_SNAPSHOT_TTL_MS,
    errorTtlMs: 2_000,
});

const DEFAULT_CLI_SNAPSHOT_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS = process.env.CI ? 7_000 : 6_500;
const CLI_SNAPSHOT_PROBE_TIMEOUT = Symbol('CLI_SNAPSHOT_PROBE_TIMEOUT');

function resolveCliSnapshotProbeTimeoutMs(slowProbes: boolean): number {
    if (slowProbes) {
        const rawLoginStatus = process.env.HAPPIER_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS;
        const parsedLoginStatus = typeof rawLoginStatus === 'string' ? Number(rawLoginStatus) : Number.NaN;
        if (Number.isFinite(parsedLoginStatus) && parsedLoginStatus > 0) {
            return parsedLoginStatus;
        }
    }

    const raw = process.env.HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS;
    const parsed = typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return slowProbes
        ? DEFAULT_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS
        : DEFAULT_CLI_SNAPSHOT_PROBE_TIMEOUT_MS;
}

async function withCliSnapshotProbeTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof CLI_SNAPSHOT_PROBE_TIMEOUT> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<typeof CLI_SNAPSHOT_PROBE_TIMEOUT>((resolve) => {
                timeoutId = setTimeout(() => resolve(CLI_SNAPSHOT_PROBE_TIMEOUT), timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    }
}

function buildCliSnapshotCacheKey(params: DetectCliRequest, pathEnv: string | null): string {
    const includeLoginStatus = params.includeLoginStatus === true ? '1' : '0';
    const verifyVersion = params.verifyVersion === true ? '1' : '0';
    const requestedCliNames = Array.isArray(params.requestedCliNames)
        ? params.requestedCliNames.map((value) => String(value)).sort().join(',')
        : '';
    const path = String(pathEnv ?? '');
    const pathExt = process.platform === 'win32' ? String(process.env.PATHEXT ?? '') : '';
    const home = String(process.env.HOME ?? '');
    const userProfile = String(process.env.USERPROFILE ?? '');

    // Include environment variables that affect CLI resolution and auth.
    // Provider resolution can fall back to HOME/USERPROFILE when HAPPIER_HOME_DIR is unset,
    // and auth probes also read provider files from HOME/USERPROFILE.
    const happierHomeDir = String(process.env.HAPPIER_HOME_DIR ?? '');
    const sourcePrefs = String(process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON ?? '');
    const registry = readCurrentContributionRegistry();
    const authEnvKeys = new Set<string>();
    if (params.includeLoginStatus === true) {
        for (const agent of registry.agents) {
            if (params.requestedCliNames?.length && !params.requestedCliNames.includes(agent.id)) continue;
            for (const key of agent.cliMetadata?.auth.environmentVariables ?? []) authEnvKeys.add(key);
            // Declared process environment includes status-command homes such as CODEX_HOME.
            for (const request of [...(agent.hostAccess?.required ?? []), ...(agent.hostAccess?.optional ?? [])]) {
                if (request.capability === 'process') {
                    for (const key of request.scope.envKeys ?? []) authEnvKeys.add(key);
                }
            }
        }
    }
    const authEnvFingerprint = JSON.stringify([...authEnvKeys].sort().map((key) => [key, process.env[key] ?? '']));

    // Include all HAPPIER_*_PATH overrides for known agents
    const agentIds = Object.keys(AGENTS);
    const pathOverrides = agentIds
        .map((id) => {
            const envKey = `HAPPIER_${id.toUpperCase()}_PATH`;
            return String(process.env[envKey] ?? '');
        })
        .join(':');

    return `${includeLoginStatus}:${verifyVersion}:${requestedCliNames}:${pathExt}:${path}:${home}:${userProfile}:${happierHomeDir}:${sourcePrefs}:${authEnvFingerprint}:${pathOverrides}`;
}

async function resolveCommandOnPath(command: string, pathEnv: string | null): Promise<string | null> {
    if (!pathEnv) return null;

    if (process.platform === 'win32') {
        return resolveWindowsCommandOnPath(command, { ...process.env, PATH: pathEnv });
    }

    const segments = pathEnv
        .split(PATH_DELIMITER)
        .map((p) => p.trim())
        .filter(Boolean);

    for (const dir of segments) {
        const candidate = join(dir, command);
        try {
            await access(candidate, fsConstants.X_OK);
            return candidate;
        } catch {
            // continue
        }
    }

    return null;
}

function getFirstLine(value: string): string | null {
    const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
    if (!normalized) return null;
    const [first] = normalized.split('\n');
    const trimmed = first.trim();
    if (!trimmed) return null;
    return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

function extractSemver(value: string | null): string | null {
    if (!value) return null;
    const match = value.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
    return match?.[0] ?? null;
}

function extractTmuxVersion(value: string | null): string | null {
    if (!value) return null;
    const match = value.match(/\btmux\s+([0-9]+(?:\.[0-9]+)?[a-z]?)\b/i);
    return match?.[1] ?? null;
}

function quoteShellArgument(value: string): string {
    if (process.platform === 'win32') {
        return `"${value.replaceAll('"', '""')}"`;
    }
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function resolveCliLaunchCommand(params: { resolvedPath: string }): Promise<string> {
    if (!agentCliPathRequiresJavaScriptRuntime(params.resolvedPath)) {
        return quoteShellArgument(params.resolvedPath);
    }

    const runtimeExecutable = await resolveJavaScriptRuntimeExecutableForCliSnapshot(params.resolvedPath);
    if (!runtimeExecutable) return quoteShellArgument(params.resolvedPath);
    return `${quoteShellArgument(runtimeExecutable)} ${quoteShellArgument(params.resolvedPath)}`;
}

function defaultVersionArgsToTry(): Array<string[]> {
    return [['--version'], ['version'], ['-v']];
}

const cliDetectCache = new Map<DetectCliName, CliDetectSpec | null>();
const cliAuthSpecCache = new Map<DetectCliName, CliAuthSpec | null>();

async function resolveCliDetectSpec(name: DetectCliName): Promise<CliDetectSpec | null> {
    if (cliDetectCache.has(name)) {
        return cliDetectCache.get(name) ?? null;
    }

    const entry = AGENTS[name];
    if (!entry?.getCliDetect) {
        cliDetectCache.set(name, null);
        return null;
    }

    const spec = await entry.getCliDetect();
    cliDetectCache.set(name, spec);
    return spec;
}

async function resolveCliVersionArgsToTry(name: DetectCliName): Promise<Array<string[]>> {
    const spec = (await resolveCliDetectSpec(name))?.versionArgsToTry;
    if (!spec || spec.length === 0) return defaultVersionArgsToTry();
    return spec.map((v) => [...v]);
}

async function resolveCliAuthSpec(name: DetectCliName): Promise<CliAuthSpec | null> {
    if (cliAuthSpecCache.has(name)) {
        return cliAuthSpecCache.get(name) ?? null;
    }

    const entry = AGENTS[name];
    if (!entry?.getCliAuthSpec) {
        cliAuthSpecCache.set(name, null);
        return null;
    }

    const spec = await entry.getCliAuthSpec();
    cliAuthSpecCache.set(name, spec);
    return spec;
}

function resolveCliVersionExecTimeoutMs(snapshotProbeTimeoutMs: number): number {
    return Math.max(500, snapshotProbeTimeoutMs - 100);
}

async function probeCliExecution(params: { name: DetectCliName; resolvedPath: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; execFile?: typeof execFileWithDeadline }): Promise<Readonly<{ installed: boolean; version: string | null }>> {
    let installed = false;
    let detectedVersion: string | null = null;
    const result = (version: string | null) => ({ installed, version });
    // Ordinary probe failures are best-effort; cancellation and failed containment must escape.
    try {
        // Keep this within the outer snapshot probe budget. JS-backed CLIs can take
        // noticeably longer to start under load, so this must not use a smaller
        // hidden timeout than the configured snapshot budget.
        const timeoutMs = resolveCliVersionExecTimeoutMs(params.timeoutMs);
        const isWindows = process.platform === 'win32';
        const isCmdScript = isWindows && /\.(cmd|bat)$/i.test(params.resolvedPath);
        const needsJavaScriptRuntime = agentCliPathRequiresJavaScriptRuntime(params.resolvedPath);

        const asString = (value: unknown): string => {
            if (typeof value === 'string') return value;
            if (Buffer.isBuffer(value)) return value.toString('utf8');
            return '';
        };

        const argsToTry: Array<string[]> = await (async () => {
            try {
                return await resolveCliVersionArgsToTry(params.name);
            } catch {
                return defaultVersionArgsToTry();
            }
        })();

        const isTransientExecFileError = (error: unknown): boolean => {
            if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
            const code = (error as any).code;
            if (typeof code === 'string' && ['EAGAIN', 'EMFILE', 'ENFILE', 'ETXTBSY'].includes(code)) return true;
            if ((error as any).killed === true) return true;
            return false;
        };

        const execFileBestEffort = async (
            file: string,
            args: string[],
            options: ExecFileBestEffortOptions,
        ): Promise<{ stdout: string; stderr: string; error: unknown | null }> => {
            try {
                const { stdout, stderr } = await (params.execFile ?? execFileWithDeadline)(file, args, options);
                installed = true;
                return { stdout: asString(stdout), stderr: asString(stderr), error: null };
            } catch (error) {
                if (error instanceof ExecFileTerminationError) throw error;
                params.signal?.throwIfAborted();
                // For non-zero exit codes, execFile still provides stdout/stderr on the error object.
                const maybeStdout = asString((error as any)?.stdout);
                const maybeStderr = asString((error as any)?.stderr);
                return { stdout: maybeStdout, stderr: maybeStderr, error };
            }
        };

	        const probeSemverOnce = async (
	            file: string,
	            args: string[],
	            options: ExecFileBestEffortOptions,
	        ): Promise<{ semver: string | null; error: unknown | null; combinedTrimmed: string }> => {
	            const { stdout, stderr, error } = await execFileBestEffort(file, args, options);
	            const combined = `${stdout}\n${stderr}`;
	            const combinedTrimmed = combined.trim();
	            const firstLine = getFirstLine(combined);
	            const semver = extractSemver(firstLine) ?? extractSemver(combined);
	            return { semver, error, combinedTrimmed };
	        };

        const probeSemverWithRetry = async (
            file: string,
            args: string[],
            options: ExecFileBestEffortOptions,
	        ): Promise<string | null> => {
	            const first = await probeSemverOnce(file, args, options);
	            if (first.semver) return first.semver;

	            const shouldRetry =
	                (first.error && isTransientExecFileError(first.error))
	                || (!first.error && first.combinedTrimmed.length === 0);
	            if (!shouldRetry) return null;

	            // Best-effort retry for transient spawn/timeout failures (can happen under load).
	            await new Promise((resolve) => setTimeout(resolve, 0));
	            const second = await probeSemverOnce(file, args, options);
	            return second.semver;
        };

        if (needsJavaScriptRuntime) {
            const runtimeExecutable = params.env
                ? resolveAgentCliJavaScriptRuntimeCommand(params.resolvedPath, params.env, { isBunRuntime: typeof process.versions.bun === 'string', currentExecPath: process.execPath })
                : await resolveJavaScriptRuntimeExecutableForCliSnapshot(params.resolvedPath);
            if (!runtimeExecutable) return result(null);
            for (const args of argsToTry) {
                const semver = await probeSemverWithRetry(runtimeExecutable, [params.resolvedPath, ...args], {
                    timeout: timeoutMs,
                    windowsHide: true,
                    env: params.env,
                    signal: params.signal,
                });
                detectedVersion = semver ?? detectedVersion;
                if (semver && installed) return result(semver);
            }
            return result(detectedVersion);
        }

        if (isCmdScript) {
            // .cmd/.bat require cmd.exe.
            for (const args of argsToTry) {
                const invocation = resolveWindowsCommandInvocation({
                    command: params.resolvedPath,
                    args,
                    resolveCommandOnPath: false,
                });
                const semver = await probeSemverWithRetry(invocation.command, invocation.args, {
                    timeout: timeoutMs,
                    windowsHide: true,
                    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
                    env: params.env,
                    signal: params.signal,
                });
                detectedVersion = semver ?? detectedVersion;
                if (semver && installed) return result(semver);
            }
            return result(detectedVersion);
        }

        for (const args of argsToTry) {
            const semver = await probeSemverWithRetry(params.resolvedPath, args, {
                timeout: timeoutMs,
                windowsHide: true,
                env: params.env,
                signal: params.signal,
            });
            detectedVersion = semver ?? detectedVersion;
            if (semver && installed) return result(semver);
        }

        return result(detectedVersion);
    } catch (error) {
        if (error instanceof ExecFileTerminationError) throw error;
        params.signal?.throwIfAborted();
        return result(null);
    }
}

/** Fresh install verification uses the same resolver and version probe as inventory. */
export async function probeAgentCliForInstall(params: Readonly<{
    runtimeSpec: AgentCliRuntimeDescriptor;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    execFile?: typeof execFileWithDeadline;
}>): Promise<DetectCliEntry> {
    params.signal?.throwIfAborted();
    const resolution = resolveAgentCliCommandForRuntime(params.runtimeSpec, { processEnv: params.env ?? process.env });
    if (!resolution) return { available: false, installed: false };
    const probe = await probeCliExecution({
        name: params.runtimeSpec.id,
        resolvedPath: resolution.command,
        timeoutMs: resolveCliSnapshotProbeTimeoutMs(true),
        env: params.env ?? process.env,
        signal: params.signal,
        execFile: params.execFile,
    });
    return { available: probe.installed, installed: probe.installed, resolvedPath: resolution.command, resolutionSource: resolution.source, ...(probe.version ? { version: probe.version } : {}) };
}

async function detectTmuxVersion(params: { resolvedPath: string }): Promise<string | null> {
    // Best-effort, must never throw.
    try {
        const timeoutMs = 1500;
        const isWindows = process.platform === 'win32';
        const isCmdScript = isWindows && /\.(cmd|bat)$/i.test(params.resolvedPath);

        const asString = (value: unknown): string => {
            if (typeof value === 'string') return value;
            if (Buffer.isBuffer(value)) return value.toString('utf8');
            return '';
        };

        const execFileBestEffort = async (file: string, args: string[], options: ExecFileBestEffortOptions): Promise<{ stdout: string; stderr: string }> => {
            try {
                const { stdout, stderr } = await execFileWithDeadline(file, args, options);
                return { stdout: asString(stdout), stderr: asString(stderr) };
            } catch (error) {
                const maybeStdout = asString((error as any)?.stdout);
                const maybeStderr = asString((error as any)?.stderr);
                return { stdout: maybeStdout, stderr: maybeStderr };
            }
        };

        if (isCmdScript) {
            const invocation = resolveWindowsCommandInvocation({
                command: params.resolvedPath,
                args: ['-V'],
                resolveCommandOnPath: false,
            });
            const { stdout, stderr } = await execFileBestEffort(invocation.command, invocation.args, {
                timeout: timeoutMs,
                windowsHide: true,
                windowsVerbatimArguments: invocation.windowsVerbatimArguments,
            });
            return extractTmuxVersion(getFirstLine(`${stdout}\n${stderr}`));
        }

        const { stdout, stderr } = await execFileBestEffort(params.resolvedPath, ['-V'], {
            timeout: timeoutMs,
            windowsHide: true,
        });
        return extractTmuxVersion(getFirstLine(`${stdout}\n${stderr}`));
    } catch {
        return null;
    }
}

async function detectCliAuthStatus(params: { name: DetectCliName; resolvedPath: string }): Promise<CliAuthStatus | null> {
    return detectNativeAgentCliAuthStatus({
        agentId: params.name,
        resolvedPath: params.resolvedPath,
        authSpec: await resolveCliAuthSpec(params.name),
    });
}

async function resolveCliPathForName(
    name: DetectCliName,
): Promise<Readonly<{ resolvedPath: string; resolutionSource: 'override' | 'system' | 'managed' }> | null> {
    const resolved = resolveAgentCliCommandForRuntime(resolveAgentCliRuntimeSpecForLookupId(name));
    return resolved ? { resolvedPath: resolved.command, resolutionSource: resolved.source } : null;
}

async function detectAgentSetupFacts(name: DetectCliName): Promise<Pick<MachineAgentInventoryItem, 'platform' | 'install' | 'dependencies' | 'signIn'>> {
    const registry = readCurrentContributionRegistry();
    const agent = registry.agentDefinitionsById.get(name);
    const dependencyId = agent ? resolveAgentRuntimeManagedDependencyId(agent) : null;
    const declarations = (registry.managedDependencies ?? []).filter((entry) => (
        entry.pluginId && buildQualifiedPluginContributionKey({ pluginId: entry.pluginId, localId: entry.definition.id }) === dependencyId
    ));
    const metadata = {
        cli: agent?.cliMetadata,
        dependencies: declarations.flatMap((entry) => 'version' in entry.definition ? [] : [entry.definition]),
        platform: process.platform,
        arch: process.arch,
    };
    const dependencies: MachineAgentInventoryItem['dependencies'] = [];
    if (dependencyId) {
        const installablesRegistry = resolveExecutableManagedDependenciesRegistry(declarations);
        const candidates = await Promise.all(selectExecutableManagedDependencies(declarations).map(async ({ definition }) => {
            const adapter = await getRuntimeInstallableAdapter(definition.key, { installablesRegistry });
            const launch = await adapter.detectLaunchResolution({ env: process.env });
            const status = launch.availability.ok && adapter.detectCapabilityStatus
                ? await adapter.detectCapabilityStatus({ env: process.env, onlyIfInstalled: true })
                : null;
            const version = status && typeof status === 'object'
                ? Reflect.get(status, 'version') ?? Reflect.get(status, 'installedVersion')
                : null;
            return { key: definition.key, installed: launch.availability.ok, version: typeof version === 'string' ? version : null };
        }));
        // Sources are alternatives for one declared prerequisite, not separate required installs.
        dependencies.push(candidates.find((entry) => entry.installed) ?? candidates[0]
            ?? { key: dependencyId, installed: false, version: null });
    }
    return {
        platform: resolveAgentSetupPlatform(metadata),
        install: resolveAgentSetupInstall(metadata),
        dependencies,
        signIn: { status: 'unknown', loginSupport: agent?.cliMetadata?.auth.support ?? 'unsupported' },
    };
}

/**
 * Drops every cached snapshot. Called after something changed an installed CLI (an update),
 * so the next ordinary detect reports what is installed now rather than a pre-change snapshot.
 */
export function invalidateCliSnapshots(): void {
    cliSnapshotCache.clear();
}

/**
 * CLI status snapshot - checks whether CLIs are resolvable on daemon PATH.
 *
 * This is more reliable than the `bash` RPC for "is CLI installed?" checks because it:
 * - does not rely on a login shell (no ~/.zshrc, ~/.profile, etc)
 * - matches how the daemon itself will resolve binaries when spawning
 */
export async function detectCliSnapshotOnDaemonPath(data: DetectCliRequest): Promise<DetectCliSnapshot> {
    const pathEnv = typeof process.env.PATH === 'string' ? process.env.PATH : null;
    const includeLoginStatus = Boolean(data?.includeLoginStatus);
    const verifyVersion = data?.verifyVersion === true;
    const requestedCliNames = Array.isArray(data?.requestedCliNames)
        ? data.requestedCliNames.filter((name): name is DetectCliName => typeof name === 'string' && Object.prototype.hasOwnProperty.call(AGENTS, name))
        : [];
    const probeTimeoutMs = resolveCliSnapshotProbeTimeoutMs(includeLoginStatus || verifyVersion);
    const cacheKey = buildCliSnapshotCacheKey({ includeLoginStatus, requestedCliNames, verifyVersion }, pathEnv);
    const cached = data?.bypassCache ? null : cliSnapshotCache.get(cacheKey);
    if (!data?.bypassCache && cached?.kind === 'success' && cliSnapshotCache.isFresh(cached)) return cached.value;

    return await cliSnapshotCache.runDedupe(cacheKey, async () => {
        const cached2 = cliSnapshotCache.get(cacheKey);
        if (!data?.bypassCache && cached2?.kind === 'success' && cliSnapshotCache.isFresh(cached2)) return cached2.value;

    const names = requestedCliNames.length > 0
        ? requestedCliNames
        : Object.keys(AGENTS) as DetectCliName[];

    const pairs = await Promise.all(
        names.map(async (name) => {
            const [resolved, setupFacts] = await Promise.all([resolveCliPathForName(name), detectAgentSetupFacts(name)]);
            if (!resolved) {
                const entry: DetectCliEntry = { available: false, installed: false, ...setupFacts, update: { supported: false, command: null } };
                return [name, entry] as const;
            }
            const { resolvedPath, resolutionSource } = resolved;

            const [versionResult, authStatusResult, resolvedCommandResult] = await Promise.all([
                withCliSnapshotProbeTimeout(
                    probeCliExecution({ name, resolvedPath, timeoutMs: probeTimeoutMs }),
                    probeTimeoutMs,
                ),
                includeLoginStatus
                    ? withCliSnapshotProbeTimeout(
                        detectCliAuthStatus({ name, resolvedPath }),
                        probeTimeoutMs,
                    )
                    : Promise.resolve(null),
                withCliSnapshotProbeTimeout(
                    resolveCliLaunchCommand({ resolvedPath }),
                    probeTimeoutMs,
                ),
            ]);

            const authStatus = (() => {
                if (!includeLoginStatus) return null;
                if (authStatusResult === CLI_SNAPSHOT_PROBE_TIMEOUT) {
                    return {
                        checkedAt: Date.now(),
                        state: 'unknown',
                        reason: 'timeout',
                        source: 'command',
                    } satisfies CliAuthStatus;
                }
                return authStatusResult;
            })();

            const isLoggedIn = includeLoginStatus
                ? (authStatus?.state === 'logged_in'
                    ? true
                    : authStatus?.state === 'logged_out'
                        ? false
                        : null)
                : null;

            const installed = versionResult !== CLI_SNAPSHOT_PROBE_TIMEOUT && versionResult.installed;
            const platform = resolvePlatformFromNodePlatform(process.platform);
            const update = installed && platform
                ? classifyAgentCliInstall({ runtimeSpec: resolveAgentCliRuntimeSpecForLookupId(name), command: resolvedPath, source: resolutionSource, platform, env: process.env })
                : null;

            const entry: DetectCliEntry = {
                available: true,
                installed,
                ...setupFacts,
                signIn: {
                    status: authStatus?.state === 'logged_in' ? 'signedIn' : authStatus?.state === 'logged_out' ? 'signedOut' : 'unknown',
                    loginSupport: setupFacts.signIn.loginSupport,
                    ...(typeof authStatus?.accountLabel === 'string' ? { accountLabel: authStatus.accountLabel } : {}),
                },
                update: { supported: update?.updateSupported ?? false, command: update?.updateCommand ?? null },
                resolvedPath,
                resolutionSource,
                ...(resolvedCommandResult !== CLI_SNAPSHOT_PROBE_TIMEOUT && typeof resolvedCommandResult === 'string'
                    ? { resolvedCommand: resolvedCommandResult }
                    : {}),
                ...(versionResult !== CLI_SNAPSHOT_PROBE_TIMEOUT && versionResult.version
                    ? { version: versionResult.version }
                    : {}),
                ...(includeLoginStatus ? { isLoggedIn } : {}),
                ...(includeLoginStatus ? { authStatus } : {}),
            };

            return [name, entry] as const;
        }),
    );

    const tmuxResolvedPath = await resolveCommandOnPath('tmux', pathEnv);
    const tmux: DetectTmuxEntry = (() => {
        if (!tmuxResolvedPath) return { available: false };
        return { available: true, resolvedPath: tmuxResolvedPath };
    })();

    const windowsTerminalResolvedPath = await resolveCommandOnPath('wt.exe', pathEnv);
    const windowsTerminal: DetectWindowsTerminalEntry = (() => {
        if (!windowsTerminalResolvedPath) return { available: false };
        return { available: true, resolvedPath: windowsTerminalResolvedPath };
    })();

    if (tmux.available && tmuxResolvedPath) {
        const version = await detectTmuxVersion({ resolvedPath: tmuxResolvedPath });
        if (typeof version === 'string') {
            tmux.version = version;
        }
    }

    const pairEntries = Object.fromEntries(pairs) as Partial<Record<DetectCliName, DetectCliEntry>>;

    return {
        path: pathEnv,
        clis: Object.fromEntries(
            (Object.keys(AGENTS) as DetectCliName[]).map((name) => [name, pairEntries[name] ?? { available: false }]),
        ) as Record<DetectCliName, DetectCliEntry>,
        tmux,
        windowsTerminal,
    };
    }).then((snapshot) => {
        cliSnapshotCache.setSuccess(cacheKey, snapshot);
        return snapshot;
    }).catch(() => {
        // Best-effort: never throw from a snapshot helper.
        cliSnapshotCache.setError(cacheKey);
        const names = Object.keys(AGENTS) as DetectCliName[];
        const clis = Object.fromEntries(names.map((name) => [name, { available: false } satisfies DetectCliEntry])) as Record<DetectCliName, DetectCliEntry>;
        return { path: pathEnv, clis, tmux: { available: false }, windowsTerminal: { available: false } };
    });
}
