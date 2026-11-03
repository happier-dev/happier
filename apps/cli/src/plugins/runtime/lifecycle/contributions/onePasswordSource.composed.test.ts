import { describe, expect, it } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { ONEPASSWORD_PLUGIN } from '../../../../../../../packages/plugins/onepassword/src/manifest';
import { createSecretSourceHostFixture } from '../../../testkit/secretSources';
import { createUnavailablePluginServices } from '../../invocation/services/unavailable';
import { listOnePasswordFields, readOnePasswordField, storeOnePasswordField } from '../../../../../../../packages/plugins/onepassword/src/read';
import { createStablePluginExecService } from '../../invocation/services/exec';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('1Password public secret-source contribution', () => {
    it('keeps value-bearing native JSON and echoed store stdin out of invocation output', async () => {
        await withTempDir('onepassword-native-json-', async root => {
            const executablePath = join(root, 'native-vault.cjs');
            await writeFile(executablePath, `
                let stdin = '';
                process.stdin.on('data', chunk => { stdin += chunk; });
                process.stdin.on('end', () => {
                    const item = { id: 'item-id', title: 'Token', vault: { id: 'vault-id', name: 'Work' },
                        fields: [{ id: 'password', type: 'CONCEALED', label: 'Password', value: 'private-native-value' }] };
                    process.stderr.write('private-native-stderr' + stdin);
                    process.stdout.write(JSON.stringify(process.argv[3] === 'list'
                        ? [{ id: item.id, title: item.title, vault: item.vault }] : item));
                });
            `);
            const invocationOutput: string[] = [];
            const service = createStablePluginExecService({
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                // Only executable resolution is replaced; managed capture and stdin delivery remain real.
                resolveExecutable: async () => ({ command: process.execPath, args: [executablePath], env: {} }),
                resolvePath: async () => root,
                observeProcessOutput: event => { invocationOutput.push(new TextDecoder().decode(event.data)); },
            });
            const signal = new AbortController().signal;
            const metadata = await listOnePasswordFields({ account: 'work' }, { exec: service }, signal);
            expect(metadata).toMatchObject({ ok: true, fields: [{ reference: 'op://vault-id/item-id/password' }] });
            expect(JSON.stringify(metadata)).not.toContain('private-');
            const stored = await storeOnePasswordField({ account: 'work', vaultId: 'vault-id', title: 'Token', value: 'private-store-value' },
                { exec: service }, signal);
            expect(stored).toEqual({ ok: true, account: 'work', reference: 'op://vault-id/item-id/password' });
            expect(invocationOutput).toEqual([]);
        });
    });
    it('browses and stores through the bundled source with only value-free metadata returning to the host', async () => {
        const requests: Parameters<ExecService['run']>[] = [];
        const services = createUnavailablePluginServices();
        const exec = { ...services.exec, async run(...args: Parameters<ExecService['run']>): Promise<PluginProcessResult> {
            requests.push(args);
            const command = args[0].args?.[1];
            const payload = command === 'list' ? [{ id: 'item-id', title: 'Token', vault: { id: 'v', name: 'Work' } }]
                : { id: command === 'create' ? 'new-id' : 'item-id', title: 'Token', vault: { id: 'v', name: 'Work' },
                    fields: [{ id: 'password', type: 'CONCEALED', label: 'Password', value: 'private-native-value' }] };
            return { stdout: new TextEncoder().encode(JSON.stringify(payload)), stderr: new Uint8Array(),
                stdoutTruncated: false, stderrTruncated: false,
                termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } } };
        } };
        const fixture = await createSecretSourceHostFixture({ plugin: ONEPASSWORD_PLUGIN,
            services: { ...services, exec, secrets: { ...services.secrets, async status() { return { state: 'missing', revision: 'missing' }; } } } });
        try {
            expect(fixture.host.list()[0].capabilities).toEqual({ list: true, store: true });
            expect(requests).toHaveLength(0);
            const metadata = await fixture.host.listFields(fixture.contribution, { account: 'work', vaultId: 'v' });
            expect(metadata).toMatchObject({ ok: true, fields: [{ reference: 'op://v/item-id/password' }] });
            expect(JSON.stringify(metadata)).not.toContain('private-native-value');
            expect(await fixture.host.store(fixture.contribution, { account: 'work', vaultId: 'v', title: 'Token', value: 'private-store-value' }))
                .toEqual({ ok: true, account: 'work', reference: 'op://v/new-id/password' });
            expect(requests.every(([, options]) => options?.outputDelivery === 'captured')).toBe(true);
        } finally { await fixture.dispose(); }
    });
    it('supports optional metadata and private store through the same registration, with safe acquire-only compatibility', async () => {
        const fixture = await createSecretSourceHostFixture({ runtime: {
            async acquire() { return { ok: true, value: 'private-value' }; },
            async list(input) { return { ok: true, fields: [{ account: input.account, reference: 'op://v/i/password',
                vault: { id: 'v', name: 'Work' }, item: { id: 'i', title: 'Token' },
                field: { id: 'password', title: 'Password', kind: 'CONCEALED' } }] }; },
            async store(input) { return { ok: true, account: input.account, reference: 'op://v/new/password' }; },
        } });
        try {
            expect(fixture.host.list()[0].capabilities).toEqual({ list: true, store: true });
            expect(await fixture.host.listFields(fixture.contribution, { account: 'work' })).toMatchObject({ ok: true, fields: [{ reference: 'op://v/i/password' }] });
            expect(await fixture.host.store(fixture.contribution, { account: 'work', vaultId: 'v', title: 'Token', value: 'private-value' }))
                .toEqual({ ok: true, account: 'work', reference: 'op://v/new/password' });
            const signal = AbortSignal.abort();
            expect(await fixture.host.listFields(fixture.contribution, { account: 'work' }, { signal })).toEqual({ ok: false, code: 'cancelled' });
        } finally { await fixture.dispose(); }
        const legacy = await createSecretSourceHostFixture({ runtime: { async acquire() { return { ok: true, value: 'legacy-value' }; } } });
        try {
            expect(await legacy.host.listFields(legacy.contribution, { account: 'work' })).toEqual({ ok: false, code: 'unsupported' });
            expect(await legacy.host.store(legacy.contribution, { account: 'work', vaultId: 'v', title: 'Token', value: 'private-value' }))
                .toEqual({ ok: false, code: 'unsupported' });
            expect(await legacy.host.acquire({ contribution: legacy.contribution, account: 'work', reference: 'legacy-ref' }))
                .toEqual({ ok: true, value: 'legacy-value' });
        } finally { await legacy.dispose(); }
    });

    it('refuses native values accidentally returned in source metadata or store results', async () => {
        const fixture = await createSecretSourceHostFixture({ runtime: {
            async acquire() { return { ok: true, value: 'private-value' }; },
            async list() { return { ok: true, fields: [{ account: 'work', reference: 'op://v/i/password',
                vault: { id: 'v', name: 'Work' }, item: { id: 'i', title: 'Token' },
                field: { id: 'password', title: 'Password', kind: 'CONCEALED', value: 'private-value' } }] }; },
            async store() { return { ok: true, account: 'work', reference: 'op://v/new/password', value: 'private-value' }; },
        } });
        try {
            expect(await fixture.host.listFields(fixture.contribution, { account: 'work' })).toEqual({ ok: false, code: 'acquisition_failed', repair: 'retry' });
            expect(await fixture.host.store(fixture.contribution, { account: 'work', vaultId: 'v', title: 'Token', value: 'private-value' }))
                .toEqual({ ok: false, code: 'acquisition_failed' });
        } finally { await fixture.dispose(); }
    });
    it.each([
        { diagnostic: 'ignored', exitCode: 0, expected: { ok: true, value: 'private-native-stdout' } },
        { diagnostic: 'vault is locked', exitCode: 1, expected: { ok: false, code: 'authentication_required', repair: 'unlock' } },
        { diagnostic: 'user denied authorization', exitCode: 1, expected: { ok: false, code: 'access_denied', repair: 'unlock' } },
        { diagnostic: 'field not found', exitCode: 1, expected: { ok: false, code: 'not_found', repair: 'configure' } },
        { diagnostic: 'unknown failure', exitCode: 1, expected: { ok: false, code: 'acquisition_failed', repair: 'retry' } },
    ])('keeps supervised native output private with $diagnostic', async ({ diagnostic, exitCode, expected }) => {
        await withTempDir('onepassword-native-', async root => {
            const executablePath = join(root, 'native-vault.cjs');
            await writeFile(executablePath, `process.stdout.write('private-native-stdout');process.stderr.write(${JSON.stringify(`${diagnostic}: private-native-stderr`)});process.exitCode=${exitCode};`);
            const invocationOutput: string[] = [];
            const service = createStablePluginExecService({
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                // Native executable resolution is the OS boundary: run a deterministic fixture binary.
                resolveExecutable: async () => ({ command: process.execPath, args: [executablePath], env: {} }),
                resolvePath: async () => root,
                observeProcessOutput: event => { invocationOutput.push(new TextDecoder().decode(event.data)); },
            });
            const outcome = await readOnePasswordField({ account: 'work', reference: 'op://vault/item/password' },
                { exec: service }, new AbortController().signal);
            expect(outcome).toEqual(expected);
            expect(invocationOutput).toEqual([]);
            // A positive control proves this is the live output bridge used by invocation logging/history.
            await service.run({ executable: { kind: 'systemTool', id: 'op' }, args: [] }, { outputDelivery: 'invocation' });
            expect(invocationOutput.join('')).toContain('private-native-stdout');
            expect(invocationOutput.join('')).toContain('private-native-stderr');
        });
    });

    it('refuses a non-reference without starting a native process', async () => {
        let reads = 0;
        const outcome = await readOnePasswordField({ account: 'work', reference: '--help' }, {
            exec: { async run() { reads += 1; throw new Error('must not run'); } },
        }, new AbortController().signal);
        expect(outcome).toEqual({ ok: false, code: 'not_found', repair: 'configure' });
        expect(reads).toBe(0);
    });

    it('reads rotated native values only at acquisition through public registration', async () => {
        const requests: Parameters<ExecService['run']>[] = [];
        const exec = { ...createUnavailablePluginServices().exec,
            async run(...args: Parameters<ExecService['run']>): Promise<PluginProcessResult> {
                requests.push(args);
                return { stdout: new TextEncoder().encode(`value-${requests.length}`), stderr: new Uint8Array(),
                    stdoutTruncated: false, stderrTruncated: false,
                    termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } } };
            },
        };
        const services = createUnavailablePluginServices();
        const fixture = await createSecretSourceHostFixture({
            plugin: ONEPASSWORD_PLUGIN,
            services: { ...services, exec, secrets: { ...services.secrets,
                async status() { return { state: 'missing', revision: 'missing' }; } } },
        });
        try {
            expect(fixture.host.list()).toHaveLength(1);
            expect(requests).toHaveLength(0);
            const source = { contribution: fixture.contribution, account: 'work', reference: 'op://vault/item/password' };
            await expect(fixture.host.acquire(source)).resolves.toEqual({ ok: true, value: 'value-1' });
            await expect(fixture.host.acquire(source)).resolves.toEqual({ ok: true, value: 'value-2' });
            expect(requests).toHaveLength(2);
        } finally { await fixture.dispose(); }
    });
});
