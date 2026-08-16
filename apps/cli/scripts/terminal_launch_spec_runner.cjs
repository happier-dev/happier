#!/usr/bin/env node

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const terminalSignalNames = ['SIGINT', 'SIGQUIT'];
const stderrTailMaxChars = 64 * 1024;
const claudeMcpConfigFilePrefix = 'happier-claude-mcp-config';

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value, name) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        throw new Error(`Invalid terminal launch spec: ${name} must be an array of strings`);
    }
    return value;
}

function readOptionalStringArray(value, name) {
    if (value === undefined) return [];
    return readStringArray(value, name);
}

function isSafeClaudeMcpConfigCleanupPath(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) return false;
    const tmpRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(filePath);
    const relative = path.relative(tmpRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const name = path.basename(resolved);
    return name.startsWith(`${claudeMcpConfigFilePrefix}.`) && name.endsWith('.json');
}

async function cleanupLaunchSpecPaths(paths) {
    await Promise.allSettled(
        paths
            .filter(isSafeClaudeMcpConfigCleanupPath)
            .map(async (filePath) => {
                await fs.unlink(filePath).catch(() => undefined);
                const directory = path.dirname(filePath);
                if (path.basename(directory).startsWith(`${claudeMcpConfigFilePrefix}-`)) {
                    await fs.rmdir(directory).catch(() => undefined);
                }
            }),
    );
}

function readEnv(value) {
    if (!isPlainObject(value)) {
        throw new Error('Invalid terminal launch spec: env must be an object');
    }
    const env = Object.create(null);
    for (const [key, envValue] of Object.entries(value)) {
        if (typeof envValue !== 'string') {
            throw new Error(`Invalid terminal launch spec: env.${key} must be a string`);
        }
        env[key] = envValue;
    }
    return env;
}

function readOptionalDiagnostics(value) {
    if (value === undefined) return null;
    if (!isPlainObject(value)) {
        throw new Error('Invalid terminal launch spec: diagnostics must be an object');
    }
    const sessionId = value.sessionId;
    const logsDir = value.logsDir;
    const sessionExitDir = value.sessionExitDir;
    if (sessionId !== undefined && typeof sessionId !== 'string') {
        throw new Error('Invalid terminal launch spec: diagnostics.sessionId must be a string');
    }
    if (typeof logsDir !== 'string' || logsDir.length === 0) {
        throw new Error('Invalid terminal launch spec: diagnostics.logsDir must be a non-empty string');
    }
    if (typeof sessionExitDir !== 'string' || sessionExitDir.length === 0) {
        throw new Error('Invalid terminal launch spec: diagnostics.sessionExitDir must be a non-empty string');
    }
    return {
        sessionId: typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null,
        logsDir,
        sessionExitDir,
    };
}

function buildChildEnv(specEnv, envPassthroughKeys) {
    const env = { ...specEnv };
    for (const key of envPassthroughKeys) {
        const value = process.env[key];
        if (typeof value === 'string') {
            env[key] = value;
        }
    }
    return env;
}

async function readLaunchSpecFile(specPath) {
    if (typeof specPath !== 'string' || specPath.length === 0) {
        throw new Error('Invalid terminal launch spec path');
    }
    const raw = await fs.readFile(specPath, 'utf8');
    await fs.unlink(specPath).catch(() => {});
    const specDir = path.dirname(specPath);
    if (path.basename(specDir).startsWith('happier-terminal-launch-')) {
        await fs.rmdir(specDir).catch(() => {});
    }
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
        throw new Error('Invalid terminal launch spec: root must be an object');
    }
    if (typeof parsed.command !== 'string' || parsed.command.length === 0) {
        throw new Error('Invalid terminal launch spec: command must be a non-empty string');
    }
    if (typeof parsed.cwd !== 'string' || parsed.cwd.length === 0) {
        throw new Error('Invalid terminal launch spec: cwd must be a non-empty string');
    }
    return {
        command: parsed.command,
        args: readStringArray(parsed.args, 'args'),
        cwd: parsed.cwd,
        env: buildChildEnv(readEnv(parsed.env), readOptionalStringArray(parsed.envPassthroughKeys, 'envPassthroughKeys')),
        cleanupPaths: readOptionalStringArray(parsed.cleanupPaths, 'cleanupPaths'),
        diagnostics: readOptionalDiagnostics(parsed.diagnostics),
    };
}

function sanitizeFilePart(value) {
    const sanitized = String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return sanitized.length > 0 ? sanitized : 'unknown';
}

function sessionFilePart(sessionId) {
    return sessionId ? `session-${sanitizeFilePart(sessionId)}` : 'session-unknown';
}

function appendTail(tail, chunk) {
    const next = tail + chunk.toString('utf8');
    return next.length > stderrTailMaxChars ? next.slice(next.length - stderrTailMaxChars) : next;
}

