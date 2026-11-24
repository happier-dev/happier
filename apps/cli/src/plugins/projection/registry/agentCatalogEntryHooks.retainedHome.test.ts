import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { expect, it } from 'vitest';

import { activate } from '../../../../../../packages/plugins/codex/src/activate';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/codex/src/manifest';
import { projectAgentConnectedAccountLaunchCatalogEntry } from './agentCatalogEntryHooks';

it('releases the stopped Codex marketplace checkout while preserving resume data and installed plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-retained-home-'));
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
        const home = join(root, 'codex');
        const checkout = join(home, '.tmp', 'plugins');
        const rollout = join(home, 'sessions', 'rollout.jsonl');
        const installed = join(home, 'plugins', 'cache', 'installed.json');
        for (const entry of [checkout, join(home, 'sessions'), join(home, 'plugins', 'cache')]) {
            await mkdir(entry, { recursive: true });
        }
        await writeFile(join(checkout, 'marketplace.json'), '{}');
        await writeFile(rollout, 'session state');
        await writeFile(installed, 'installed plugin');

        const launch = activation.registration('agents', 'codex')?.connectedAccountLaunch;
        if (!launch) throw new Error('Codex Connected Account launch registration is missing');
        const entry = projectAgentConnectedAccountLaunchCatalogEntry({
            pluginId: PLUGIN_MANIFEST.id,
            agentId: 'codex',
            connectedAccountLaunch: launch,
            hostAccess: PLUGIN_MANIFEST.hostAccess,
            isCurrent: () => true,
        });
        // The daemon lifecycle owner supplies the stopped materialization identity root.
        const sanitize = entry.sanitizeRetainedConnectedServiceMaterializedHome;
        if (!sanitize) throw new Error('Codex retained-home sanitizer is missing');
        await sanitize(root);
        await expect(stat(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(rollout, 'utf8')).resolves.toBe('session state');
        await expect(readFile(installed, 'utf8')).resolves.toBe('installed plugin');

        const outside = join(root, 'unowned');
        const outsideCheckout = join(outside, 'plugins');
        await mkdir(outsideCheckout, { recursive: true });
        await rm(join(home, '.tmp'), { recursive: true });
        await symlink(outside, join(home, '.tmp'), 'junction');
        await sanitize(root);
        await expect(stat(outsideCheckout)).resolves.toBeDefined();
    } finally {
        await activation.dispose();
        await rm(root, { recursive: true, force: true });
    }
});
