import { describe, expect, it } from 'vitest';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import {
    openQualifiedConnectedAccountContentEnvelope,
    sealQualifiedConnectedAccountContentEnvelope,
    type QualifiedConnectedAccountCredentialPayloadV1,
} from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import type { StoredJsonContentEnvelope } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { openSavedSecretResourceStoredContentV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';

import { readQualifiedConnectedAccountCredentialMaterial } from './credentialMaterial.js';

const account = { service: { pluginId: 'test.credentials', localId: 'cloud' }, accountId: 'selected-account' };
const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
const randomBytes = (length: number) => new Uint8Array(length).fill(3);

function snapshotFor(payload: QualifiedConnectedAccountCredentialPayloadV1, mode: 'plain' | 'e2ee' = 'plain') {
    const content = mode === 'plain'
        ? sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', payload, randomBytes })
        : sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee', material, payload, randomBytes });
    return QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: account, authenticationModeId: 'api-key', revisionSemantics: 'revisioned',
        credentialRevision, configurationRevision: null, metadata: { scopes: [] }, content,
    });
}

function openCredentialContent(mode: 'plain' | 'e2ee', envelope: StoredJsonContentEnvelope) {
    return mode === 'plain'
        ? openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', envelope })
        : openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee', material, envelope });
}

