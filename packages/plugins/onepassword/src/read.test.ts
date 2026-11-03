import { describe, expect, it } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { listOnePasswordFields, readOnePasswordField, storeOnePasswordField } from './read.js';

const encode = (value: string) => new TextEncoder().encode(value);
const result = (stdout: string, stderr = '', exitCode = 0): PluginProcessResult => ({
    stdout: encode(stdout), stderr: encode(stderr), stdoutTruncated: false, stderrTruncated: false,
    termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
});

describe('1Password private native acquisition', () => {
    it('lists empty vault destinations independently of item fields, with metadata only', async () => {
        const requests: Parameters<ExecService['run']>[] = [];
        const exec: Pick<ExecService, 'run'> = { async run(...args) {
            requests.push(args);
            return result(JSON.stringify(args[0].args[0] === 'vault'
                ? [{ id: 'empty-vault', name: 'Empty', description: 'private-description', contentVersion: 7 }]
                : []));
        } };
        const outcome = await listOnePasswordFields({ account: 'work' }, { exec }, new AbortController().signal);
        expect(outcome).toEqual({ ok: true, vaults: [{ id: 'empty-vault', name: 'Empty' }], fields: [] });
        expect(requests.map(([request]) => request.args)).toEqual([
            ['vault', 'list', '--account', 'work', '--format', 'json'],
            ['item', 'list', '--account', 'work', '--format', 'json'],
        ]);
        expect(requests.every(([, options]) => options?.outputDelivery === 'captured')).toBe(true);
    });

    it('projects only field identities and labels from native item JSON', async () => {
        const requests: Parameters<ExecService['run']>[] = [];
        const exec: Pick<ExecService, 'run'> = { async run(...args) {
            requests.push(args);
            return result(JSON.stringify(args[0].args[0] === 'vault'
                ? [{ id: 'vault-id', name: 'Work' }, { id: 'other-vault', name: 'Other' }]
                : args[0].args[1] === 'list'
                ? [{ id: 'item-id', title: 'Database', vault: { id: 'vault-id', name: 'Work' } }]
                : { id: 'item-id', title: 'Database', vault: { id: 'vault-id', name: 'Work' },
                    fields: [{ id: 'password', type: 'CONCEALED', label: 'Password', value: 'never-disclose' },
                        { id: 'username', type: 'STRING', label: 'Username', value: 'private-user',
                            section: { id: 'credentials', label: 'Credentials' } }],
                    notes: 'private-notes' }));
        } };
        const outcome = await listOnePasswordFields({ account: 'work', vaultId: 'vault-id' }, { exec }, new AbortController().signal);
        expect(outcome).toEqual({ ok: true, vaults: [{ id: 'vault-id', name: 'Work' }], fields: [
            { account: 'work', reference: 'op://vault-id/item-id/password', vault: { id: 'vault-id', name: 'Work' },
                item: { id: 'item-id', title: 'Database' }, field: { id: 'password', title: 'Password', kind: 'CONCEALED' } },
            { account: 'work', reference: 'op://vault-id/item-id/credentials/username', vault: { id: 'vault-id', name: 'Work' },
                item: { id: 'item-id', title: 'Database' }, field: { id: 'username', title: 'Username', kind: 'STRING' } },
        ] });
        expect(JSON.stringify(outcome)).not.toMatch(/never-disclose|private-user|private-notes/);
        expect(requests.every(([, options]) => options?.outputDelivery === 'captured')).toBe(true);
    });

    it('stores exact secret text only through JSON stdin and returns a reference', async () => {
        const requests: Parameters<ExecService['run']>[] = [];
        const exec: Pick<ExecService, 'run'> = { async run(...args) {
            requests.push(args);
            return result(JSON.stringify({ id: 'created-id', vault: { id: 'vault-id' },
                fields: [{ id: 'password', value: ' private\nvalue ' }] }));
        } };
        const outcome = await storeOnePasswordField({ account: 'work', vaultId: 'vault-id', title: 'API token', value: ' private\nvalue ' },
            { exec, serviceAccountToken: 'private-token' }, new AbortController().signal);
        expect(outcome).toEqual({ ok: true, account: 'work', reference: 'op://vault-id/created-id/password' });
        const [request, options] = requests[0];
        expect(request.args).toEqual(['item', 'create', '-', '--account', 'work', '--vault', 'vault-id', '--format', 'json']);
        expect(JSON.parse(new TextDecoder().decode(request.stdin))).toEqual({ title: 'API token', category: 'PASSWORD',
            fields: [{ id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value: ' private\nvalue ' }] });
        expect(JSON.stringify(request.args)).not.toContain('private');
        expect(options?.outputDelivery).toBe('captured');
        expect(JSON.stringify(outcome)).not.toContain('private');
    });

    it.each(['list', 'store'] as const)('settles %s cancellation, locked vault, missing native tool and invalid JSON without native disclosure', async operation => {
        const run = (exec: Pick<ExecService, 'run'>, signal = new AbortController().signal) => operation === 'list'
            ? listOnePasswordFields({ account: 'work' }, { exec }, signal)
            : storeOnePasswordField({ account: 'work', vaultId: 'v', title: 'Token', value: 'private-value' }, { exec }, signal);
        const mustNotRun = { async run() { throw new Error('must not run'); } };
        await expect(run(mustNotRun, AbortSignal.abort())).resolves.toEqual({ ok: false, code: 'cancelled' });
        await expect(run({ async run() { return result('private-output', 'vault is locked: private-diagnostic', 1); } }))
            .resolves.toEqual({ ok: false, code: 'authentication_required', repair: 'unlock' });
        await expect(run({ async run() { throw Object.assign(new Error('private-diagnostic'), { code: 'ENOENT' }); } }))
            .resolves.toEqual({ ok: false, code: 'native_unavailable', repair: 'install' });
        const invalid = await run({ async run() { return result('private-invalid-json'); } });
        expect(invalid).toMatchObject({ ok: false, code: 'acquisition_failed' });
        expect(JSON.stringify(invalid)).not.toContain('private');
        if (operation === 'store') expect(invalid).not.toHaveProperty('repair', 'retry');
    });
    it('preserves exact field bytes and confines service token and cancellation to the native read', async () => {
        const signal = new AbortController().signal;
        const requests: Parameters<ExecService['run']>[] = [];
        // Exec is the public native-process boundary supplied by the host.
        const exec: Pick<ExecService, 'run'> = { async run(...args) { requests.push(args); return result(' value\n'); } };
        const outcome = await readOnePasswordField({ account: 'my-account', reference: 'op://vault/item/field' },
            { exec, serviceAccountToken: 'private-token' }, signal);
        expect(outcome).toEqual({ ok: true, value: ' value\n' });
        expect(requests).toEqual([[{
            executable: { kind: 'systemTool', id: 'op' },
            args: ['read', 'op://vault/item/field', '--account', 'my-account', '--no-newline'],
            env: { OP_SERVICE_ACCOUNT_TOKEN: 'private-token' },
        }, { signal, outputDelivery: 'captured' }]]);
    });

    it.each([
        ['vault is locked', 'authentication_required', 'unlock'],
        ['user denied authorization', 'access_denied', 'unlock'],
        ['field not found', 'not_found', 'configure'],
        ['unrecognized native error', 'acquisition_failed', 'retry'],
    ])('returns closed repair for %s without native output', async (nativeError, code, repair) => {
        const exec: Pick<ExecService, 'run'> = { async run() { return result('sensitive stdout', `${nativeError}: sensitive stderr`, 1); } };
        const outcome = await readOnePasswordField({ account: 'account', reference: 'op://vault/item/field' }, { exec }, new AbortController().signal);
        expect(outcome).toEqual({ ok: false, code, repair });
        expect(JSON.stringify(outcome)).not.toContain('sensitive');
    });

    it('settles missing native executable and pre-cancel without exposing thrown output', async () => {
        let reads = 0;
        const exec: Pick<ExecService, 'run'> = { async run() { reads += 1; throw Object.assign(new Error('secret native output'), { code: 'ENOENT' }); } };
        const source = { account: 'account', reference: 'op://vault/item/field' };
        await expect(readOnePasswordField(source, { exec }, new AbortController().signal)).resolves.toEqual({ ok: false, code: 'native_unavailable', repair: 'install' });
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(readOnePasswordField(source, { exec }, cancelled.signal)).resolves.toEqual({ ok: false, code: 'cancelled' });
        expect(reads).toBe(1);
    });
});
