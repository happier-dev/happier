/**
 * Shared utilities for finding and resolving Claude Code CLI path
 * Used by both local and remote launchers
 *
 * Supports multiple installation methods:
 * 1. Native installer (recommended):
 *    - macOS/Linux: curl -fsSL https://claude.ai/install.sh | bash
 *    - PowerShell:  irm https://claude.ai/install.ps1 | iex
 *    - Windows CMD: curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
 * 2. Homebrew (macOS/Linux): brew install --cask claude-code
 * 3. npm global (deprecated upstream): npm install -g @anthropic-ai/claude-code
 * 4. PATH fallback: bun, pnpm, or any other package manager
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { withWindowsHide } = require('./childProcessOptions.cjs');

/**
 * Safely resolve symlink or return path if it exists
 * @param {string} filePath - Path to resolve
 * @returns {string|null} Resolved path or null if not found
 */
function resolvePathSafe(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return fs.realpathSync(filePath);
    } catch (e) {
        // Symlink resolution failed, return original path
        return filePath;
    }
}

/**
 * Find path to npm globally installed Claude Code CLI
 * @returns {string|null} Path to cli.js or null if not found
 */
function findNpmGlobalCliPath() {
    try {
        const globalRoot = execSync('npm root -g', withWindowsHide({ encoding: 'utf8' })).trim();
        const globalCliPath = path.join(globalRoot, '@anthropic-ai', 'claude-code', 'cli.js');
        if (fs.existsSync(globalCliPath)) {
            return globalCliPath;
        }
    } catch (e) {
        // npm root -g failed
    }
    return null;
}

/**
 * Find Claude CLI using system PATH (which/where command)
 * Respects user's configuration and works across all platforms
 * @returns {{path: string, source: string}|null} Path and source, or null if not found
 */
function findClaudeInPath() {
    try {
        // Cross-platform: 'where' on Windows, 'which' on Unix
        const command = process.platform === 'win32' ? 'where claude' : 'which claude';
        // stdio suppression for cleaner execution (from tiann/PR#83)
        const result = execSync(command, withWindowsHide({
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        })).trim();

        const claudePath = pickClaudePathFromWhichOrWhereOutput(result, process.platform, fs.existsSync);
        if (!claudePath) return null;

        // Resolve with fallback to original path (from tiann/PR#83)
        const resolvedPath = resolvePathSafe(claudePath) || claudePath;

        if (resolvedPath) {
            // Detect source from BOTH original PATH entry and resolved path
            // Original path tells us HOW user accessed it (context)
            // Resolved path tells us WHERE it actually lives (content)
            const originalSource = detectSourceFromPath(claudePath);
            const resolvedSource = detectSourceFromPath(resolvedPath);

            // Prioritize original PATH entry for context (e.g., bun vs npm access)
            // Fall back to resolved path for accurate location detection
            const source = originalSource !== 'PATH' ? originalSource : resolvedSource;

            return {
                path: resolvedPath,
                source: source
            };
        }
    } catch (e) {
        // Command failed (claude not in PATH)
    }
    return null;
}

function scoreWindowsClaudePathCandidate(candidate) {
    const lower = (candidate || '').toString().toLowerCase();
    let score = 0;

    // Avoid Windows "App execution alias" stubs when there's any other option.
    // Those often live under ...\\Microsoft\\WindowsApps\\ and can be surprising/unreliable.
    if (lower.includes('windowsapps')) score -= 1000;

    // Prefer native binaries over wrappers/shims.
    if (lower.endsWith('.exe')) score += 100;
    else if (lower.endsWith('.cmd')) score += 60;
    else if (lower.endsWith('.bat')) score += 50;

    // Prefer known native-installer locations over node/npm shims.
    if (lower.includes('\\appdata\\local\\claude\\') || lower.includes('/appdata/local/claude/')) score += 60;
    if (lower.includes('\\.claude\\') || lower.includes('/.claude/')) score += 50;
    if (lower.includes('program files') && lower.includes('claude')) score += 50;

    // De-prioritize npm shims when a native option is present.
    if (lower.includes('appdata') && lower.includes('roaming') && lower.includes('npm')) score -= 10;

    return score;
}