describe('selected Account credential material', () => {
    it('uses the admitted operation reader for repeated references and independent acquisitions', async () => {
        const reference = 'happier:shared-secret:v1:selected-key';
        const snapshot = snapshotFor({ v: 1, values: {}, secretRefs: { token: reference, apiKey: reference } });
        let current = 'first-key';
        const acquired: string[] = [];
        const acquire = () => readQualifiedConnectedAccountCredentialMaterial({
            account, getAccountEncryptionMode: async () => 'plain', openCredentialContent,
            readCredential: async () => snapshot,
            // Saved Secret storage boundary: admission captures one native read
            // for each selected reference and returns only that operation's reader.
            secrets: {
                admit: async references => {
                    const material = new Map([...new Set(references)].map(ref => {
                        acquired.push(ref);
                        return [ref, current] as const;
                    }));
                    return { read: async (ref: string) => material.get(ref) ?? null };
                },
                read: async () => null,
            },
        });
        expect((await acquire())?.credential.values).toEqual({ token: 'first-key', apiKey: 'first-key' });
        current = 'rotated-key';
        expect((await acquire())?.credential.values).toEqual({ token: 'rotated-key', apiKey: 'rotated-key' });
        expect(acquired).toEqual([reference, reference]);
    });

    it.each(['credentialOpen', 'secretRead'] as const)('settles local cancellation while %s is waiting without disclosing material', async phase => {
        const reference = 'happier:shared-secret:v1:selected-key';
        const snapshot = snapshotFor(phase === 'credentialOpen'
            ? { v: 1, values: { token: 'must-not-disclose' } }
            : { v: 1, values: {}, secretRefs: { token: reference } });
        const controller = new AbortController();
        let release: () => void = () => {};
        let entered: () => void = () => {};
        const pending = new Promise<void>(resolve => { release = resolve; });
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const hold = async () => { entered(); await pending; };
        const acquisition = readQualifiedConnectedAccountCredentialMaterial({
            account, signal: controller.signal, getAccountEncryptionMode: async () => 'plain', readCredential: async () => snapshot,
            // The host may wait on OS key acquisition before the real cipher opens.
            openCredentialContent: async (mode, content) => {
                if (phase === 'credentialOpen') await hold();
                return openCredentialContent(mode, content);
            },
            // Saved Secret storage can also remain pending during local cancellation.
            secrets: { admit: async () => undefined, read: async () => { await hold(); return 'must-not-disclose'; } },
        });
        await waiting;
        const cancellation = new Error('local acquisition cancelled');
        controller.abort(cancellation);
        release();
        await expect(acquisition).rejects.toBe(cancellation);
    });

    it.each(['plain', 'e2ee'] as const)('opens one selected %s credential without a Machine or native credential projection', async mode => {
        const snapshot = snapshotFor({ v: 1, values: { token: 'selected-token' } }, mode);
        // Credential HTTP boundary returns its schema-admitted exact record.
        const reads: unknown[] = [];
        const result = await readQualifiedConnectedAccountCredentialMaterial({
            account, getAccountEncryptionMode: async () => mode, openCredentialContent,
            readCredential: async input => { reads.push(input.ref); return snapshot; },
        });
        expect(result).toEqual({ snapshot, credential: { v: 1, values: { token: 'selected-token' } }, storageMode: mode });
        expect(reads).toEqual([account]);
    });

    it('acquires only held references and observes rotation without copying resource bytes into the credential', async () => {
        const reference = 'happier:shared-secret:v1:selected-key';
        const payload = { v: 1 as const, values: { identity: 'provider-account' }, secretRefs: { token: reference } };
        const snapshot = snapshotFor(payload, 'e2ee');
        // Saved Secret storage boundary. The same selected record rotates in place.
        const records = new Map([[reference, { value: 'first-key', fingerprint: 'first' }]]);
        const admissions: (readonly string[])[] = [];
        const reads: string[] = [];
        const acquire = () => readQualifiedConnectedAccountCredentialMaterial({
            account, getAccountEncryptionMode: async () => 'e2ee', openCredentialContent,
            readCredential: async () => snapshot,
            secrets: {
                admit: async references => { admissions.push(references); },
                read: async ref => records.get(ref)?.value ?? null,
                readMaterial: async ref => { reads.push(ref); return records.get(ref) ?? null; },
            },
        });
        expect((await acquire())?.credential.values).toEqual({ identity: 'provider-account', token: 'first-key' });
        records.set(reference, { value: 'rotated-key', fingerprint: 'rotated' });
        expect((await acquire())?.credential.values.token).toBe('rotated-key');
        expect(openCredentialContent('e2ee', snapshot.content)).toEqual(payload);
        expect(admissions).toEqual([[reference], [reference]]);
        expect(reads).toEqual([reference, reference]);
    });

    it('keeps absent credentials distinct from unavailable Account mode', async () => {
        let reads = 0;
        const readCredential = async () => { reads++; return null; };
        await expect(readQualifiedConnectedAccountCredentialMaterial({
            account, getAccountEncryptionMode: async () => 'plain', readCredential, openCredentialContent,
        })).resolves.toBeNull();
        await expect(readQualifiedConnectedAccountCredentialMaterial({
            account, getAccountEncryptionMode: async () => 'unknown', readCredential, openCredentialContent,
        })).rejects.toMatchObject({ code: 'account_encryption_mode_unavailable' });
        expect(reads).toBe(1);
    });

    it('opens a Home-managed Plain resource for an E2EE Account through the resource-mode owner', async () => {
        const resourceId = 'home-managed-key';
        const reference = `happier:shared-secret:v1:${resourceId}`;
        const snapshot = snapshotFor({ v: 1, values: {}, secretRefs: { token: reference } }, 'e2ee');
        const storedContent = sealSavedSecretResourceStoredContentV1({
            resourceId, mode: 'plain', content: { v: 1, name: 'Home-managed key', kind: 'token', value: 'home-managed-token' },
        });
        // Resource HTTP boundary has already supplied its explicit resource mode.
        const readResource = async () => openSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', storedContent })?.value ?? null;
        const result = await readQualifiedConnectedAccountCredentialMaterial({
            account, getAccountEncryptionMode: async () => 'e2ee', readCredential: async () => snapshot, openCredentialContent,
            secrets: { admit: async () => undefined, read: readResource },
        });
        expect(result?.credential.values.token).toBe('home-managed-token');
        expect(openCredentialContent('e2ee', snapshot.content)).toEqual({ v: 1, values: {}, secretRefs: { token: reference } });
        await expect(readQualifiedConnectedAccountCredentialMaterial({
            account, getAccountEncryptionMode: async () => 'e2ee', readCredential: async () => snapshot, openCredentialContent,
            secrets: { admit: async () => undefined, read: async () => openSavedSecretResourceStoredContentV1({
                resourceId, mode: 'e2ee', storedContent, resourceDataKey: new Uint8Array(32).fill(8),
            })?.value ?? null },
        })).rejects.toMatchObject({ code: 'connected_account_credential_secret_unavailable' });
    });

    it.each([
        { change: { ref: { ...account, accountId: 'another-account' } }, code: 'credential_snapshot_identity_mismatch' },
        { change: { revisionSemantics: 'legacy_unfenced', credentialRevision: null }, code: 'credential_snapshot_unfenced' },
        { change: { authenticationModeId: null }, code: 'credential_authentication_mode_unavailable' },
    ])('refuses $code before opening credential content', async ({ change, code }) => {
        const snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
            ...snapshotFor({ v: 1, values: { token: 'must-not-open' } }), ...change,
        });
        let opens = 0;
        await expect(readQualifiedConnectedAccountCredentialMaterial({
            account, getAccountEncryptionMode: async () => 'plain', readCredential: async () => snapshot,
            openCredentialContent: (mode, content) => { opens++; return openCredentialContent(mode, content); },
        })).rejects.toMatchObject({ code });
        expect(opens).toBe(0);
    });

    it('preserves the typed mode mismatch and missing Saved Secret refusals', async () => {
        const reference = 'happier:shared-secret:v1:selected-key';
        const snapshot = snapshotFor({ v: 1, values: {}, secretRefs: { token: reference } });
        await expect(readQualifiedConnectedAccountCredentialMaterial({
            account, getAccountEncryptionMode: async () => 'e2ee', readCredential: async () => snapshot, openCredentialContent,
        })).rejects.toMatchObject({ code: 'credential_content_unavailable' });
        await expect(readQualifiedConnectedAccountCredentialMaterial({
            account, getAccountEncryptionMode: async () => 'plain', readCredential: async () => snapshot, openCredentialContent,
            secrets: { admit: async () => undefined, read: async () => null },
        })).rejects.toMatchObject({ code: 'connected_account_credential_secret_unavailable' });
    });
});