function createChildStderrDiagnostics(diagnostics, pid) {
    if (!diagnostics || typeof pid !== 'number') {
        return null;
    }
    const sessionPart = sessionFilePart(diagnostics.sessionId);
    try {
        fsSync.mkdirSync(diagnostics.logsDir, { recursive: true });
    } catch {
        return null;
    }
    const stderrLogPath = path.join(diagnostics.logsDir, `${sessionPart}-pid-${pid}.stderr.log`);
    const stderrLog = fsSync.createWriteStream(stderrLogPath, { flags: 'a', encoding: 'utf8' });
    stderrLog.on('error', () => {});
    let stderrTail = '';
    return {
        stderrLogPath,
        observeStderr(chunk) {
            stderrTail = appendTail(stderrTail, chunk);
            stderrLog.write(chunk);
        },
        stderrTail() {
            return stderrTail;
        },
        async close() {
            await new Promise((resolve) => {
                stderrLog.end(resolve);
            });
        },
    };
}

async function readExistingJsonObject(filePath) {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return isPlainObject(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

async function writeNonZeroSessionExitDiagnostics(params) {
    const diagnostics = params.spec.diagnostics;
    if (!diagnostics || !params.stderrDiagnostics) return;
    try {
        await fs.mkdir(diagnostics.sessionExitDir, { recursive: true });
        const reportPath = path.join(
            diagnostics.sessionExitDir,
            `${sessionFilePart(diagnostics.sessionId)}-pid-${params.pid}.json`,
        );
        const payload = {
            ...(await readExistingJsonObject(reportPath)),
            sessionId: diagnostics.sessionId ?? null,
            pid: params.pid,
            observedAt: Date.now(),
            observedBy: 'session',
            reason: 'terminal-launch-child-exited',
            code: params.code,
            signal: params.signal ?? null,
            stderrLogPath: params.stderrDiagnostics.stderrLogPath,
            stderrTail: params.stderrDiagnostics.stderrTail(),
        };
        await fs.writeFile(reportPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
        // Diagnostic retention must not change provider exit behavior.
    }
}

function installTerminalSignalGuards() {
    const installed = [];
    for (const signal of terminalSignalNames) {
        const listener = () => {};
        try {
            process.on(signal, listener);
            installed.push([signal, listener]);
        } catch {
            // Some platforms do not support all terminal control signals.
        }
    }
    let removed = false;
    return () => {
        if (removed) return;
        removed = true;
        for (const [signal, listener] of installed) {
            try {
                if (typeof process.off === 'function') {
                    process.off(signal, listener);
                } else {
                    process.removeListener(signal, listener);
                }
            } catch {
                // Best-effort cleanup; the child has already settled.
            }
        }
    };
}

function runLaunchSpec(spec) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(spec.command, spec.args, {
                cwd: spec.cwd,
                env: spec.env,
                shell: false,
                stdio: ['inherit', 'inherit', 'pipe'],
                windowsHide: true,
            });
        } catch (error) {
            void cleanupLaunchSpecPaths(spec.cleanupPaths ?? []).then(() => reject(error));
            return;
        }
        const stderrDiagnostics = createChildStderrDiagnostics(spec.diagnostics, child.pid);
        child.stderr?.on('data', (chunk) => {
            stderrDiagnostics?.observeStderr(chunk);
            process.stderr.write(chunk);
        });
        const removeSignalGuards = installTerminalSignalGuards();
        let settled = false;
        const settle = async (fn) => {
            if (settled) return;
            settled = true;
            removeSignalGuards();
            await stderrDiagnostics?.close();
            await cleanupLaunchSpecPaths(spec.cleanupPaths ?? []);
            await fn();
        };
        child.on('error', (error) => {
            settle(() => reject(error));
        });
        child.on('close', (code, signal) => {
            if (typeof code === 'number') {
                settle(async () => {
                    if (code !== 0) {
                        await writeNonZeroSessionExitDiagnostics({
                            spec,
                            pid: child.pid,
                            code,
                            signal,
                            stderrDiagnostics,
                        });
                    }
                    resolve(code);
                });
                return;
            }
            if (signal) {
                settle(async () => {
                    await writeNonZeroSessionExitDiagnostics({
                        spec,
                        pid: child.pid,
                        code: null,
                        signal,
                        stderrDiagnostics,
                    });
                    resolve(1);
                });
                return;
            }
            settle(async () => {
                await writeNonZeroSessionExitDiagnostics({
                    spec,
                    pid: child.pid,
                    code: null,
                    signal: null,
                    stderrDiagnostics,
                });
                resolve(1);
            });
        });
    });
}

async function runLaunchSpecFile(specPath) {
    return await runLaunchSpec(await readLaunchSpecFile(specPath));
}

async function main(argv) {
    if (argv.length !== 3) {
        console.error('Usage: terminal_launch_spec_runner.cjs <launch-spec.json>');
        return 64;
    }
    return await runLaunchSpecFile(argv[2]);
}

module.exports = {
    readLaunchSpecFile,
    runLaunchSpec,
    runLaunchSpecFile,
};

if (require.main === module) {
    main(process.argv).then(
        (code) => {
            process.exit(code);
        },
        (error) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exit(127);
        },
    );
}
