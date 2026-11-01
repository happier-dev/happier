import { describe, expect, it } from 'vitest';
import { sealQualifiedConnectedAccountContentEnvelope, openQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { parseQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { createConnectedAccountCredentialSettlement } from './credentialSettlement.js';
import { QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountCredentialHealthPatchV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

describe('Connected Account credential settlement', () => {
    it.each(['acknowledged', 'reconciled', 'health-conflict', 'health-unknown'] as const)('settles reconnect health before reporting a recovered Account (%s)', async outcome => {
        const service = { pluginId: 'acme.cloud', localId: 'api' };
        const account = { service, accountId: 'selected' };
        const beforeRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const afterRevision = 'csr_123456789ABCDEFGHJKMNPQRST';
        let credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account,
            authenticationModeId: 'api-key', revisionSemantics: 'revisioned', credentialRevision: beforeRevision,
            configurationRevision: null, content: { t: 'plain', v: { v: 1, values: { token: 'old' } } },
            metadata: { displayName: 'Cloud', scopes: [] },
            health: { v: 1, status: 'needs_reauth', reconnectRequired: true, providerErrorCode: 'login_failed' } });
        let published = false;
        let reads = 0;
        const healthPatches: ReturnType<typeof QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse>[] = [];
        // These adapters model credential/health HTTP CAS: replacing credential
        // bytes retains server health until the separate fenced health effect.
        const persistence = {
            now: () => 1, resolveAccountMode: async () => 'plain' as const,
            seal: (kind: 'credential' | 'configuration', _accountMode: 'plain' | 'e2ee', payload: unknown) =>
                sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode: 'plain', payload, randomBytes: length => new Uint8Array(length) }),
            open: (kind: 'credential' | 'configuration', _accountMode: 'plain' | 'e2ee', envelope: typeof credential.content) =>
                openQualifiedConnectedAccountContentEnvelope({ kind, accountMode: 'plain', envelope }),
            parseConfigurationContent: (value: unknown) => value,
            mutateCredential: async (mutation: Parameters<Parameters<typeof createConnectedAccountCredentialSettlement>[0]['mutateCredential']>[0]) => {
                credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ...credential,
                    credentialRevision: afterRevision, content: mutation.content, metadata: mutation.metadata });
                if (outcome === 'reconciled') throw new Error('credential_ack_lost');
                return { success: true as const, credentialRevision: afterRevision, configurationRevision: null };
            },
            mutateCredentialHealth: async (patch: ReturnType<typeof QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse>) => {
                healthPatches.push(patch);
                expect(patch).toEqual({ ref: account, expectedCredentialRevision: afterRevision,
                    expectedConfigurationRevision: null, health: { v: 1, status: 'connected', reconnectRequired: false } });
                if (outcome === 'health-conflict') throw Object.assign(new Error('health_revision_conflict'), { code: 'revision_conflict' });
                if (outcome === 'health-unknown') throw new Error('health_ack_lost');
                credential = { ...credential, health: patch.health };
            },
            readCredential: async () => { reads += 1; return credential; }, readConfiguration: async () => null,
            readHttpStatus: () => null,
            readFailureCode: (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null,
            onSettled: async () => { expect(credential.health?.status).toBe('connected'); published = true; },
        };
        const owner = createConnectedAccountCredentialSettlement(persistence);
        const settlement = owner.settle({ intent: 'reconnect', service, accountId: account.accountId, authenticationModeId: 'api-key',
            expectedCredentialRevision: beforeRevision, expectedCredentialConfigurationRevision: null, expectedConfigurationRevision: 'unconfigured',
            sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-1', installSource: 'archive' },
            stagedCredentials: { token: 'verified-new' }, displayName: 'Cloud', scopes: [] });
        if (outcome === 'health-unknown') {
            await expect(settlement).rejects.toThrow('health_ack_lost');
            expect(healthPatches).toHaveLength(1);
            expect(reads).toBe(0);
            expect(published).toBe(false);
            return;
        }
        const result = await settlement;
        expect(result).toEqual(outcome === 'health-conflict'
            ? { status: 'conflict', code: 'connected_account_settlement_conflict' } : { status: 'connected', account });
        expect(healthPatches).toHaveLength(1);
        expect(credential.health?.status).toBe(outcome === 'health-conflict' ? 'needs_reauth' : 'connected');
        expect(published).toBe(outcome !== 'health-conflict');
    });
    it.each(['applied', 'outcome_unknown', 'revision_conflict'] as const)('rotates the held key in place and never blindly replays a %s rotation', async status => {
        const service = { pluginId: 'acme.cloud', localId: 'api' };
        const account = { service, accountId: 'held' };
        const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
        const rotations: (readonly Readonly<{ resourceId: string; value: string }>[])[] = [];
        const writes: Parameters<Parameters<typeof createConnectedAccountCredentialSettlement>[0]['mutateCredential']>[0][] = [];
        const held = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account,
            authenticationModeId: 'api-key', revisionSemantics: 'revisioned', credentialRevision, configurationRevision: null,
            content: { t: 'plain', v: { v: 1, values: { organization: 'old-org' },
                secretRefs: { token: formatSharedSavedSecretRefV1('held-key') } } }, metadata: { displayName: 'Old', scopes: [] } });
        const owner = createConnectedAccountCredentialSettlement({
            now: () => 1, resolveAccountMode: async () => 'plain',
            seal: (kind, _accountMode, payload) => sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode: 'plain', payload,
                randomBytes: length => new Uint8Array(length) }),
            open: (kind, _accountMode, envelope) => openQualifiedConnectedAccountContentEnvelope({ kind, accountMode: 'plain', envelope }),
            parseConfigurationContent: value => value,
            mutateCredentialHealth: async () => {},
            rotateCredentialSecrets: async ({ secrets }: Readonly<{ secrets: readonly Readonly<{ resourceId: string; value: string }>[] }>) => {
                rotations.push(secrets);
                if (status === 'revision_conflict') throw Object.assign(new Error(status), { code: status });
                return status;
            },
            promoteCredentialSecrets: async () => { throw new Error('held_resource_replaced'); },
            mutateCredential: async mutation => { writes.push(mutation); return { success: true,
                credentialRevision: 'csr_123456789ABCDEFGHJKMNPQRST', configurationRevision: null }; },
            readCredential: async () => held, readConfiguration: async () => null,
            readHttpStatus: () => null, readFailureCode: error => error && typeof error === 'object' && 'code' in error
                && typeof error.code === 'string' ? error.code : null,
        });
        const request = { intent: 'reconnect' as const, service, accountId: account.accountId, authenticationModeId: 'api-key',
            expectedCredentialRevision: credentialRevision, expectedCredentialConfigurationRevision: null, expectedConfigurationRevision: 'unconfigured',
            sourceCustody: { kind: 'managed' as const, immutableGenerationId: 'artifact-1', installSource: 'archive' as const },
            stagedCredentials: { token: 'rotated-key', organization: 'new-org' },
            credentialSecretResources: { token: { resourceId: 'unused-new-key', displayName: 'Cloud key' } }, displayName: 'Cloud', scopes: [] };
        if (status === 'applied') {
            expect(await owner.settle(request)).toEqual({ status: 'connected', account });
            expect(writes).toHaveLength(1);
            expect(writes[0]).toMatchObject({ savedSecretResourceIds: ['held-key'], metadata: { displayName: 'Cloud' },
                content: { t: 'plain', v: { values: { organization: 'new-org' }, secretRefs: { token: formatSharedSavedSecretRefV1('held-key') } } } });
            expect(JSON.stringify(writes)).not.toContain('rotated-key');
        } else if (status === 'outcome_unknown') {
            await expect(owner.settle(request)).rejects.toThrow('connected_account_settlement_outcome_unknown');
            expect(await owner.reconcile(request)).toMatchObject({ status: 'unavailable' });
            expect(writes).toEqual([]);
        } else {
            expect(await owner.settle(request)).toEqual({ status: 'conflict', code: 'connected_account_settlement_conflict' });
            expect(writes).toEqual([]);
        }
        expect(rotations).toEqual([[{ resourceId: 'held-key', value: 'rotated-key' }]]);
    });
    it('stores a verified selected key as its reference, with the exact selected revision only on the write', async () => {
        type Mutation = Parameters<Parameters<typeof createConnectedAccountCredentialSettlement>[0]['mutateCredential']>[0];
        const writes: Mutation[] = [];
        const service = { pluginId: 'acme.cloud', localId: 'api' };
        const account = { service, accountId: 'selected' };
        const selection = { ref: formatSharedSavedSecretRefV1('held-key'), resourceRevision: 4 };
        const owner = createConnectedAccountCredentialSettlement({
            now: () => 1, resolveAccountMode: async () => 'plain',
            seal: (kind, _accountMode, payload) => sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode: 'plain', payload,
                randomBytes: length => new Uint8Array(length) }),
            open: (kind, _accountMode, envelope) => openQualifiedConnectedAccountContentEnvelope({ kind, accountMode: 'plain', envelope }),
            parseConfigurationContent: value => value,
            mutateCredentialHealth: async () => {},
            mutateCredential: async mutation => { writes.push(mutation); return { success: true,
                credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null }; },
            readCredential: async () => null, readConfiguration: async () => null,
            readHttpStatus: () => null, readFailureCode: () => null,
        });
        expect(await owner.settle({ intent: 'connect', service, accountId: account.accountId, authenticationModeId: 'api-key',
            expectedCredentialRevision: null, expectedCredentialConfigurationRevision: null, expectedConfigurationRevision: 'unconfigured',
            sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-1', installSource: 'archive' },
            stagedCredentials: { token: 'verified-selected-key' }, credentialSecretRefs: { token: selection },
            displayName: 'Cloud', scopes: [] })).toEqual({ status: 'connected', account });
        expect(writes).toHaveLength(1);
        const written = writes[0]!;
        expect(JSON.stringify(written)).not.toContain('verified-selected-key');
        expect(written).toMatchObject({ savedSecretResourceIds: ['held-key'], savedSecretRevisions: [{ resourceId: 'held-key', expectedRevision: 4 }] });
        const payload = parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: account, authenticationModeId: 'api-key',
            plaintext: openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', envelope: written.content }) });
        expect(payload).toEqual({ v: 1, values: {}, secretRefs: { token: selection.ref } });
    });
    it('promotes declared entered keys atomically and keeps only resource references in the credential', async () => {
        const writes: unknown[] = [];
        const promotions: Parameters<NonNullable<Parameters<typeof createConnectedAccountCredentialSettlement>[0]['promoteCredentialSecrets']>>[0][] = [];
        const service = { pluginId: 'acme.cloud', localId: 'api' };
        const account = { service, accountId: 'account-one' };
        const owner = createConnectedAccountCredentialSettlement({
            now: () => 1, resolveAccountMode: async () => 'plain',
            seal: (kind, _accountMode, payload) => sealQualifiedConnectedAccountContentEnvelope({ kind, accountMode: 'plain', payload,
                randomBytes: length => new Uint8Array(length) }),
            open: (kind, _accountMode, envelope) => openQualifiedConnectedAccountContentEnvelope({ kind, accountMode: 'plain', envelope }),
            parseConfigurationContent: value => value,
            mutateCredentialHealth: async () => {},
            mutateCredential: async mutation => { writes.push(mutation); throw new Error('raw_credential_write'); },
            promoteCredentialSecrets: async input => {
                promotions.push(input);
                return { status: 'applied' as const, credential: { success: true as const,
                    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null } };
            },
            readCredential: async () => null, readConfiguration: async () => null,
            readHttpStatus: () => null, readFailureCode: () => null,
        });
        expect(await owner.settle({ intent: 'connect', service, accountId: account.accountId, authenticationModeId: 'api-key',
            expectedCredentialRevision: null, expectedCredentialConfigurationRevision: null, expectedConfigurationRevision: 'unconfigured',
            sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-1', installSource: 'archive' },
            stagedCredentials: { token: 'entered-key', organization: 'org-one' },
            credentialSecretResources: { token: { resourceId: 'one-key', displayName: 'Cloud key' } },
            displayName: 'Cloud', scopes: [] })).toEqual({ status: 'connected', account });
        expect(writes).toEqual([]);
        expect(promotions).toHaveLength(1);
        const promotion = promotions[0]!;
        expect(promotion.secrets).toEqual([{ resourceId: 'one-key', displayName: 'Cloud key', kind: 'apiKey', value: 'entered-key' }]);
        expect(promotion.credential.savedSecretResourceIds).toEqual(['one-key']);
        expect(JSON.stringify(promotion.credential)).not.toContain('entered-key');
        const payload = parseQualifiedConnectedAccountCredentialPlaintextV1({ ref: account, authenticationModeId: 'api-key',
            plaintext: openQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain', envelope: promotion.credential.content }) });
        expect(payload).toEqual({ v: 1, values: { organization: 'org-one' },
            secretRefs: { token: formatSharedSavedSecretRefV1('one-key') } });
    });
});
