/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { join } from 'node:path'
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { logger } from '@/ui/logger'
import { isBun } from '@/utils/runtime'

function resolveHomeDir(): string {
    // Prefer env overrides so unit tests and sandboxed runtimes can control the home directory.
    // Fall back to os.homedir() for the real platform home.
    const envHome =
        process.platform === 'win32'
            ? (process.env.USERPROFILE || process.env.HOME)
            : process.env.HOME
    const trimmed = typeof envHome === 'string' ? envHome.trim() : ''
    return trimmed.length > 0 ? trimmed : homedir()
}

/**
 * Get version of globally installed claude
 * Runs from home directory with clean PATH to avoid picking up local node_modules/.bin
 */
function getGlobalClaudeVersion(): string | null {
    try {
        const cleanEnv = getCleanEnv()
        const output = execSync('claude --version', { 
            encoding: 'utf8', 
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: resolveHomeDir(),
            env: cleanEnv
        }).trim()
        // Output format: "2.0.54 (Claude Code)" or similar
        const match = output.match(/(\d+\.\d+\.\d+)/)
        logger.debug(`[Claude SDK] Global claude --version output: ${output}`)
        return match ? match[1] : null
    } catch {
        return null
    }
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
        // Remove any path that contains the current working directory (local node_modules/.bin)
        const cleanPath = env[actualPathKey]!
            .split(pathSep)
            .filter(p => {
                const normalizedP = p.replace(/\\/g, '/').toLowerCase()
                const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase()
                return !normalizedP.startsWith(normalizedCwd)
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

    return env
}

/**
 * Try to find globally installed Claude CLI
 * Returns 'claude' if the command works globally (preferred method for reliability)
 * Falls back to which/where to get actual path on Unix systems
 * Runs from home directory with clean PATH to avoid picking up local node_modules/.bin
 */
function findGlobalClaudePath(): string | null {
    const homeDir = resolveHomeDir()
    const cleanEnv = getCleanEnv()
    
    // PRIMARY: Check if 'claude' command works directly from home dir with clean PATH
    try {
        execSync('claude --version', { 
            encoding: 'utf8', 
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir,
            env: cleanEnv
        })
        logger.debug('[Claude SDK] Global claude command available (checked with clean PATH)')
        return 'claude'
    } catch {
        // claude command not available globally
    }

    // FALLBACK for Unix: try which to get actual path
    if (process.platform !== 'win32') {
        try {
            const result = execSync('which claude', { 
                encoding: 'utf8', 
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: homeDir,
                env: cleanEnv
            }).trim()
            if (result && existsSync(result)) {
                logger.debug(`[Claude SDK] Found global claude path via which: ${result}`)
                return result
            }
        } catch {
            // which didn't find it
        }
    }
    
    return null
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

            // Directory layout: check for executables inside.
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

function getPathEntriesFromEnv(envPath: string | undefined): string[] {
    const raw = typeof envPath === 'string' ? envPath : '';
    const sep = process.platform === 'win32' ? ';' : ':';
    return raw
        .split(sep)
        .map((p) => p.trim())
        .filter(Boolean);
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

function findClaudeInPathForAgentSdk(): string | null {
    const entries = getPathEntriesFromEnv(process.env.PATH);
    if (entries.length === 0) return null;

    const candidates = process.platform === 'win32'
        ? ['claude.exe', 'claude']
        : ['claude'];

    for (const dir of entries) {
        for (const name of candidates) {
            const maybe = join(dir, name);
            if (existsSync(maybe) && isAgentSdkCompatibleClaudeEntrypoint(maybe)) return maybe;
        }
    }

    return null;
}

/**
 * Agent SDK requires a real on-disk entrypoint (binary or JS) — it does not accept a bare `claude` command name.
 */
export function getDefaultClaudeCodePathForAgentSdk(): string {
    const overrideRaw = process.env.HAPPIER_CLAUDE_PATH;
    if (typeof overrideRaw === 'string' && overrideRaw.trim().length > 0) {
        const override = overrideRaw.trim();
        if (!existsSync(override)) {
            throw new Error(`Claude Code executable not found at HAPPIER_CLAUDE_PATH=${override}`);
        }
        if (!isAgentSdkCompatibleClaudeEntrypoint(override)) {
            throw new Error(`HAPPIER_CLAUDE_PATH points to an unsupported Claude entrypoint for Agent SDK: ${override}`);
        }
        return override;
    }

    const homeDir = resolveHomeDir();

    // Prefer PATH entrypoints first so test harnesses and sandboxed runtimes can inject a known-good
    // Claude entrypoint without depending on the developer machine's global installs.
    const inPath = findClaudeInPathForAgentSdk();
    if (inPath) return inPath;

    // Fall back to versioned installs (these are typically real binaries) and native installer locations.
    if (process.platform !== 'win32') {
        const versionsDir = join(homeDir, '.local', 'share', 'claude', 'versions');
        const versioned = findLatestVersionedClaudeEntrypointForAgentSdk(versionsDir);
        if (versioned && isAgentSdkCompatibleClaudeEntrypoint(versioned)) return versioned;

        const legacyDotClaudeLocal = join(homeDir, '.claude', 'local', 'cli.js');
        if (existsSync(legacyDotClaudeLocal) && isAgentSdkCompatibleClaudeEntrypoint(legacyDotClaudeLocal)) return legacyDotClaudeLocal;
    }

    const nativeInstallPath = findClaudeInNativeInstallerLocations(homeDir);
    if (nativeInstallPath && isAgentSdkCompatibleClaudeEntrypoint(nativeInstallPath)) return nativeInstallPath;

    const message = [
        'Claude Code is not installed (or not detectable).',
        '',
        'Install Claude Code:',
        '  macOS/Linux: curl -fsSL https://claude.ai/install.sh | bash',
        '  Windows (PowerShell): irm https://claude.ai/install.ps1 | iex',
        '',
        'Then ensure the Claude Code executable is available on your PATH, or set HAPPIER_CLAUDE_PATH to an absolute executable path.',
        'Setup guide: https://code.claude.com/docs/en/setup',
    ].join('\n');
    throw new Error(message);
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
        const override = overrideRaw.trim()
        logger.debug(`[Claude SDK] Using HAPPIER_CLAUDE_PATH: ${override}`)
        if (existsSync(override)) return override
        throw new Error(`Claude Code executable not found at HAPPIER_CLAUDE_PATH=${override}`)
    }

    // Find global claude
    const globalPath = findGlobalClaudePath()
    
    const homeDir = resolveHomeDir()
    if (!globalPath) {
        const nativeInstallPath = findClaudeInNativeInstallerLocations(homeDir)
        if (nativeInstallPath) {
            logger.debug(`[Claude SDK] Found Claude Code via native installer locations: ${nativeInstallPath}`)
            return nativeInstallPath
        }

        const message = [
            'Claude Code is not installed (or not detectable).',
            '',
            'Install Claude Code:',
            '  macOS/Linux: curl -fsSL https://claude.ai/install.sh | bash',
            '  Windows (PowerShell): irm https://claude.ai/install.ps1 | iex',
            '',
            'Then ensure `claude` is available on your PATH, or set HAPPIER_CLAUDE_PATH to the executable path.',
            'Setup guide: https://code.claude.com/docs/en/setup',
        ].join('\n')
        throw new Error(message)
    }

    // Compare versions and use the newer one
    const globalVersion = getGlobalClaudeVersion()

    logger.debug(`[Claude SDK] Global version: ${globalVersion || 'unknown'}`)
    
    // If we can't determine versions, prefer global (user's choice to install it)
    if (!globalVersion) {
        logger.debug(`[Claude SDK] Cannot compare versions, using global: ${globalPath}`)
        return globalPath
    }
    
    return globalPath
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
