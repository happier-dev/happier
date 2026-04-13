/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { dirname, join } from 'node:path'
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { getProviderCliInstallGuideUrl, getProviderCliManualInstallSummaryLines } from '@happier-dev/agents'
import { resolveProviderCliCommand } from '@happier-dev/cli-common/providers'
import { logger } from '@/ui/logger'
import { isBun } from '@/utils/runtime'
import { stripNestedSessionDetectionEnv } from '@/utils/processEnv/stripNestedSessionDetectionEnv'
import { expandHomeDirPath, resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath'

function resolveHomeDir(): string {
    return resolveHomeDirFromEnvironment(process.env)
}

function buildClaudeCodeInstallHelpMessage(pathHintLine: string): string {
    const installLines = getProviderCliManualInstallSummaryLines('claude')
    const setupGuideUrl = getProviderCliInstallGuideUrl('claude')
    return [
        'Claude Code is not installed (or not detectable).',
        '',
        'Install Claude Code:',
        ...installLines,
        '',
        pathHintLine,
        ...(setupGuideUrl ? [`Setup guide: ${setupGuideUrl}`] : []),
    ].join('\n')
}

/**
 * Create a clean environment without local node_modules/.bin in PATH
 * This ensures we find the global claude, not the local one
 * Also removes conflicting Bun environment variables when running in Bun
 */
export function getCleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    const cwd = process.cwd()
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'

    // Also check for PATH on Windows (case can vary)
    const actualPathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || pathKey

    if (env[actualPathKey]) {
        const canonicalize = (value: string): string => {
            try {
                return realpathSync(value);
            } catch {
                return value;
            }
        };

        // Remove any path that contains the current working directory (local node_modules/.bin)
        const cleanPath = env[actualPathKey]!
            .split(pathSep)
            .filter(p => {
                const normalizedCwd = canonicalize(cwd).replace(/\\/g, '/').toLowerCase()
                const normalizedP = p.replace(/\\/g, '/').toLowerCase()
                if (normalizedP.startsWith(normalizedCwd)) return false;

                const canonicalPath = canonicalize(p).replace(/\\/g, '/').toLowerCase()
                return !canonicalPath.startsWith(normalizedCwd)
            })
            .join(pathSep)
        env[actualPathKey] = cleanPath
        logger.debug(`[Claude SDK] Cleaned PATH, removed local paths from: ${cwd}`)
    }

    // Remove Bun-specific environment variables that can interfere with Node.js processes
    if (isBun()) {
        Object.keys(env).forEach(key => {
            if (key.startsWith('BUN_')) {
                delete env[key]
            }
        })
        logger.debug('[Claude SDK] Removed Bun-specific environment variables for Node.js compatibility')
    }

    return stripNestedSessionDetectionEnv(env)
}

function parseSemverParts(value: string): [number, number, number] | null {
    const match = value.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
    if (!match) return null
    const major = Number.parseInt(match[1]!, 10)
    const minor = Number.parseInt(match[2]!, 10)
    const patch = Number.parseInt(match[3]!, 10)
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null
    return [major, minor, patch]
}

function compareSemverDirs(a: string, b: string): number {
    const parsedA = parseSemverParts(a)
    const parsedB = parseSemverParts(b)
    if (!parsedA && !parsedB) return a.localeCompare(b)
    if (!parsedA) return -1
    if (!parsedB) return 1
    for (let i = 0; i < 3; i++) {
        const diff = parsedA[i]! - parsedB[i]!
        if (diff !== 0) return diff
    }
    return 0
}

