import { describe, expect, it } from 'vitest';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { sealAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import { AccountEncryptionMigrateRemoteHostsResultV1Schema, openRemoteHostCatalogContentV1, RemoteHostCatalogRecordV1Schema, RemoteHostCatalogRowReadResponseV1Schema, sealRemoteHostCatalogContentV1,
    readRetainedRemoteHostCatalogV1, type RemoteHostRecordV1 } from './remoteHostRecordV1.js';

const host = {
    id: 'retained-host', name: 'Workstation',
    ssh: { target: 'dev@example.test', authMode: 'password', passwordSecretRef: formatSharedSavedSecretRefV1('password-resource') },
    createdAt: 1, updatedAt: 2, lastUsedAt: null,
} satisfies RemoteHostRecordV1;

describe('Remote host catalog admission', () => {
    it('refuses credential carriers before the row transport can strip envelope extras', () => {
        for (const extra of [
            { secretRef: formatSharedSavedSecretRefV1('envelope-resource') },
            { credential: { _isSecretValue: true, value: 'private-envelope-material' } },
        ]) {
            const parsed = RemoteHostCatalogRowReadResponseV1Schema.safeParse({ status: 'present', revision: 3,
                content: { t: 'plain', v: { v: 1, hosts: [host] }, ...extra } });
            const opened = parsed.success && parsed.data.status === 'present'
                ? openRemoteHostCatalogContentV1({ mode: 'plain', material: null, content: parsed.data.content })
                : { status: 'unavailable', reason: 'invalid-stored-content' };
            expect(opened)
                .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
        }
        const row = RemoteHostCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 3,
            content: { t: 'plain', v: { v: 1, hosts: [host] }, label: 'harmless envelope metadata' } });
        expect(row.status).toBe('present');
        if (row.status !== 'present') throw new Error('Expected the stored host row');
        expect(openRemoteHostCatalogContentV1({ mode: 'plain', material: null, content: row.content }))
            .toEqual({ status: 'ready', hosts: [host], diagnostics: [] });
    });
    it.each(['plain', 'e2ee'] as const)('refuses a whole-row census that would discard a catalog-level credential carrier but permits harmless extras (%s)', mode => {
        const material = mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const content = (record: unknown) => material === null ? { t: 'plain' as const, v: record }
            : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_remote_host_catalog', material, payload: record,
                randomBytes: length => new Uint8Array(length).fill(9) }) };
        for (const extra of [
            { secretRef: formatSharedSavedSecretRefV1('catalog-resource') },
            { credential: { _isSecretValue: true, value: 'private-catalog-material' } },
        ]) {
            expect(openRemoteHostCatalogContentV1({ mode, material,
                content: content({ v: 1, hosts: [host], ...extra }) }))
                .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
        }
        expect(openRemoteHostCatalogContentV1({ mode, material,
            content: content({ v: 1, hosts: [host], label: 'harmless catalog metadata' }) }))
            .toEqual({ status: 'ready', hosts: [host], diagnostics: [] });
    });
    it('retains unrecognized marked private material instead of authorizing a lossy host cleanup', () => {
        const candidate = { ...host, ssh: { ...host.ssh, futureCredential: { _isSecretValue: true, value: 'private-future-material' } } };
        expect(openRemoteHostCatalogContentV1({ mode: 'plain', material: null,
            content: { t: 'plain', v: { v: 1, hosts: [candidate] } } })).toMatchObject({ status: 'partial', hosts: [] });
        expect(readRetainedRemoteHostCatalogV1([{ ...candidate, ssh: { target: host.ssh.target, authMode: 'agent',
            futureCredential: candidate.ssh.futureCredential } }])).toMatchObject({ status: 'partial', hosts: [] });
    });
    it('admits only a complete canonical host catalog in a successful encryption conversion result', () => {
        expect(AccountEncryptionMigrateRemoteHostsResultV1Schema.safeParse({ revision: 4,
            content: { t: 'plain', v: { v: 1, hosts: [{ ...host, unknownSecretRef: formatSharedSavedSecretRefV1('unknown') }] } } }).success).toBe(false);
        expect(AccountEncryptionMigrateRemoteHostsResultV1Schema.safeParse({ revision: 4, content: { t: 'plain', v: { v: 1, hosts: [host] } } }).success).toBe(true);
    });
    it('opens additive stored neighbors but refuses a complete census that would discard an unknown reference or inline material', () => {
        const good = { ...host, futureLabel: 'stored', ssh: { ...host.ssh, futureOption: true } };
        const unknownReference = { ...host, id: 'unknown-reference', ssh: { ...host.ssh, futureSecretRef: formatSharedSavedSecretRefV1('future') } };
        const inline = { ...host, id: 'inline-material', ssh: { ...host.ssh, passwordEnc: { _isSecretValue: true, value: 'private-value' } } };
        expect(RemoteHostCatalogRecordV1Schema.safeParse({ v: 1, hosts: [good] }).success).toBe(false);
        expect(openRemoteHostCatalogContentV1({ mode: 'plain', material: null,
            content: { t: 'plain', v: { v: 1, hosts: [good, unknownReference, inline] } } })).toEqual({
                status: 'partial', hosts: [host], diagnostics: [
                    { index: 1, id: 'unknown-reference', reason: 'invalid-stored-content' },
                    { index: 2, id: 'inline-material', reason: 'invalid-stored-content' },
                ],
            });
    });
    it('round-trips reference-only catalogs keylessly in Plain and fails mismatched Account mode or material closed', () => {
        const content = sealRemoteHostCatalogContentV1({ record: { v: 1, hosts: [host] }, mode: 'plain', material: null });
        expect(openRemoteHostCatalogContentV1({ content, mode: 'plain', material: null })).toEqual({ status: 'ready', hosts: [host], diagnostics: [] });
        expect(openRemoteHostCatalogContentV1({ content, mode: 'e2ee', material: null })).toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
        expect(openRemoteHostCatalogContentV1({ content, mode: 'plain', material: { type: 'legacy', secret: new Uint8Array(32) } }))
            .toEqual({ status: 'unavailable', reason: 'account-mode-mismatch' });
    });
    it('opens only the assigned E2EE kind with the captured real key', () => {
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const content = sealRemoteHostCatalogContentV1({ record: { v: 1, hosts: [host] }, mode: 'e2ee', material,
            randomBytes: length => new Uint8Array(length).fill(9) });
        expect(openRemoteHostCatalogContentV1({ content, mode: 'e2ee', material })).toEqual({ status: 'ready', hosts: [host], diagnostics: [] });
        expect(openRemoteHostCatalogContentV1({ content, mode: 'e2ee', material: null })).toEqual({ status: 'unavailable', reason: 'encryption-material-unavailable' });
        expect(openRemoteHostCatalogContentV1({ content, mode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(8) } }))
            .toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
    });
});
