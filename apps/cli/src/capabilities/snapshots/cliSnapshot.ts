import { execFile } from 'child_process';
import type { ExecOptions } from 'child_process';
import { constants as fsConstants } from 'fs';
import { access } from 'fs/promises';
import { homedir } from 'os';
import { join, delimiter as PATH_DELIMITER } from 'path';
import { promisify } from 'util';

import { AGENTS, type CatalogAgentId, type CliDetectSpec } from '@/backends/catalog';

const execFileAsync = promisify(execFile);

function resolveHomeDir(): string {
    const envHome =
        process.platform === 'win32'
            ? (process.env.USERPROFILE || process.env.HOME)
            : process.env.HOME;
    const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
    return trimmed.length > 0 ? trimmed : homedir();
}

export type DetectCliName = CatalogAgentId;

export interface DetectCliRequest {
    /**
     * When true, also probes whether each detected CLI appears to be authenticated.
     * This is best-effort and may return null when unknown/unsupported.
     */
    includeLoginStatus?: boolean;
}

export interface DetectCliEntry {
    available: boolean;
    resolvedPath?: string;
    version?: string;
    isLoggedIn?: boolean | null;
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

export interface DetectCliSnapshot {
    path: string | null;
    clis: Record<DetectCliName, DetectCliEntry>;
    tmux: DetectTmuxEntry;
}

async function resolveCommandOnPath(command: string, pathEnv: string | null): Promise<string | null> {
    if (!pathEnv) return null;

    const segments = pathEnv
        .split(PATH_DELIMITER)
        .map((p) => p.trim())
        .filter(Boolean);

    const isWindows = process.platform === 'win32';
    const extensions = isWindows
        ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
            .split(';')
            .map((e) => e.trim())
            .filter(Boolean)
        : [''];

    for (const dir of segments) {
        for (const ext of extensions) {
            const candidate = join(dir, isWindows ? `${command}${ext}` : command);
            try {
                await access(candidate, isWindows ? fsConstants.F_OK : fsConstants.X_OK);
                return candidate;
            } catch {
                // continue
            }
        }
    }

    return null;
}

async function resolveClaudeOutsidePath(): Promise<string | null> {
    const isWindows = process.platform === 'win32';
    const accessMode = isWindows ? fsConstants.F_OK : fsConstants.X_OK;

    const override = typeof process.env.HAPPIER_CLAUDE_PATH === 'string' ? process.env.HAPPIER_CLAUDE_PATH.trim() : '';
    if (override) {
        try {
            await access(override, accessMode);
            return override;
        } catch {
            // ignore
        }
    }

    const homeDir = resolveHomeDir();
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
    const envKey = `HAPPIER_${name.toUpperCase()}_PATH`;
    const override = typeof process.env[envKey] === 'string' ? String(process.env[envKey]).trim() : '';
    if (!override) return null;

    try {
        await access(override, accessMode);
        return override;
    } catch {
        return null;
    }
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

function defaultVersionArgsToTry(): Array<string[]> {
    return [['--version'], ['version'], ['-v']];
}

const cliDetectCache = new Map<DetectCliName, CliDetectSpec | null>();

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

async function resolveCliLoginStatusArgs(name: DetectCliName): Promise<string[] | null> {
    const spec = (await resolveCliDetectSpec(name))?.loginStatusArgs;
    if (spec === null) return null;
    if (!spec) return null;
    return [...spec];
}

async function detectCliVersion(params: { name: DetectCliName; resolvedPath: string }): Promise<string | null> {
    // Best-effort, must never throw.
    try {
        // Keep this short (runs in parallel for multiple CLIs), but give enough headroom for slower systems.
        const timeoutMs = 1200;
        const isWindows = process.platform === 'win32';
        const isCmdScript = isWindows && /\.(cmd|bat)$/i.test(params.resolvedPath);
        const isJsFile = /\.(c?js)$/i.test(params.resolvedPath);

        const asString = (value: unknown): string => {
            if (typeof value === 'string') return value;
            if (Buffer.isBuffer(value)) return value.toString('utf8');
            return '';
        };

        const argsToTry: Array<string[]> = await resolveCliVersionArgsToTry(params.name);

        const execFileBestEffort = async (file: string, args: string[], options: ExecOptions): Promise<{ stdout: string; stderr: string }> => {
            try {
                const { stdout, stderr } = await execFileAsync(file, args, options);
                return { stdout: asString(stdout), stderr: asString(stderr) };
            } catch (error) {
                // For non-zero exit codes, execFile still provides stdout/stderr on the error object.
                const maybeStdout = asString((error as any)?.stdout);
                const maybeStderr = asString((error as any)?.stderr);
                return { stdout: maybeStdout, stderr: maybeStderr };
            }
        };

        if (isJsFile) {
            for (const args of argsToTry) {
                const { stdout, stderr } = await execFileBestEffort(process.execPath, [params.resolvedPath, ...args], {
                    timeout: timeoutMs,
                    windowsHide: true,
                });
                const combined = `${stdout}\n${stderr}`;
                const firstLine = getFirstLine(combined);
                const semver = extractSemver(firstLine) ?? extractSemver(combined);
                if (semver) return semver;
            }
            return null;
        }

        if (isCmdScript) {
            // .cmd/.bat require cmd.exe (best-effort, only --version is supported here)
            const primary = argsToTry.find((args) => args.includes('--version')) ?? ['--version'];
            const { stdout, stderr } = await execFileBestEffort(
                'cmd.exe',
                ['/d', '/s', '/c', `"${params.resolvedPath}" ${primary.join(' ')}`],
                { timeout: timeoutMs, windowsHide: true },
            );
            return extractSemver(getFirstLine(`${stdout}\n${stderr}`));
        }

        for (const args of argsToTry) {
            const { stdout, stderr } = await execFileBestEffort(params.resolvedPath, args, {
                timeout: timeoutMs,
                windowsHide: true,
            });
            const combined = `${stdout}\n${stderr}`;
            const firstLine = getFirstLine(combined);
            const semver = extractSemver(firstLine) ?? extractSemver(combined);
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

        const execFileBestEffort = async (file: string, args: string[], options: ExecOptions): Promise<{ stdout: string; stderr: string }> => {
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
            const { stdout, stderr } = await execFileBestEffort(
                'cmd.exe',
                ['/d', '/s', '/c', `"${params.resolvedPath}" -V`],
                { timeout: timeoutMs, windowsHide: true },
            );
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

async function detectCliLoginStatus(params: { name: DetectCliName; resolvedPath: string }): Promise<boolean | null> {
    // Best-effort, must never throw.
    try {
        const timeoutMs = 800;
        const loginArgs = await resolveCliLoginStatusArgs(params.name);
        if (!loginArgs) return null;

        const isWindows = process.platform === 'win32';
        const isCmdScript = isWindows && /\.(cmd|bat)$/i.test(params.resolvedPath);

        const runStatus = async (file: string, args: string[]): Promise<boolean | null> => {
            try {
                await execFileAsync(file, args, { timeout: timeoutMs, windowsHide: true });
                return true;
            } catch (error) {
                // execFileAsync throws on non-zero exit; check exit code via various properties.
                const code = (error as any)?.status ?? (error as any)?.exitCode ?? (error as any)?.code;
                // Non-zero exit codes are still a deterministic "not logged in" for our probes.
                if (typeof code === 'number') {
                    return false;
                }
                return null;
            }
        };

        if (isCmdScript) {
            return await runStatus('cmd.exe', ['/d', '/s', '/c', `"${params.resolvedPath}" ${loginArgs.join(' ')}`]);
        }
        return await runStatus(params.resolvedPath, loginArgs);
    } catch {
        return null;
    }
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
    const names = Object.keys(AGENTS) as DetectCliName[];

    const pairs = await Promise.all(
        names.map(async (name) => {
            const resolvedPath =
                (await resolveCliOverridePath(name))
                ?? (await resolveCommandOnPath(name, pathEnv))
                ?? (name === 'claude' ? await resolveClaudeOutsidePath() : null);
            if (!resolvedPath) {
                const entry: DetectCliEntry = { available: false };
                return [name, entry] as const;
            }

            const version = await detectCliVersion({ name, resolvedPath });
            const isLoggedIn = includeLoginStatus ? await detectCliLoginStatus({ name, resolvedPath }) : null;
            const entry: DetectCliEntry = {
                available: true,
                resolvedPath,
                ...(typeof version === 'string' ? { version } : {}),
                ...(includeLoginStatus ? { isLoggedIn } : {}),
            };
            return [name, entry] as const;
        }),
    );

    const tmuxResolvedPath = await resolveCommandOnPath('tmux', pathEnv);
    const tmux: DetectTmuxEntry = (() => {
        if (!tmuxResolvedPath) return { available: false };
        return { available: true, resolvedPath: tmuxResolvedPath };
    })();

    if (tmux.available && tmuxResolvedPath) {
        const version = await detectTmuxVersion({ resolvedPath: tmuxResolvedPath });
        if (typeof version === 'string') {
            tmux.version = version;
        }
    }

    return {
        path: pathEnv,
        clis: Object.fromEntries(pairs) as Record<DetectCliName, DetectCliEntry>,
        tmux,
    };
}