/**
 * Given output from `which claude` (Unix) or `where claude` (Windows),
 * pick the best path to try.
 *
 * This is intentionally deterministic + testable without mocking execSync.
 *
 * @param {string} output
 * @param {string} platform
 * @param {(p: string) => boolean} existsSync
 * @returns {string|null}
 */
function pickClaudePathFromWhichOrWhereOutput(output, platform = process.platform, existsSync = fs.existsSync) {
    if (!output) return null;

    const candidates = output
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean);

    if (candidates.length === 0) return null;

    const existing = [];
    for (const candidate of candidates) {
        try {
            if (existsSync(candidate)) existing.push(candidate);
        } catch {
            // ignore invalid paths / fs errors during probing
        }
    }

    if (existing.length === 0) return null;
    if (platform !== 'win32' || existing.length === 1) return existing[0];

    let best = existing[0];
    let bestScore = scoreWindowsClaudePathCandidate(best);
    for (const candidate of existing.slice(1)) {
        const score = scoreWindowsClaudePathCandidate(candidate);
        if (score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }

    return best;
}

function isWindowsAppsExecutionAliasPath(filePath) {
    const lower = (filePath || '').toString().toLowerCase();
    return lower.includes('\\microsoft\\windowsapps\\') || lower.includes('/microsoft/windowsapps/');
}

