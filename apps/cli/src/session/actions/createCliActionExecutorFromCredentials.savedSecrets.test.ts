import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createSavedSecretsCliHttpFixture } from '@/cli/actions/adapters/savedSecretsCliHttpFixture';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

describe('ordinary CLI Saved Secret native source custody', () => {
    it('stores through the installed Machine runtime only when the personal Action needs a native source', async () => {
        const home = await createSavedSecretsCliHttpFixture();
        const plugin = definePlugin({ id: 'acme.cli-vault', version: '1.0.0', displayName: 'CLI vault',
            entrypoints: { daemon: './daemon.mjs' }, secretSources: { vault: { declaration: { title: 'Vault' }, runtime: {
                async acquire() { return { ok: true, value: 'fixture-native-value' }; },
                async store(input) { return { ok: true, account: input.account, reference: 'op://vault/new/token' }; },
            } } } });
        const previousHome = process.env.HAPPIER_CLI_VAULT_TEST_HOME;
        let installed: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
        try {
            installed = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
                runtimeOptions: { scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } }, plugins: [{
                manifest: plugin.manifest,
                files: { 'daemon.mjs': `import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function activate(api) {
  const marker = join(process.env.HAPPIER_CLI_VAULT_TEST_HOME, 'native-calls');
  await appendFile(marker, 'activate\\n');
  api.secretSources.register('vault', {
    async acquire() { return { ok: true, value: 'fixture-native-value' }; },
    async store(input) { await appendFile(marker, 'store\\n'); return { ok: true, account: input.account, reference: 'op://vault/new/token' }; }
  });
}` },
            }] });
            process.env.HAPPIER_CLI_VAULT_TEST_HOME = installed.happyHomeDir;
            const credentials = await home.deps.readCredentialsFn!();
            if (!credentials) throw new Error('Fixture credentials unavailable');
            const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'home-fixture',
                serverApiUrl: home.origin, serverIdentityId: 'srv_fixture', ...{ happyHomeDir: installed.happyHomeDir } });
            await expect(executor.execute('secrets.create', { name: 'Inline', value: 'inline-private-value' }, { surface: 'cli' }))
                .resolves.toMatchObject({ ok: true, result: { secretRef: expect.any(String) } });
            await expect(readFile(join(installed.happyHomeDir, 'native-calls'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            const native = await executor.execute('secrets.create', { name: 'Native token', value: 'new-private-value',
                storeIn: { contribution: { pluginId: plugin.manifest.id, localId: 'vault' }, account: 'chosen-account', vaultId: 'vault' },
            }, { surface: 'cli' });
            if (!native.ok) throw new Error(`Native create failed: ${native.errorCode}`);
            expect(native).toMatchObject({ ok: true, result: { secretRef: expect.any(String) } });
            expect(home.opened(home.writes.at(-1)!)).toMatchObject({ v: 2, source: { kind: 'external',
                contribution: { pluginId: plugin.manifest.id, localId: 'vault' }, account: 'chosen-account', reference: 'op://vault/new/token' } });
            expect(await readFile(join(installed.happyHomeDir, 'native-calls'), 'utf8')).toBe('activate\nstore\n');
        } finally {
            if (previousHome === undefined) delete process.env.HAPPIER_CLI_VAULT_TEST_HOME;
            else process.env.HAPPIER_CLI_VAULT_TEST_HOME = previousHome;
            await installed?.dispose();
            await home.close();
        }
    });
});
