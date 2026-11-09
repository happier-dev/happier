import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { hasStackContext, readStackBootCredentials } from './bootCredentials';

// Synthetic values in the exact shapes the CLI persistence owner writes to `servers/<id>/access.key`
// (`writeCredentialsLegacy`, `writeCredentialsDataKey`, `encodeStoredCredentials`). The host passes
// them through unread; the UI's `parseDesktopBootCredentials` is the only decoder.
const cliShapes = {
    legacy: { secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=', token: 'legacy-token' },
    dataKey: { encryption: { publicKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=', machineKey: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=' }, token: 'data-key-token' },
    tokenOnly: { token: 'token-only' },
    released02TokenOnly: { token: 'token-only', encryption: null },
    historical: { token: 'historical-token', secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=', custody: 'historical' },
} as const;

async function createHome(): Promise<string> {
    return await mkdtemp(join(tmpdir(), 'happier-desktop-boot-'));
}

async function writeServerKey(home: string, serverId: string, value: unknown): Promise<void> {
    await mkdir(join(home, 'servers', serverId), { recursive: true });
    await writeFile(join(home, 'servers', serverId, 'access.key'), JSON.stringify(value, null, 2), 'utf8');
}

function stackEnv(home: string, serverId?: string): (key: string) => string | undefined {
    return (key) => {
        if (key === 'HAPPIER_HOME_DIR') return home;
        if (key === 'HAPPIER_ACTIVE_SERVER_ID') return serverId;
        return undefined;
    };
}

test('stack context is detected from any of the three stack environment variables', () => {
    assert.equal(hasStackContext(() => undefined), false);
    assert.equal(hasStackContext((key) => (key === 'HAPPIER_STACK_STACK' ? 'dev' : undefined)), true);
    assert.equal(hasStackContext((key) => (key === 'HAPPIER_HOME_DIR' ? '/home' : undefined)), true);
    assert.equal(hasStackContext((key) => (key === 'HAPPIER_STACK_STACK' ? '   ' : undefined)), false);
});

test('every CLI access.key shape reaches the renderer unchanged, including the legacy secret', async () => {
    for (const [name, value] of Object.entries(cliShapes)) {
        const home = await createHome();
        await writeServerKey(home, 'stack_dev__id_default', value);
        assert.deepEqual(await readStackBootCredentials(stackEnv(home, 'stack_dev__id_default')), value, name);
    }
});

test('a missing selected-server key never falls back to the Home-level access.key', async () => {
    const home = await createHome();
    await writeFile(join(home, 'access.key'), JSON.stringify(cliShapes.tokenOnly), 'utf8');

    assert.equal(await readStackBootCredentials(stackEnv(home, 'stack_dev__id_default')), null);
});

test('an unresolved server id yields no credentials even when a Home-level access.key exists', async () => {
    const home = await createHome();
    await writeFile(join(home, 'access.key'), JSON.stringify(cliShapes.tokenOnly), 'utf8');

    assert.equal(await readStackBootCredentials(stackEnv(home)), null);
});

test('no stack context yields no credentials even when a key file exists', async () => {
    const home = await createHome();
    await writeServerKey(home, 'srv-1', cliShapes.tokenOnly);

    assert.equal(await readStackBootCredentials((key) => (key === 'HAPPIER_ACTIVE_SERVER_ID' ? 'srv-1' : undefined)), null);
});

test('a stack launch reads the key of the server named by settings.json', async () => {
    const home = await createHome();
    await writeFile(join(home, 'settings.json'), JSON.stringify({ activeServerId: 'srv-1' }), 'utf8');
    await writeServerKey(home, 'srv-1', cliShapes.dataKey);

    assert.deepEqual(await readStackBootCredentials(stackEnv(home)), cliShapes.dataKey);
});

test('an unparseable key file yields no credentials', async () => {
    const home = await createHome();
    await mkdir(join(home, 'servers', 'srv-1'), { recursive: true });
    await writeFile(join(home, 'servers', 'srv-1', 'access.key'), 'not json', 'utf8');

    assert.equal(await readStackBootCredentials(stackEnv(home, 'srv-1')), null);
});