function isWindowsShellShimPath(filePath) {
    const lower = (filePath || '').toString().toLowerCase();
    return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

/**
 * On Windows, prefer the native installer binary when PATH resolves to a shim/alias.
 * This avoids TUI/ANSI/encoding regressions observed when launching via npm .cmd shims or WindowsApps aliases.
 *
 * @param {{path: string, source: string}|null} pathResult
 * @param {string|null} nativePath
 * @returns {string|null}
 */
function chooseWindowsClaudePathFromPathAndNative(pathResult, nativePath) {
    const native = typeof nativePath === 'string' && nativePath.trim().length > 0 ? nativePath.trim() : null;
    const pathCandidate = pathResult && typeof pathResult.path === 'string' ? pathResult.path.trim() : '';
    if (!pathCandidate) return native;
    if (!native) return pathCandidate;

    // If PATH is already a non-WindowsApps .exe, keep it (it might be a user-managed install).
    const lower = pathCandidate.toLowerCase();
    if (lower.endsWith('.exe') && !isWindowsAppsExecutionAliasPath(pathCandidate)) {
        return pathCandidate;
    }

    // Prefer native when PATH is a known shim/alias.
    if (isWindowsAppsExecutionAliasPath(pathCandidate)) return native;
    if (isWindowsShellShimPath(pathCandidate)) return native;
    if (lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs')) return native;

    return pathCandidate;
}

/**
 * Build a spawn invocation for running a binary Claude CLI.
 *
 * On Windows we wrap in cmd.exe to:
 * - execute .cmd/.bat shims reliably
 *
 * @param {{cliPath: string, args: string[], platform?: string, comspec?: string|null}} params
 * @returns {{command: string, args: string[]}}
 */
function buildClaudeBinarySpawnInvocation(params) {
    const platform = params.platform || process.platform;
    const cliPath = (params.cliPath || '').toString();
    const args = Array.isArray(params.args) ? params.args : [];

    if (platform === 'win32') {
        const forceViaComspecRaw = (process.env.HAPPIER_WINDOWS_CLAUDE_SPAWN_VIA_CMDSPEC || '').toString().trim().toLowerCase();
        const forceViaComspec =
            forceViaComspecRaw.length > 0 &&
            forceViaComspecRaw !== '0' &&
            forceViaComspecRaw !== 'false' &&
            forceViaComspecRaw !== 'off' &&
            forceViaComspecRaw !== 'no';

        if (forceViaComspec || isWindowsShellShimPath(cliPath)) {
            const comspec = (params.comspec || process.env.ComSpec || 'cmd.exe').toString();
            return {
                command: comspec,
                args: ['/d', '/s', '/c', cliPath, ...args],
            };
        }

        return { command: cliPath, args };
    }

    return { command: cliPath, args };
}

/**
 * Detect installation source from resolved path
 * Uses concrete path patterns, no assumptions
 * @param {string} resolvedPath - The resolved path to cli.js
 * @returns {string} Installation method/source
 */
function detectSourceFromPath(resolvedPath) {
    const normalized = resolvedPath.toLowerCase();
    const path = require('path');

    // Use path.normalize() for proper cross-platform path handling
    const normalizedPath = path.normalize(resolvedPath).toLowerCase();

    // Bun: ~/.bun/bin/claude -> ../node_modules/@anthropic-ai/claude-code/cli.js
    // Works on Windows too: C:\Users\[user]\.bun\bin\claude
    if (normalizedPath.includes('.bun') && normalizedPath.includes('bin') ||
        (normalizedPath.includes('node_modules') && normalizedPath.includes('.bun'))) {
        return 'Bun';
    }

    // Homebrew cask: hashed directories like .claude-code-2DTsDk1V (NOT npm installations)
    // Must check before general Homebrew paths to distinguish from npm-through-Homebrew
    if (normalizedPath.includes('@anthropic-ai') && normalizedPath.includes('.claude-code-')) {
        return 'Homebrew';
    }

    // npm: clean claude-code directory (even through Homebrew's npm)
    // Windows: %APPDATA%\npm\node_modules\@anthropic-ai\claude-code
    if (normalizedPath.includes('node_modules') && normalizedPath.includes('@anthropic-ai') && normalizedPath.includes('claude-code') &&
        !normalizedPath.includes('.claude-code-')) {
        return 'npm';
    }

    // Windows-specific detection (detect by path patterns, not current platform)
    if (normalizedPath.includes('appdata') || normalizedPath.includes('program files') || normalizedPath.endsWith('.exe')) {
        // Windows npm
        if (normalizedPath.includes('appdata') && normalizedPath.includes('npm') && normalizedPath.includes('node_modules') &&
            normalizedPath.includes('@anthropic-ai') && normalizedPath.includes('claude-code') &&
            !normalizedPath.includes('.claude-code-')) {
            return 'npm';
        }

        // Windows native installer (any location ending with claude.exe)
        if (normalizedPath.endsWith('claude.exe')) {
            return 'native installer';
        }

        // Windows native installer in AppData
        if (normalizedPath.includes('appdata') && normalizedPath.includes('claude')) {
            return 'native installer';
        }

        // Windows native installer in Program Files
        if (normalizedPath.includes('program files') && normalizedPath.includes('claude')) {
            return 'native installer';
        }
    }

    // Homebrew general paths (for non-npm installations like Cellar binaries)
    // Apple Silicon: /opt/homebrew/bin/claude
    // Intel Mac: /usr/local/bin/claude (ONLY on macOS, not Linux)
    // Linux Homebrew: /home/linuxbrew/.linuxbrew/bin/claude or ~/.linuxbrew/bin/claude
    if (normalizedPath.includes('opt/homebrew') ||
        normalizedPath.includes('usr/local/homebrew') ||
        normalizedPath.includes('home/linuxbrew') ||
        normalizedPath.includes('.linuxbrew') ||
        normalizedPath.includes('.homebrew') ||
        normalizedPath.includes('cellar') ||
        normalizedPath.includes('caskroom') ||
        (normalizedPath.includes('usr/local/bin/claude') && process.platform === 'darwin')) { // Intel Mac Homebrew default only on macOS
        return 'Homebrew';
    }

    // Native installer: standard Unix locations and ~/.local/bin
    // /usr/local/bin/claude on Linux should be native installer
    if (normalizedPath.includes('.local') && normalizedPath.includes('bin') ||
        normalizedPath.includes('.local') && normalizedPath.includes('share') && normalizedPath.includes('claude') ||
        (normalizedPath.includes('usr/local/bin/claude') && process.platform === 'linux')) { // Linux native installer
        return 'native installer';
    }

    // Default: we found it in PATH but can't determine source
    return 'PATH';
}

/**
 * Find path to Bun globally installed Claude Code CLI
 * FIX: Check bun's bin directory, not non-existent modules directory
 * @returns {string|null} Path to cli.js or null if not found
 */
function findBunGlobalCliPath() {
    // First check if bun command exists (cross-platform)
    try {
        const bunCheckCommand = process.platform === 'win32' ? 'where bun' : 'which bun';
        execSync(bunCheckCommand, withWindowsHide({ encoding: 'utf8' }));
    } catch (e) {
        return null; // bun not installed
    }

    // Check bun's binary directory (works on both Unix and Windows)
    const bunBin = path.join(os.homedir(), '.bun', 'bin', 'claude');
    const resolved = resolvePathSafe(bunBin);

    if (resolved && resolved.endsWith('cli.js') && fs.existsSync(resolved)) {
        return resolved;
    }

    return null;
}

/**
 * Find path to Homebrew installed Claude Code CLI
 * FIX: Handle hashed directory names like .claude-code-[hash]
 * @returns {string|null} Path to cli.js or binary, or null if not found
 */
function findHomebrewCliPath() {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return null;
    }

    const possiblePrefixes = [
        '/opt/homebrew',
        '/usr/local',
        path.join(os.homedir(), '.linuxbrew'),
        path.join(os.homedir(), '.homebrew')
    ].filter(fs.existsSync);

    for (const prefix of possiblePrefixes) {
        // Check for binary symlink first (most reliable)
        const binPath = path.join(prefix, 'bin', 'claude');
        const resolved = resolvePathSafe(binPath);
        if (resolved && fs.existsSync(resolved)) {
            return resolved;
        }

        // Fallback: check for hashed directories in node_modules
        const nodeModulesPath = path.join(prefix, 'lib', 'node_modules', '@anthropic-ai');
        if (fs.existsSync(nodeModulesPath)) {
            // Look for both claude-code and .claude-code-[hash]
            const entries = fs.readdirSync(nodeModulesPath);
            for (const entry of entries) {
                if (entry === 'claude-code' || entry.startsWith('.claude-code-')) {
                    const cliPath = path.join(nodeModulesPath, entry, 'cli.js');
                    if (fs.existsSync(cliPath)) {
                        return cliPath;
                    }
                }
            }
        }
    }

    return null;
}

/**
 * Find path to native installer Claude Code CLI
 * 
 * Installation locations:
 * - macOS/Linux: ~/.local/bin/claude (symlink) -> ~/.local/share/claude/versions/<version>
 * - Windows: %LOCALAPPDATA%\Claude\ or %USERPROFILE%\.claude\
 * - Legacy: ~/.claude/local/
 * 
 * @returns {string|null} Path to cli.js or binary, or null if not found
 */
function findNativeInstallerCliPath() {
    const homeDir = os.homedir();
    
    // Windows-specific locations
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
        
        // Check %LOCALAPPDATA%\Claude\
        const windowsClaudePath = path.join(localAppData, 'Claude');
        if (fs.existsSync(windowsClaudePath)) {
            // Check for versions directory
            const versionsDir = path.join(windowsClaudePath, 'versions');
            if (fs.existsSync(versionsDir)) {
                const found = findLatestVersionBinary(versionsDir);
                if (found) return found;
            }
            
            // Check for claude.exe directly
            const exePath = path.join(windowsClaudePath, 'claude.exe');
            if (fs.existsSync(exePath)) {
                return exePath;
            }
            
            // Check for cli.js
            const cliPath = path.join(windowsClaudePath, 'cli.js');
            if (fs.existsSync(cliPath)) {
                return cliPath;
            }
        }
        
        // Check %USERPROFILE%\.claude\ (alternative Windows location)
        const dotClaudePath = path.join(homeDir, '.claude');
        if (fs.existsSync(dotClaudePath)) {
            const versionsDir = path.join(dotClaudePath, 'versions');
            if (fs.existsSync(versionsDir)) {
                const found = findLatestVersionBinary(versionsDir);
                if (found) return found;
            }
            
            const exePath = path.join(dotClaudePath, 'claude.exe');
            if (fs.existsSync(exePath)) {
                return exePath;
            }
        }

        // Some installations mirror Unix layout under %USERPROFILE%\.local\bin.
        const localBinExe = path.join(homeDir, '.local', 'bin', 'claude.exe');
        if (fs.existsSync(localBinExe)) {
            return localBinExe;
        }

        const localVersions = path.join(homeDir, '.local', 'share', 'claude', 'versions');
        if (fs.existsSync(localVersions)) {
            const found = findLatestVersionBinary(localVersions);
            if (found) return found;
        }
    }
    
    // Check ~/.local/bin/claude symlink (most common location on macOS/Linux)
    const localBinPath = path.join(homeDir, '.local', 'bin', 'claude');
    const resolvedLocalBinPath = resolvePathSafe(localBinPath);
    if (resolvedLocalBinPath) return resolvedLocalBinPath;
    
    // Check ~/.local/share/claude/versions/ (native installer location)
    const versionsDir = path.join(homeDir, '.local', 'share', 'claude', 'versions');
    if (fs.existsSync(versionsDir)) {
        const found = findLatestVersionBinary(versionsDir);
        if (found) return found;
    }
    
    // Check ~/.claude/local/ (older installation method)
    const nativeBasePath = path.join(homeDir, '.claude', 'local');
    if (fs.existsSync(nativeBasePath)) {
        // Look for the cli.js in the node_modules structure
        const cliPath = path.join(nativeBasePath, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        if (fs.existsSync(cliPath)) {
            return cliPath;
        }
        
        // Alternative: direct cli.js in the installation
        const directCliPath = path.join(nativeBasePath, 'cli.js');
        if (fs.existsSync(directCliPath)) {
            return directCliPath;
        }
    }
    
    return null;
}

/**
 * Helper to find the latest version binary in a versions directory
 * @param {string} versionsDir - Path to versions directory
 * @param {string} [binaryName] - Optional binary name to look for inside version directory
 * @returns {string|null} Path to binary or null
 */
function findLatestVersionBinary(versionsDir, binaryName = null) {
    try {
        const entries = fs.readdirSync(versionsDir);
        if (entries.length === 0) return null;
        
        // Sort using semver comparison (descending)
        const sorted = entries.sort((a, b) => compareVersions(b, a));
        const latestVersion = sorted[0];
        const versionPath = path.join(versionsDir, latestVersion);
        
        // Check if it's a file (binary) or directory
        const stat = fs.statSync(versionPath);
        if (stat.isFile()) {
            return versionPath;
        } else if (stat.isDirectory()) {
            // If specific binary name provided, check for it
            if (binaryName) {
                const binaryPath = path.join(versionPath, binaryName);
                if (fs.existsSync(binaryPath)) {
                    return binaryPath;
                }
            }
            // Check for executable or cli.js inside directory
            const exePath = path.join(versionPath, process.platform === 'win32' ? 'claude.exe' : 'claude');
            if (fs.existsSync(exePath)) {
                return exePath;
            }
            const cliPath = path.join(versionPath, 'cli.js');
            if (fs.existsSync(cliPath)) {
                return cliPath;
            }
        }
    } catch (e) {
        // Directory read failed
    }
    return null;
}

/**
 * Find path to globally installed Claude Code CLI
 * Priority: HAPPIER_CLAUDE_PATH env var > PATH > Native > Homebrew > Bun > npm (deprecated)
 * @returns {{path: string, source: string}|null} Path and source, or null if not found
 */
function findGlobalClaudeCliPath() {
    // 1. Environment variable (explicit override)
    const envPath = process.env.HAPPIER_CLAUDE_PATH;
    if (envPath && fs.existsSync(envPath)) {
        const resolved = resolvePathSafe(envPath) || envPath;
        return { path: resolved, source: 'HAPPIER_CLAUDE_PATH' };
    }

    // 2. Check PATH (respects user's shell config)
    const pathResult = findClaudeInPath();

    // 3. Prefer native installer locations on Windows when PATH points at a shim/alias.
    // This avoids a class of Windows-only TUI/encoding issues reported upstream when launching via npm shims.
    const nativePath = findNativeInstallerCliPath();
    if (process.platform === 'win32' && nativePath) {
        const chosen = chooseWindowsClaudePathFromPathAndNative(pathResult, nativePath);
        if (chosen && (!pathResult || chosen !== pathResult.path)) {
            return { path: chosen, source: 'native installer' };
        }
    }

    if (pathResult) return pathResult;

    // 4. Prefer native installer locations when PATH isn't configured (common for daemons / non-login shells)
    if (nativePath) return { path: nativePath, source: 'native installer' };

    const homebrewPath = findHomebrewCliPath();
    if (homebrewPath) return { path: homebrewPath, source: 'Homebrew' };

    const bunPath = findBunGlobalCliPath();
    if (bunPath) return { path: bunPath, source: 'Bun' };

    // Deprecated upstream, but keep as a best-effort fallback for legacy setups.
    const npmPath = findNpmGlobalCliPath();
    if (npmPath) return { path: npmPath, source: 'npm' };

    return null;
}

/**
 * Get version from Claude Code package.json
 * @param {string} cliPath - Path to cli.js
 * @returns {string|null} Version string or null
 */
function getVersion(cliPath) {
    try {
        const pkgPath = path.join(path.dirname(cliPath), 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            return pkg.version;
        }
    } catch (e) {}
    return null;
}

/**
 * Compare semver versions
 * @param {string} a - First version
 * @param {string} b - Second version
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal
 */
function compareVersions(a, b) {
    if (!a || !b) return 0;
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (partsA[i] > partsB[i]) return 1;
        if (partsA[i] < partsB[i]) return -1;
    }
    return 0;
}

