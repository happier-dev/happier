import { execFile } from 'child_process';
import type { ExecOptions } from 'child_process';
import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import { join, delimiter as PATH_DELIMITER } from 'path';
import { promisify } from 'util';

import { AGENTS, type CatalogAgentId, type CliDetectSpec } from '@/backends/catalog';
import { resolveCliAuthHomeDir } from '@/capabilities/cliAuth/shared';
import type { CliAuthSpec, CliAuthStatus } from '@/backends/types';
import { resolveProviderCliCommand } from '@/runtime/managedTools/providerCliResolution';
import { resolveJavaScriptRuntimeExecutable } from '@/runtime/js/resolveJavaScriptRuntimeExecutable';
import { AsyncTtlCache } from '@happier-dev/protocol';
import { getProviderCliRuntimeSpec } from '@happier-dev/agents';
import { isProviderCliPathRunnable, providerCliPathRequiresJavaScriptRuntime } from '@happier-dev/cli-common/providers';
import { resolveWindowsCommandInvocation, resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';

const execFileAsync = promisify(execFile);
type ExecFileBestEffortOptions = ExecOptions & Readonly<{ windowsVerbatimArguments?: boolean }>;

export type DetectCliName = CatalogAgentId;

export interface DetectCliRequest {
    /**
     * When true, also probes whether each detected CLI appears to be authenticated.
     * This is best-effort and may return null when unknown/unsupported.
     */
    includeLoginStatus?: boolean;
    bypassCache?: boolean;
    requestedCliNames?: readonly DetectCliName[];
}

export interface DetectCliEntry {
    available: boolean;
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
const CLI_AUTH_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
] as const;

const cliSnapshotCache = new AsyncTtlCache<DetectCliSnapshot>({
    successTtlMs: CLI_SNAPSHOT_TTL_MS,
    errorTtlMs: 2_000,
});

const DEFAULT_CLI_SNAPSHOT_PROBE_TIMEOUT_MS = process.env.CI ? 3_000 : 1_500;
const DEFAULT_CLI_SNAPSHOT_LOGIN_STATUS_PROBE_TIMEOUT_MS = process.env.CI ? 7_000 : 6_500;
const CLI_SNAPSHOT_PROBE_TIMEOUT = Symbol('CLI_SNAPSHOT_PROBE_TIMEOUT');

function resolveCliSnapshotProbeTimeoutMs(includeLoginStatus: boolean): number {
    if (includeLoginStatus) {
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
    return includeLoginStatus
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
    const authEnvFingerprint = params.includeLoginStatus === true
        ? CLI_AUTH_ENV_KEYS.map((key) => `${key}=${String(process.env[key] ?? '')}`).join(':')
        : '';

    // Include all HAPPIER_*_PATH overrides for known agents
    const agentIds = Object.keys(AGENTS);
    const pathOverrides = agentIds
        .map((id) => {
            const envKey = `HAPPIER_${id.toUpperCase()}_PATH`;
            return String(process.env[envKey] ?? '');
        })
        .join(':');

    return `${includeLoginStatus}:${requestedCliNames}:${pathExt}:${path}:${home}:${userProfile}:${happierHomeDir}:${sourcePrefs}:${authEnvFingerprint}:${pathOverrides}`;
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

async function resolveClaudeOutsidePath(): Promise<string | null> {
    const isWindows = process.platform === 'win32';
    const accessMode = isWindows ? fsConstants.F_OK : fsConstants.X_OK;

    const override = typeof process.env.HAPPIER_CLAUDE_PATH === 'string' ? process.env.HAPPIER_CLAUDE_PATH.trim() : '';
    if (override) {
        const resolvedOverride = await resolveCliOverridePath('claude');
        if (resolvedOverride) return resolvedOverride;
    }

    const homeDir = resolveCliAuthHomeDir();
    const candidates: string[] = [];

    if (isWindows) {
        const localAppData = process.env.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
        candidates.push(join(localAppData, 'Claude', 'claude.exe'));
        candidates.push(join(homeDir, '.claude', 'claude.exe'));
    } else {
        // Native installer default location (may not be on PATH for daemons/non-login shells)
        candidates.push(join(homeDir, '.local', 'bin', 'claude'));

        // Common Homebrew locations (in case the daemon PATH is minimal)
        candidates.push('/opt/homebrew/bin/claude');
        candidates.push('/usr/local/bin/claude');
        candidates.push('/home/linuxbrew/.linuxbrew/bin/claude');
        candidates.push(join(homeDir, '.linuxbrew', 'bin', 'claude'));
    }

    for (const candidate of candidates) {
        try {
            await access(candidate, accessMode);
            return candidate;
        } catch {
            // continue
        }
    }

    return null;
}

async function resolveCliOverridePath(name: DetectCliName): Promise<string | null> {
    const isWindows = process.platform === 'win32';
    const accessMode = isWindows ? fsConstants.F_OK : fsConstants.X_OK;
    const override = readCliOverridePath(name);
    if (!override) return null;

    try {
        await access(override, accessMode);
        return override;
    } catch {
        const runtimeSpec = getProviderCliRuntimeSpec(name);
        if (!runtimeSpec.acceptsJavaScriptFileOverride || isWindows) return null;
        if (!/\.(?:c?js|mjs)$/i.test(override)) return null;
        try {
            await access(override, fsConstants.F_OK);
            return override;
        } catch {
            return null;
        }
    }
}

function readCliOverridePath(name: DetectCliName): string | null {
    const envKey = `HAPPIER_${name.toUpperCase()}_PATH`;
    const override = typeof process.env[envKey] === 'string' ? String(process.env[envKey]).trim() : '';
    return override || null;
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

async function isCliPathRunnable(resolvedPath: string): Promise<boolean> {
    const isBunRuntime = typeof process.versions.bun === 'string';
    const runnable = isProviderCliPathRunnable(resolvedPath, process.env, {
        isBunRuntime,
        currentExecPath: process.execPath,
    });
    if (runnable) return true;

    if (!providerCliPathRequiresJavaScriptRuntime(resolvedPath)) {
        return false;
    }

    const pathEnv = typeof process.env.PATH === 'string' ? process.env.PATH : null;
    const nodePath = await resolveCommandOnPath('node', pathEnv);
    return Boolean(nodePath);
}

async function resolveJavaScriptRuntimeExecutableForCliSnapshot(): Promise<string | null> {
    const isBunRuntime = typeof process.versions.bun === 'string';
    const resolved = resolveJavaScriptRuntimeExecutable({
        isBunRuntime,
        processEnv: process.env,
        currentExecPath: process.execPath,
    });
    if (resolved) return resolved;

    const pathEnv = typeof process.env.PATH === 'string' ? process.env.PATH : null;
    return await resolveCommandOnPath('node', pathEnv);
}

async function resolveCliLaunchCommand(params: { resolvedPath: string }): Promise<string> {
    if (!providerCliPathRequiresJavaScriptRuntime(params.resolvedPath)) {
        return quoteShellArgument(params.resolvedPath);
    }

    const runtimeExecutable = await resolveJavaScriptRuntimeExecutableForCliSnapshot();
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

async function resolveCliBinaryNames(name: DetectCliName): Promise<readonly string[]> {
    const binaryNames = (await resolveCliAuthSpec(name))?.binaryNames;
    if (binaryNames && binaryNames.length > 0) return binaryNames;
    return [name];
}

async function detectCliVersion(params: { name: DetectCliName; resolvedPath: string }): Promise<string | null> {
    // Best-effort, must never throw.
    try {
        // Keep this short (runs in parallel for multiple CLIs), but give enough headroom for slower systems.
        const timeoutMs = process.env.CI ? 2500 : 1200;
        const isWindows = process.platform === 'win32';
        const isCmdScript = isWindows && /\.(cmd|bat)$/i.test(params.resolvedPath);
        const needsJavaScriptRuntime = providerCliPathRequiresJavaScriptRuntime(params.resolvedPath);

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
                const { stdout, stderr } = await execFileAsync(file, args, options);
                return { stdout: asString(stdout), stderr: asString(stderr), error: null };
            } catch (error) {
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
            const runtimeExecutable = await resolveJavaScriptRuntimeExecutableForCliSnapshot();
            if (!runtimeExecutable) return null;
            for (const args of argsToTry) {
                const semver = await probeSemverWithRetry(runtimeExecutable, [params.resolvedPath, ...args], {
                    timeout: timeoutMs,
                    windowsHide: true,
                });
                if (semver) return semver;
            }
            return null;
        }

        if (isCmdScript) {
            // .cmd/.bat require cmd.exe.
            const primary = argsToTry.find((args) => args.includes('--version')) ?? ['--version'];
            const invocation = resolveWindowsCommandInvocation({
                command: params.resolvedPath,
                args: primary,
                resolveCommandOnPath: false,
            });
            return await probeSemverWithRetry(invocation.command, invocation.args, {
                timeout: timeoutMs,
                windowsHide: true,
                windowsVerbatimArguments: invocation.windowsVerbatimArguments,
            });
        }

        for (const args of argsToTry) {
            const semver = await probeSemverWithRetry(params.resolvedPath, args, {
                timeout: timeoutMs,
                windowsHide: true,
            });
            if (semver) return semver;
        }

        return null;
    } catch {
        return null;
    }
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
                const { stdout, stderr } = await execFileAsync(file, args, options);
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
    // Best-effort, must never throw.
    try {
        const spec = await resolveCliAuthSpec(params.name);
        if (!spec?.detectAuthStatus) return null;
        const checkedAt = Date.now();
        const draft = await spec.detectAuthStatus({ resolvedPath: params.resolvedPath });
        return {
            checkedAt,
            state: draft.state,
            ...(draft.method !== undefined ? { method: draft.method } : {}),
            ...(draft.accountLabel !== undefined ? { accountLabel: draft.accountLabel } : {}),
            ...(draft.reason !== undefined ? { reason: draft.reason } : {}),
            ...(draft.source !== undefined ? { source: draft.source } : {}),
        };
    } catch {
        return null;
    }
}

async function resolveCliPathForName(
    name: DetectCliName,
    pathEnv: string | null,
): Promise<Readonly<{ resolvedPath: string; resolutionSource: 'override' | 'system' | 'managed' }> | null> {
    const rawOverride = readCliOverridePath(name);
    if (rawOverride) {
        const override = await resolveCliOverridePath(name);
        if (!override) return null;
        if (!await isCliPathRunnable(override)) return null;
        return { resolvedPath: override, resolutionSource: 'override' };
    }

    const managedResolution = resolveProviderCliCommand(name);
    if (managedResolution) {
        if (!await isCliPathRunnable(managedResolution.command)) return null;
        return {
            resolvedPath: managedResolution.command,
            resolutionSource: managedResolution.source,
        };
    }

    const binaryNames = await resolveCliBinaryNames(name);
    for (const binaryName of binaryNames) {
        const resolved = await resolveCommandOnPath(binaryName, pathEnv);
        if (resolved) {
            if (!await isCliPathRunnable(resolved)) continue;
            return { resolvedPath: resolved, resolutionSource: 'system' };
        }
    }

    if (name !== 'claude') return null;
    const resolvedPath = await resolveClaudeOutsidePath();
    if (!resolvedPath) return null;
    if (!await isCliPathRunnable(resolvedPath)) return null;
    return { resolvedPath, resolutionSource: 'system' };
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
    const requestedCliNames = Array.isArray(data?.requestedCliNames)
        ? data.requestedCliNames.filter((name): name is DetectCliName => typeof name === 'string' && Object.prototype.hasOwnProperty.call(AGENTS, name))
        : [];
    const probeTimeoutMs = resolveCliSnapshotProbeTimeoutMs(includeLoginStatus);
    const cacheKey = buildCliSnapshotCacheKey({ includeLoginStatus, requestedCliNames }, pathEnv);
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
            const resolved = await resolveCliPathForName(name, pathEnv);
            if (!resolved) {
                const entry: DetectCliEntry = { available: false };
                return [name, entry] as const;
            }
            const { resolvedPath, resolutionSource } = resolved;

            const [versionResult, authStatusResult, resolvedCommandResult] = await Promise.all([
                withCliSnapshotProbeTimeout(
                    detectCliVersion({ name, resolvedPath }),
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

            const entry: DetectCliEntry = {
                available: true,
                resolvedPath,
                resolutionSource,
                ...(resolvedCommandResult !== CLI_SNAPSHOT_PROBE_TIMEOUT && typeof resolvedCommandResult === 'string'
                    ? { resolvedCommand: resolvedCommandResult }
                    : {}),
                ...(versionResult !== CLI_SNAPSHOT_PROBE_TIMEOUT && typeof versionResult === 'string'
                    ? { version: versionResult }
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
