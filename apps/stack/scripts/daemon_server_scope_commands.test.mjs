import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { resolveStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';
import { spawnDetachedInlineNodeTestProcess } from './testkit/core/spawn_test_process.mjs';
import { waitForProcessExit } from './testkit/stack_stop_sweeps_testkit.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';

function stackPaths() {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const packageRoot = dirname(scriptsDir);
    const repoRoot = dirname(dirname(packageRoot));
    return {
        repoRoot,
        devScript: join(packageRoot, 'scripts', 'dev.mjs'),
        runScript: join(packageRoot, 'scripts', 'run.mjs'),
    };
}

function runNode(args, { cwd, env, timeoutMs = 15000 }) {
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error(`timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, timeoutMs);
        proc.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        proc.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        proc.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        proc.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr });
        });
    });
}

function createIsolatedStackCommandEnv({ tempRoot, fakeRepo, storageDir, stackName, extra = {} }) {
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => {
            if (key.startsWith('HAPPIER_STACK_')) return false;
            return key !== 'HAPPIER_HOME_DIR' && key !== 'HAPPIER_SERVER_URL' && key !== 'HAPPIER_ACTIVE_SERVER_ID';
        }),
    );
    return {
        ...env,
        CI: '1',
        HAPPIER_STACK_HOME_DIR: join(tempRoot, 'home'),
        HAPPIER_STACK_REPO_DIR: fakeRepo,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_STACK: stackName,
        ...extra,
    };
}

async function createFakeMonorepo(rootDir) {
    await mkdir(join(rootDir, 'node_modules'), { recursive: true });
    await mkdir(join(rootDir, 'apps', 'ui'), { recursive: true });
    await mkdir(join(rootDir, 'apps', 'server'), { recursive: true });

    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: 'fake-happier-root', private: true }) + '\n', 'utf-8');
    await writeStubHappierCliFiles(rootDir, {
        packageJsonContent: JSON.stringify({ name: 'fake-cli', private: true }) + '\n',
        distIndexScript: 'process.exit(0);\n',
    });
    await writeFile(join(rootDir, 'apps', 'ui', 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    await writeFile(
        join(rootDir, 'apps', 'server', 'package.json'),
        JSON.stringify({ name: 'fake-server', private: true, scripts: { start: 'node server.mjs' } }) + '\n',
        'utf-8',
    );
}

function spawnOtherServerDaemon(cliHomeDir) {
    return spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1e6)', {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
            ...process.env,
            HAPPIER_HOME_DIR: cliHomeDir,
        },
    });
}

async function writeRunningDaemonState({ cliHomeDir, serverUrl, pid }) {
    const paths = resolveStackDaemonStatePaths({ cliHomeDir, serverUrl });
    await mkdir(dirname(paths.serverScopedStatePath), { recursive: true });
    await writeFile(
        paths.serverScopedStatePath,
        JSON.stringify({ pid, httpPort: 4321, startTime: new Date().toISOString() }) + '\n',
        'utf-8',
    );
}

async function waitForOwnerDeathWatchdogToSettle({ storageDir, stackName }) {
    const logPath = join(storageDir, stackName, 'logs', 'owner-death-watchdog.log');
    const startedAt = Date.now();
    const timeoutMs = 2_000;
    let sawLog = false;

    while (Date.now() - startedAt < timeoutMs) {
        const text = await readFile(logPath, 'utf-8').catch((error) => {
            if (error?.code === 'ENOENT') return '';
            throw error;
        });
        if (text) sawLog = true;
        if (/runtime state missing; exiting|runtime owner changed|sweep complete|sweep failed/i.test(text)) {
            await delay(50);
            return;
        }
        if (!sawLog && Date.now() - startedAt > 250) return;
        await delay(25);
    }
}

async function withStackOwnedHealthServer({ stackName, envPath }, fn) {
    const server = spawnDetachedInlineNodeTestProcess(`
        const { createServer } = require('node:http');
        const server = createServer((req, res) => {
            if (req.url === '/health') {
                res.statusCode = 200;
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ service: 'happier-server', status: 'ok' }));
                return;
            }
            res.statusCode = 404;
            res.end('not found');
        });
        server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
        setInterval(() => {}, 1e6);
    `, {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
            ...process.env,
            HAPPIER_STACK_STACK: stackName,
            HAPPIER_STACK_ENV_FILE: envPath,
            HAPPIER_STACK_PROCESS_KIND: 'server',
        },
    });
    const port = await new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('timed out waiting for owned health server port')), 2_000);
        server.stdout.setEncoding('utf8');
        server.stdout.on('data', (chunk) => {
            buffer += String(chunk);
            const parsed = Number(buffer.split(/\r?\n/).find(Boolean));
            if (Number.isInteger(parsed) && parsed > 0) {
                clearTimeout(timer);
                resolve(parsed);
            }
        });
        server.once('exit', (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`owned health server exited early (code=${code}, signal=${signal})`));
        });
    });
    try {
        await fn({ port });
    } finally {
        try {
            process.kill(-server.pid, 'SIGTERM');
        } catch {
            // ignore cleanup races
        }
        await waitForProcessExit({ pid: server.pid, timeoutMs: 2_000, label: 'owned health server fixture' });
    }
}

test('hstack dev ignores a running daemon from another server scope', async () => {
    const { repoRoot, devScript } = stackPaths();
    const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-dev-daemon-scope-'));
    const fakeRepo = join(tempRoot, 'repo');
    const storageDir = join(tempRoot, 'storage');
    const stackName = 'scope-dev';
    const cliHomeDir = join(storageDir, stackName, 'cli');
    const otherServerUrl = 'https://other.example.test';
    const currentServerUrl = 'https://current.example.test';
    const otherDaemon = spawnOtherServerDaemon(cliHomeDir);

    try {
        await createFakeMonorepo(fakeRepo);
        await writeRunningDaemonState({ cliHomeDir, serverUrl: otherServerUrl, pid: otherDaemon.pid });

        const result = await runNode(
            [devScript, '--no-server', `--server-url=${currentServerUrl}`, '--no-ui', '--no-watch'],
            {
                cwd: repoRoot,
                env: createIsolatedStackCommandEnv({
                    tempRoot,
                    fakeRepo,
                    storageDir,
                    stackName,
                    extra: {
                        HAPPIER_STACK_CLI_BUILD: '0',
                    },
                }),
            },
        );

        assert.equal(result.code, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.doesNotMatch(result.stdout, /dev: already running/);
        assert.match(result.stderr, /daemon auth required/);
    } finally {
        try {
            process.kill(-otherDaemon.pid, 'SIGTERM');
        } catch {
            // ignore cleanup races
        }
        await waitForProcessExit({ pid: otherDaemon.pid, timeoutMs: 2_000, label: 'other-scope daemon fixture' });
        await waitForOwnerDeathWatchdogToSettle({ storageDir, stackName });
        await rm(tempRoot, { recursive: true, force: true });
    }
});

test('hstack start ignores a running daemon from another server scope', async () => {
    const { repoRoot, runScript } = stackPaths();
    const tempRoot = await mkdtemp(join(tmpdir(), 'hstack-start-daemon-scope-'));
    const fakeRepo = join(tempRoot, 'repo');
    const storageDir = join(tempRoot, 'storage');
    const stackName = 'scope-start';
    const cliHomeDir = join(storageDir, stackName, 'cli');
    const otherServerUrl = 'http://127.0.0.1:59991';
    const otherDaemon = spawnOtherServerDaemon(cliHomeDir);

    try {
        await createFakeMonorepo(fakeRepo);
        await writeRunningDaemonState({ cliHomeDir, serverUrl: otherServerUrl, pid: otherDaemon.pid });

        await withStackOwnedHealthServer({
            stackName,
            envPath: join(storageDir, stackName, 'env'),
        }, async ({ port }) => {
            const result = await runNode([runScript, '--no-ui'], {
                cwd: repoRoot,
                env: createIsolatedStackCommandEnv({
                    tempRoot,
                    fakeRepo,
                    storageDir,
                    stackName,
                    extra: {
                        HAPPIER_STACK_CLI_BUILD: '0',
                        HAPPIER_STACK_SERVER_PORT: String(port),
                    },
                }),
            });

            assert.equal(result.code, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
            assert.doesNotMatch(result.stdout, /start: already running/);
            assert.match(result.stderr, /daemon auth required/);
        });
    } finally {
        try {
            process.kill(-otherDaemon.pid, 'SIGTERM');
        } catch {
            // ignore cleanup races
        }
        await waitForProcessExit({ pid: otherDaemon.pid, timeoutMs: 2_000, label: 'other-scope daemon fixture' });
        await waitForOwnerDeathWatchdogToSettle({ storageDir, stackName });
        await rm(tempRoot, { recursive: true, force: true });
    }
});
