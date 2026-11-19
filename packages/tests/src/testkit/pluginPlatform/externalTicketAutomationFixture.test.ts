import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { buildExternalTicketAutomationFixture } from './externalTicketAutomationFixture';

let testDir: string | undefined;
afterEach(async () => {
    vi.unstubAllEnvs();
    if (testDir) await rm(testDir, { recursive: true, force: true });
    testDir = undefined;
}, 0);

it('builds the instrumented ticket plugin through the public author toolchain', async () => {
    vi.stubEnv('HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT', '1');
    testDir = await mkdtemp(join(tmpdir(), 'external-ticket-automation-'));
    const { pluginRoot } = await buildExternalTicketAutomationFixture(testDir, 'acme.tickets');

    expect(JSON.parse(await readFile(join(pluginRoot, '.happier-plugin/plugin.json'), 'utf8')))
        .toMatchObject({ id: 'acme.tickets' });
    expect((await stat(join(pluginRoot, 'dist/index.js'))).size).toBeGreaterThan(0);
}, 0);