/**
 * Get the CLI path to use (global installation)
 * @returns {string} Path to cli.js
 * @throws {Error} If no global installation found
 */
function shouldLogClaudeDetection() {
    const raw = ((process.env.HAPPIER_DEBUG_CLAUDE_LAUNCHER ?? process.env.DEBUG) || '').toString().trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();
    if (lower === '0' || lower === 'false' || lower === 'off' || lower === 'no') return false;
    return true;
}

function getClaudeCliPath() {
    const happierOverrideRaw = (process.env.HAPPIER_CLAUDE_PATH || '').trim();
    const happyOverrideRaw = (process.env.HAPPY_CLAUDE_PATH || '').trim();
    const envVarName = happierOverrideRaw ? 'HAPPIER_CLAUDE_PATH' : happyOverrideRaw ? 'HAPPY_CLAUDE_PATH' : null;
    const overrideRaw = (happierOverrideRaw || happyOverrideRaw || '').trim();
    if (overrideRaw) {
        if (overrideRaw === 'claude') {
            if (shouldLogClaudeDetection()) {
                console.error(`\x1b[90mUsing Claude Code from ${envVarName ?? 'HAPPIER_CLAUDE_PATH'}=claude\x1b[0m`);
            }
            return 'claude';
        }

        const resolvedOverride = resolvePathSafe(overrideRaw) || overrideRaw;
        if (!fs.existsSync(resolvedOverride)) {
            console.error(`\n\x1b[1m\x1b[33mClaude Code path not found\x1b[0m\n`);
            console.error(`${envVarName ?? 'HAPPIER_CLAUDE_PATH'} points to a missing file: ${overrideRaw}\n`);
            process.exit(1);
        }

        if (shouldLogClaudeDetection()) {
            console.error(`\x1b[90mUsing Claude Code from ${envVarName ?? 'HAPPIER_CLAUDE_PATH'} (${resolvedOverride})\x1b[0m`);
        }
        return resolvedOverride;
    }

    const result = findGlobalClaudeCliPath();
    if (!result) {
        console.error('\n\x1b[1m\x1b[33mClaude Code is not installed\x1b[0m\n');
        console.error('Please install Claude Code using one of these methods:\n');
        console.error('\x1b[1mOption 1 - Native installer (recommended):\x1b[0m');
        console.error('  \x1b[90mmacOS/Linux:\x1b[0m  \x1b[36mcurl -fsSL https://claude.ai/install.sh | bash\x1b[0m');
        console.error('  \x1b[90mPowerShell:\x1b[0m   \x1b[36mirm https://claude.ai/install.ps1 | iex\x1b[0m');
        console.error('  \x1b[90mWindows CMD:\x1b[0m  \x1b[36mcurl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS/Linux):\x1b[0m');
        console.error('  \x1b[36mbrew install --cask claude-code\x1b[0m\n');
        console.error('\x1b[1mOption 3 - npm global (deprecated upstream):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @anthropic-ai/claude-code\x1b[0m\n');
        console.error("\x1b[90mTip: If the daemon can't find `claude`, ensure it's on PATH or set HAPPIER_CLAUDE_PATH.\x1b[0m\n");
        process.exit(1);
    }

    const version = getVersion(result.path);
    const versionStr = version ? ` v${version}` : '';
    if (shouldLogClaudeDetection()) {
        console.error(`\x1b[90mUsing Claude Code${versionStr} from ${result.source}\x1b[0m`);
    }

    return result.path;
}

