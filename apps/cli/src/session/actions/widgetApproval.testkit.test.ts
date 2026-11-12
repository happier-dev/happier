import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol';

import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { QualifiedConnectedAccountCredentialHealthPatchV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';

import { registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';

describe('plain Artifact HTTP fixture', () => {
    it('returns the published filtered envelope for exact kinds without including unrelated rows', async () => {
        const app = Fastify();
        const artifacts = registerPlainArtifactRoutes(app, 'account-1');
        artifacts.seed('role', encodePlainArtifactStoredContent({ kind: 'role.v1' }), encodePlainArtifactStoredContent({}));
        artifacts.seed('prompt', encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2' }), encodePlainArtifactStoredContent({}));
        try {
            const exact = await app.inject({ method: 'GET', url: `/v1/artifacts?kinds=${encodeURIComponent(JSON.stringify(['role.v1']))}` });
            expect(exact.statusCode).toBe(200);
            expect(exact.json()).toMatchObject({ items: [{ id: 'role' }], hasUnclassified: false });
            expect(exact.json().items).toHaveLength(1);
            const absent = await app.inject({ method: 'GET', url: '/v1/artifacts?kinds=%5B%5D' });
            expect(absent.json()).toEqual({ items: [], hasUnclassified: false,
                coverage: { status: 'complete', unclassifiedCount: 0 } });
            const coarse = await app.inject({ method: 'GET', url: '/v1/artifacts?kind=prompt' });
            expect(coarse.json()).toMatchObject({ items: [{ id: 'prompt' }], hasUnclassified: false });
            const unfiltered = await app.inject({ method: 'GET', url: '/v1/artifacts' });
            expect(unfiltered.json()).toHaveLength(2);
        } finally {
            await app.close();
        }
    });
});

it('keeps fake Home credential-health publication strict and revision-fenced', async () => {
    const app = Fastify();
    let credential = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: { service: { pluginId: 'example.account', localId: 'service' }, accountId: 'older-account' },
        authenticationModeId: 'token', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: 'configuration-one',
        content: { t: 'plain', v: { v: 1, values: { token: 'synthetic-credential' } } }, metadata: { scopes: [], kind: 'token' },
    });
    const original = credential;
    registerAccountHomeHttp(app, { accountId: 'owner', serverId: 'home',
        qualifiedCredential: { read: () => credential, write: next => { credential = next; } } });
    const patch = QualifiedConnectedAccountCredentialHealthPatchV4Schema.parse({
        ref: credential.ref, expectedCredentialRevision: credential.credentialRevision,
        expectedConfigurationRevision: credential.configurationRevision,
        health: { v: 1, status: 'connected', reconnectRequired: false },
        exportProjection: { directExportContract: 'happier.team-credential-manual-connected-account-direct.v1',
            contributionContractVersion: 'current-declaration' },
    });
    const submit = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/v4/connect/qualified/credential/health', payload });
    try {
        expect((await submit({ ...patch, unexpected: true })).statusCode).toBe(400);
        expect((await submit({ ...patch, ref: { ...patch.ref, accountId: 'another-account' } })).statusCode).toBe(404);
        const staleCredential = await submit({ ...patch, expectedCredentialRevision: 'csr_123456789ABCDEFGHJKMNPQRST' });
        expect(staleCredential.statusCode).toBe(409);
        expect(staleCredential.json()).toMatchObject({ reason: 'credential_revision_mismatch' });
        const staleConfiguration = await submit({ ...patch, expectedConfigurationRevision: 'configuration-two' });
        expect(staleConfiguration.statusCode).toBe(409);
        expect(staleConfiguration.json()).toMatchObject({ reason: 'configuration_revision_mismatch' });
        expect(credential).toEqual(original);
        const published = await submit(patch);
        expect(published.statusCode).toBe(200);
        expect(QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(published.json())).toEqual({
            success: true, credentialRevision: original.credentialRevision, configurationRevision: original.configurationRevision,
        });
        expect(credential).toEqual({ ...original, health: patch.health, exportProjection: patch.exportProjection });
    } finally { await app.close(); }
});
