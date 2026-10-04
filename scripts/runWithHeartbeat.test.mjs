import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const heartbeat = fileURLToPath(new URL('./runWithHeartbeat.mjs', import.meta.url));

function runFixture(source, env = {}) {
    return spawnSync(process.execPath, [heartbeat, '--label', 'compiler-fixture', '--', process.execPath, '-e', source], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
}

test('heartbeat preserves successful command output without a failure diagnostic', () => {
    const result = runFixture("process.stdout.write('compiler-output'); process.stderr.write('compiler-warning');");
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, 'compiler-output');
    assert.equal(result.stderr, 'compiler-warning');
});

test('heartbeat reports a silent failed command while retaining its exit status', () => {
    const result = runFixture('process.exit(7);');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 7);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /compiler-fixture/u);
    assert.match(result.stderr, /\b7\b/u);
});

test('heartbeat identifies a command terminated by a signal', { skip: process.platform === 'win32' }, () => {
    const result = runFixture("process.kill(process.pid, 'SIGTERM');");
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /compiler-fixture/u);
    assert.match(result.stderr, /SIGTERM/u);
});

test('heartbeat annotates the actual failed command status in GitHub Actions', () => {
    const result = runFixture('process.exit(7);', { GITHUB_ACTIONS: 'true' });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 7);
    assert.match(result.stderr, /^::error::/u);
    assert.match(result.stderr, /\b7\b/u);
});