function findLatestVersionedClaudeBinary(versionsDir: string): string | null {
    try {
        const entries = readdirSync(versionsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort(compareSemverDirs)
            .reverse()

        for (const entry of entries) {
            const names = process.platform === 'win32' ? ['claude.exe', 'claude'] : ['claude']
            for (const name of names) {
                const direct = join(versionsDir, entry, name)
                if (existsSync(direct)) return direct

                const inBin = join(versionsDir, entry, 'bin', name)
                if (existsSync(inBin)) return inBin
            }
        }
        return null
    } catch {
        return null
    }
}

function findLatestVersionedClaudeEntrypointForAgentSdk(versionsDir: string): string | null {
    try {
        const entries = readdirSync(versionsDir, { withFileTypes: true });
        const versionNames: string[] = [];

        for (const entry of entries) {
            if (!parseSemverParts(entry.name)) continue;
            versionNames.push(entry.name);
        }

        const sorted = versionNames.sort(compareSemverDirs).reverse();
        for (const version of sorted) {
            const maybePath = join(versionsDir, version);
            if (!existsSync(maybePath)) continue;

            try {
                const stat = statSync(maybePath);
                // Some installers may leave version entries as symlinks to a file; only accept those if they
                // point at an agent-sdk compatible entrypoint.
                if (!stat.isDirectory()) {
                    if (isAgentSdkCompatibleClaudeEntrypoint(maybePath)) return maybePath;
                    continue;
                }
            } catch {
                continue;
            }

            const direct = join(maybePath, 'claude');
            if (existsSync(direct) && isAgentSdkCompatibleClaudeEntrypoint(direct)) return direct;

            const inBin = join(maybePath, 'bin', 'claude');
            if (existsSync(inBin) && isAgentSdkCompatibleClaudeEntrypoint(inBin)) return inBin;

            const cliJs = join(maybePath, 'cli.js');
            if (existsSync(cliJs) && isAgentSdkCompatibleClaudeEntrypoint(cliJs)) return cliJs;
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Derive the npm global `cli.js` entrypoint from `process.execPath`.
 *
 * Intentionally independent of PATH: daemons / spawned CLI processes often inherit
 * a minimal PATH that no longer contains the directory where `node` itself lives
 * (Windows + nvm-windows where `C:\Program Files\nodejs` is a junction, or detached
 * Linux daemons whose PATH is reset by systemd/launchd).
 */
function findClaudeInNpmGlobalModules(): string | null {
    const execDir = dirname(process.execPath)
    const claudePkgRelative = join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js')

    // Windows npm installs packages next to node.exe (`<execDir>/node_modules/...`).
    // Unix npm installs one level up under `<prefix>/lib/node_modules/...`.
    // The Windows candidate is checked first on all platforms; on Unix it is simply
    // a no-op because that path layout does not exist there.
    const candidates = [
        join(execDir, claudePkgRelative),
        join(dirname(execDir), 'lib', claudePkgRelative),
    ]

    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate
    }
    return null
}

function findClaudeInNativeInstallerLocations(homeDir: string): string | null {
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || join(homeDir, 'AppData', 'Local')
        const windowsClaudeDir = join(localAppData, 'Claude')
        const windowsExe = join(windowsClaudeDir, 'claude.exe')
        if (existsSync(windowsExe)) return windowsExe

        const windowsVersions = join(windowsClaudeDir, 'versions')
        const windowsVersioned = findLatestVersionedClaudeBinary(windowsVersions)
        if (windowsVersioned) return windowsVersioned

        const dotClaudeExe = join(homeDir, '.claude', 'claude.exe')
        if (existsSync(dotClaudeExe)) return dotClaudeExe

        const dotClaudeVersions = join(homeDir, '.claude', 'versions')
        const dotClaudeVersioned = findLatestVersionedClaudeBinary(dotClaudeVersions)
        if (dotClaudeVersioned) return dotClaudeVersioned

        // Some installers (and user setups) mirror the Unix layout under %USERPROFILE%\.local\bin.
        const localBinExe = join(homeDir, '.local', 'bin', 'claude.exe')
        if (existsSync(localBinExe)) return localBinExe

        const localVersions = join(homeDir, '.local', 'share', 'claude', 'versions')
        const localVersioned = findLatestVersionedClaudeBinary(localVersions)
        if (localVersioned) return localVersioned

        return null
    }

    const localBin = join(homeDir, '.local', 'bin', 'claude')
    if (existsSync(localBin)) return localBin

    const versionsDir = join(homeDir, '.local', 'share', 'claude', 'versions')
    const versioned = findLatestVersionedClaudeBinary(versionsDir)
    if (versioned) return versioned

    // Legacy layouts (older installers)
    const legacyDotClaudeLocal = join(homeDir, '.claude', 'local', 'cli.js')
    if (existsSync(legacyDotClaudeLocal)) return legacyDotClaudeLocal

    return null
}

function isProbablyNativeBinary(filePath: string): boolean {
    try {
        const fd = openSync(filePath, 'r');
        const buf = Buffer.alloc(4);
        try {
            const bytesRead = readSync(fd, buf, 0, 4, 0);
            if (bytesRead < 4) return false;
        } finally {
            closeSync(fd);
        }

        // ELF
        if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;

        // PE/COFF (Windows)
        if (buf[0] === 0x4d && buf[1] === 0x5a) return true;

        // Mach-O and fat binaries (macOS)
        const magic = buf.readUInt32BE(0);
        const machO = new Set([
            0xfeedface, 0xfeedfacf,
            0xcefaedfe, 0xcffaedfe,
            0xcafebabe, 0xbebafeca,
        ]);
        return machO.has(magic);
    } catch {
        return false;
    }
}

function isAgentSdkCompatibleClaudeEntrypoint(filePath: string): boolean {
    if (!existsSync(filePath)) return false;
    const resolved = (() => {
        try {
            return realpathSync(filePath);
        } catch {
            return filePath;
        }
    })();

    if (isProbablyNativeBinary(resolved)) return true;

    const lower = resolved.toLowerCase();
    if (lower.endsWith('.js') || lower.endsWith('.mjs')) return true;

    if (process.platform === 'win32') return true;
    try {
        const stat = statSync(resolved);
        return (stat.mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

function canonicalizeClaudeEntrypointPath(filePath: string): string {
    try {
        return realpathSync(filePath);
    } catch {
        return filePath;
    }
}

/**
 * Agent SDK requires a real on-disk entrypoint (binary or JS) — it does not accept a bare `claude` command name.
 */
export function getDefaultClaudeCodePathForAgentSdk(): string {
    const overrideRaw = process.env.HAPPIER_CLAUDE_PATH;
    if (typeof overrideRaw === 'string' && overrideRaw.trim().length > 0) {
        const override = expandHomeDirPath(overrideRaw.trim());
        if (!existsSync(override)) {
            throw new Error(`Claude Code executable not found at HAPPIER_CLAUDE_PATH=${override}`);
        }
        if (!isAgentSdkCompatibleClaudeEntrypoint(override)) {
            throw new Error(`HAPPIER_CLAUDE_PATH points to an unsupported Claude entrypoint for Agent SDK: ${override}`);
        }
        return override;
    }

    const resolved = resolveProviderCliCommand('claude', {
        processEnv: getCleanEnv(),
        isBunRuntime: isBun(),
        currentExecPath: process.execPath,
    });
    if (resolved) {
        if (isAgentSdkCompatibleClaudeEntrypoint(resolved.command)) {
            return resolved.command;
        }
    }

    const homeDir = resolveHomeDir();
    if (process.platform !== 'win32') {
        const versionsDir = join(homeDir, '.local', 'share', 'claude', 'versions');
        const versioned = findLatestVersionedClaudeEntrypointForAgentSdk(versionsDir);
        if (versioned && isAgentSdkCompatibleClaudeEntrypoint(versioned)) {
            return canonicalizeClaudeEntrypointPath(versioned);
        }
    }

    // Placed after the Unix versioned-install probe so that a user with both a
    // newer `~/.local/share/claude/versions/` install and an older npm-global
    // install still gets the versioned one. Intentionally NOT canonicalized —
    // we want to preserve the symlink/junction target (e.g. nvm-windows
    // `C:\Program Files\nodejs`) so that Claude auto-updates and nvm version
    // switches can retarget the same path without pinning to an old version.
    const npmGlobalPath = findClaudeInNpmGlobalModules();
    if (npmGlobalPath && isAgentSdkCompatibleClaudeEntrypoint(npmGlobalPath)) {
        return npmGlobalPath;
    }

    const nativeInstallPath = findClaudeInNativeInstallerLocations(homeDir);
    if (nativeInstallPath && isAgentSdkCompatibleClaudeEntrypoint(nativeInstallPath)) {
        return canonicalizeClaudeEntrypointPath(nativeInstallPath);
    }

    throw new Error(
        buildClaudeCodeInstallHelpMessage(
            'Then ensure the Claude Code executable is available on your PATH, or set HAPPIER_CLAUDE_PATH to an absolute executable path.',
        ),
    );
}

/**
 * Get default path to Claude Code executable
 * Prefers user-installed Claude Code.
 * 
 * Environment variables:
 * - HAPPIER_CLAUDE_PATH: Force a specific path to claude executable
 */
export function getDefaultClaudeCodePath(): string {
    // Allow explicit override via env var
    const overrideRaw = process.env.HAPPIER_CLAUDE_PATH
    if (typeof overrideRaw === 'string' && overrideRaw.trim().length > 0) {
        const override = expandHomeDirPath(overrideRaw.trim())
        logger.debug(`[Claude SDK] Using HAPPIER_CLAUDE_PATH: ${override}`)
        if (existsSync(override)) return override
        throw new Error(`Claude Code executable not found at HAPPIER_CLAUDE_PATH=${override}`)
    }

    return getDefaultClaudeCodePathForAgentSdk()
}

/**
 * Log debug message
 */
export function logDebug(message: string): void {
    if (process.env.DEBUG) {
        logger.debug(message)
        console.log(message)
    }
}

/**
 * Stream async messages to stdin
 */
export async function streamToStdin(
    stream: AsyncIterable<unknown>,
    stdin: NodeJS.WritableStream,
    abort?: AbortSignal
): Promise<void> {
    for await (const message of stream) {
        if (abort?.aborted) break
        stdin.write(JSON.stringify(message) + '\n')
    }
    stdin.end()
}
