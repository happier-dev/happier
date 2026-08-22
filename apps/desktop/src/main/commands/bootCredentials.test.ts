import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildCandidatePaths, hasStackContext, parseBootCredentials, readStackBootCredentials } from './bootCredentials';

test('stack context is detected from any of the three stack environment variables', () => {
    assert.equal(hasStackContext(() => undefined), false);
    assert.equal(hasStackContext((key) => (key === 'HAPPIER_STACK_STACK' ? 'dev' : undefined)), true);
    assert.equal(hasStackContext((key) => (key === 'HAPPIER_HOME_DIR' ? '/home' : undefined)), true);
    assert.equal(hasStackContext((key) => (key === 'HAPPIER_STACK_STACK' ? '   ' : undefined)), false);
});

test('credentials without a usable token or with half-filled encryption are rejected', () => {
    assert.equal(parseBootCredentials('not json'), null);
    assert.equal(parseBootCredentials('{"token":"  "}'), null);
    assert.equal(parseBootCredentials('{"token":"t","encryption":{"publicKey":"p"}}'), null);
    assert.deepEqual(parseBootCredentials('{"token":"t"}'), { token: 't', encryption: null });
    assert.deepEqual(parseBootCredentials('{"token":"t","encryption":{"publicKey":"p","machineKey":"m"}}'), {
        token: 't',
        encryption: { publicKey: 'p', machineKey: 'm' },
    });
});

test('the active server key is preferred over the home-level key', () => {
    assert.deepEqual(buildCandidatePaths('/home', 'srv-1'), [
        join('/home', 'servers', 'srv-1', 'access.key'),
        join('/home', 'access.key'),
    ]);
    assert.deepEqual(buildCandidatePaths('/home', null), [join('/home', 'access.key')]);
});

test('no stack context yields no credentials even when a key file exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-desktop-boot-'));
    await writeFile(join(home, 'access.key'), '{"token":"from-disk"}', 'utf8');

    assert.equal(await readStackBootCredentials(() => undefined), null);
});

test('a stack launch reads the active server key named by settings.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-desktop-boot-'));
    await writeFile(join(home, 'settings.json'), JSON.stringify({ activeServerId: 'srv-1' }), 'utf8');
    await writeFile(join(home, 'access.key'), '{"token":"home-level"}', 'utf8');
    await mkdir(join(home, 'servers', 'srv-1'), { recursive: true });
    await writeFile(join(home, 'servers', 'srv-1', 'access.key'), '{"token":"active-server"}', 'utf8');

    const credentials = await readStackBootCredentials((key) =>
        key === 'HAPPIER_HOME_DIR' ? home : undefined,
    );

    assert.deepEqual(credentials, { token: 'active-server', encryption: null });
});

test('an unreadable active server key falls through to the home-level key', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-desktop-boot-'));
    await writeFile(join(home, 'access.key'), '{"token":"home-level"}', 'utf8');

    const credentials = await readStackBootCredentials((key) => {
        if (key === 'HAPPIER_STACK_CLI_HOME_DIR') return home;
        if (key === 'HAPPIER_ACTIVE_SERVER_ID') return 'missing-server';
        return undefined;
    });

    assert.deepEqual(credentials, { token: 'home-level', encryption: null });
});
