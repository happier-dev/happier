import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStackDaemonStatePaths } from './utils/auth/credentials_paths.mjs';

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

async function createFakeMonorepo(rootDir) {
    await mkdir(join(rootDir, 'node_modules'), { recursive: true });
    await mkdir(join(rootDir, 'apps', 'cli', 'dist'), { recursive: true });
    await mkdir(join(rootDir, 'apps', 'ui'), { recursive: true });
    await mkdir(join(rootDir, 'apps', 'server'), { recursive: true });

    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: 'fake-happier-root', private: true }) + '\n', 'utf-8');
    await writeFile(join(rootDir, 'apps', 'cli', 'package.json'), JSON.stringify({ name: 'fake-cli', private: true }) + '\n', 'utf-8');
    await writeFile(join(rootDir, 'apps', 'ui', 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');
    await writeFile(
        join(rootDir, 'apps', 'server', 'package.json'),
        JSON.stringify({ name: 'fake-server', private: true, scripts: { start: 'node server.mjs' } }) + '\n',
        'utf-8',
    );
    await writeFile(join(rootDir, 'apps', 'cli', 'dist', 'index.mjs'), 'process.exit(0);\n', 'utf-8');
}

function spawnOtherServerDaemon(cliHomeDir) {
    return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
        detached: true,
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

async function withHealthServer(fn) {
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
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    assert.ok(port, 'expected health server port');
    try {
        await fn({ port });
    } finally {
        await new Promise((resolve) => server.close(resolve));
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
                env: {
                    ...process.env,
                    CI: '1',
                    HAPPIER_STACK_REPO_DIR: fakeRepo,
                    HAPPIER_STACK_STORAGE_DIR: storageDir,
                    HAPPIER_STACK_STACK: stackName,
                    HAPPIER_STACK_CLI_BUILD: '0',
                },
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

        await withHealthServer(async ({ port }) => {
            const result = await runNode([runScript, '--no-ui'], {
                cwd: repoRoot,
                env: {
                    ...process.env,
                    CI: '1',
                    HAPPIER_STACK_REPO_DIR: fakeRepo,
                    HAPPIER_STACK_STORAGE_DIR: storageDir,
                    HAPPIER_STACK_STACK: stackName,
                    HAPPIER_STACK_CLI_BUILD: '0',
                    HAPPIER_STACK_SERVER_PORT: String(port),
                },
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
        await rm(tempRoot, { recursive: true, force: true });
    }
});
