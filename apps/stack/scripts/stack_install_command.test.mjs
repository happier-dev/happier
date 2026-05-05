import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function loadStackInstallModule() {
    try {
        return await import('./stack/stack_install_command.mjs');
    } catch (error) {
        assert.fail(`stack install command module should exist: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const stackScript = join(scriptsDir, 'stack.mjs');

test('hstack stack install dry-run plans runtime, service, and desktop installation', async (t) => {
    const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-install-plan-'));
    t.after(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    const res = spawnSync(
        process.execPath,
        [
            stackScript,
            'install',
            'local-prod',
            '--repo=/repo/happier',
            '--port=4305',
            '--dry-run',
            '--json',
            '--desktop-platform=darwin',
        ],
        {
            cwd: dirname(scriptsDir),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HAPPIER_STACK_STORAGE_DIR: join(tmp, 'stacks'),
            },
        },
    );

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^\s*\{/, res.stdout);
    const payload = JSON.parse(res.stdout);

    assert.equal(payload.ok, true);
    assert.equal(payload.stackName, 'local-prod');
    assert.equal(payload.dryRun, true);
    assert.deepEqual(
        payload.steps.map((step) => step.id),
        ['create-stack', 'build-runtime', 'set-runtime-mode', 'build-desktop', 'install-service', 'restart-service', 'install-desktop'],
    );
    assert.equal(payload.desktop.productName, 'Happier (local-prod)');
    assert.equal(payload.desktop.identifier, 'com.happier.stack.local-prod');
    assert.equal(payload.desktop.serverUrl, 'http://127.0.0.1:4305');
});

test('buildStackInstallPlan skips desktop steps when disabled on non-macOS platforms', async () => {
    const { buildStackInstallPlan } = await loadStackInstallModule();
    const plan = await buildStackInstallPlan({
        rootDir: '/repo/apps/stack',
        stackName: 'linux-prod',
        argv: ['--port=4310', '--no-desktop'],
        platform: 'linux',
        stackExists: () => false,
    });

    assert.equal(plan.desktopMode, 'none');
    assert.equal(plan.desktop, null);
    assert.deepEqual(
        plan.steps.map((step) => step.id),
        ['create-stack', 'build-runtime', 'set-runtime-mode', 'install-service', 'restart-service'],
    );
});

test('buildStackInstallPlan rejects desktop build mode on non-macOS platforms', async () => {
    const { buildStackInstallPlan } = await loadStackInstallModule();

    await assert.rejects(
        () =>
            buildStackInstallPlan({
                rootDir: '/repo/apps/stack',
                stackName: 'linux-prod',
                argv: ['--desktop=build'],
                platform: 'linux',
                stackExists: () => false,
            }),
        /desktop (installation|build).*only supported on macOS/i,
    );
});

test('hstack stack install dry-run rejects an explicit port reserved by a stopped stack', async (t) => {
    const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-install-port-reserved-'));
    t.after(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    const storageDir = join(tmp, 'stacks');
    const reservedStackDir = join(storageDir, 'stopped-prod');
    await mkdir(reservedStackDir, { recursive: true });
    await writeFile(
        join(reservedStackDir, 'env'),
        [
            'HAPPIER_STACK_STACK=stopped-prod',
            'HAPPIER_STACK_SERVER_PORT=4315',
        ].join('\n'),
        'utf-8',
    );

    const res = spawnSync(
        process.execPath,
        [
            stackScript,
            'install',
            'next-prod',
            '--port=4315',
            '--dry-run',
            '--json',
            '--no-desktop',
        ],
        {
            cwd: dirname(scriptsDir),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HAPPIER_STACK_STORAGE_DIR: storageDir,
            },
        },
    );

    assert.notEqual(res.status, 0, `expected reserved port to be rejected\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /port 4315 is already reserved by another stack env/i, res.stderr);
});

test('hstack stack install dry-run plans repo updates for existing stacks', async (t) => {
    const tmp = await mkdtemp(join(tmpdir(), 'hstack-stack-install-existing-'));
    t.after(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    const storageDir = join(tmp, 'stacks');
    const stackName = 'existing-prod';
    const stackDir = join(storageDir, stackName);
    await mkdir(stackDir, { recursive: true });
    await writeFile(
        join(stackDir, 'env'),
        [
            `HAPPIER_STACK_STACK=${stackName}`,
            'HAPPIER_STACK_SERVER_PORT=4309',
            'HAPPIER_STACK_REPO_DIR=/old/repo',
        ].join('\n'),
        'utf-8',
    );

    const res = spawnSync(
        process.execPath,
        [
            stackScript,
            'install',
            stackName,
            '--repo=/next/repo',
            '--dry-run',
            '--json',
            '--no-desktop',
        ],
        {
            cwd: dirname(scriptsDir),
            encoding: 'utf-8',
            env: {
                ...process.env,
                HAPPIER_STACK_STORAGE_DIR: storageDir,
            },
        },
    );

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^\s*\{/, res.stdout);
    const payload = JSON.parse(res.stdout);
    const updateStep = payload.steps.find((step) => step.id === 'update-stack-env');

    assert.deepEqual(updateStep.envUpdates, [
        { key: 'HAPPIER_STACK_SERVER_PORT', value: '4309' },
        { key: 'HAPPIER_STACK_REPO_DIR', value: '/next/repo' },
    ]);
});