/**
 * Run Claude CLI, handling both JavaScript and binary files
 * @param {string} cliPath - Path to CLI (from getClaudeCliPath)
 */
function attachChildSignalForwarding(child, proc = process) {
    const forwardSignal = (signal) => {
        try {
            if (child && child.pid && !child.killed) {
                child.kill(signal);
            }
        } catch {
            // ignore
        }
    };

    const signals = ['SIGTERM', 'SIGINT'];
    if (proc.platform !== 'win32') {
        signals.push('SIGHUP');
    }

    for (const signal of signals) {
        proc.on(signal, () => forwardSignal(signal));
    }
}

function runClaudeCli(cliPath) {
    const { pathToFileURL } = require('url');
    const { spawn } = require('child_process');
    
    // Check if it's a JavaScript file (.js or .cjs) or a binary file
    const isJsFile = cliPath.endsWith('.js') || cliPath.endsWith('.cjs');

    if (isJsFile) {
        // JavaScript file - use import to keep interceptors working
        const importUrl = pathToFileURL(cliPath).href;
        import(importUrl);
    } else {
        // Binary file (e.g., Homebrew installation) - spawn directly
        // Note: Interceptors won't work with binary files, but that's acceptable
        // as binary files are self-contained and don't need interception
        const args = process.argv.slice(2);
        const invocation = buildClaudeBinarySpawnInvocation({ cliPath, args });
        const child = spawn(invocation.command, invocation.args, withWindowsHide({
            stdio: 'inherit',
            env: process.env
        }));

        // Forward signals to child process so it gets killed when parent is killed.
        // This prevents orphaned Claude processes when switching between local/remote modes.
        attachChildSignalForwarding(child);

        child.on('exit', (code) => {
            process.exit(code || 0);
        });
    }
}

module.exports = {
    findGlobalClaudeCliPath,
    findClaudeInPath,
    pickClaudePathFromWhichOrWhereOutput,
    chooseWindowsClaudePathFromPathAndNative,
    buildClaudeBinarySpawnInvocation,
    detectSourceFromPath,
    findNpmGlobalCliPath,
    findBunGlobalCliPath,
    findHomebrewCliPath,
    findNativeInstallerCliPath,
    getVersion,
    compareVersions,
    getClaudeCliPath,
    runClaudeCli,
    attachChildSignalForwarding
};
