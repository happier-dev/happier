import { describe, expect, it } from 'vitest';
import { artifactSavedByFromActionContextV1, ArtifactBlobUploadInitV1Schema, ArtifactBodyEnvelopeV1Schema, ArtifactBodyEnvelopeV1StoredSchema } from './artifactBinaryV1';
import type { ActionCaller } from '../actions/executor/types.js';

describe('Artifact author attribution', () => {
    it('does not relabel automated host and Run authors as people', () => {
        const base = { runtimeAccountId: 'account-one', actionCaller: { kind: 'host' as const }, surface: 'cli' as const };
        expect(artifactSavedByFromActionContextV1({ ...base, authority: 'account_automation' }))
            .toEqual({ kind: 'agent', accountId: 'account-one' });
        const runs: ActionCaller[] = [
            { kind: 'workflowRun', runId: 'run-one', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } },
            { kind: 'automationRun', runId: 'run-one', automationId: 'automation-one', cause: { kind: 'manual', invokedAt: 1 } },
        ];
        for (const actionCaller of runs) {
            expect(artifactSavedByFromActionContextV1({ ...base, authority: 'present_user', actionCaller }))
                .toEqual({ kind: 'agent', accountId: 'account-one' });
        }
        expect(artifactSavedByFromActionContextV1({ ...base, authority: 'present_user' }))
            .toEqual({ kind: 'person', accountId: 'account-one' });
        expect(artifactSavedByFromActionContextV1({ ...base, surface: 'ui', authority: 'present_user',
            approvedActionReplay: { artifactId: 'approved-save', origin: { surface: 'agent', accountId: 'original-author',
                caller: { kind: 'session', sessionId: 'origin-session' } } } }))
            .toEqual({ kind: 'agent', accountId: 'original-author', sessionId: 'origin-session' });
        expect(artifactSavedByFromActionContextV1(base)).toBeUndefined();
    });
});

describe('Artifact body envelope read and write admission', () => {
    it('projects retained envelope and blob extensions without weakening canonical writes or known fields', () => {
        const reference = { blobId: '00000000-0000-4000-8000-000000000001', mime: 'image/png', sizeBytes: 4, sha256: 'a'.repeat(64) };
        const provenance = { savedBy: { kind: 'person', accountId: 'untrusted-actor' } };
        for (const body of ['Retained Board content', null, reference]) {
            const stored = { body: typeof body === 'object' && body !== null ? { ...body, extension: true } : body, provenance };
            const opened = ArtifactBodyEnvelopeV1StoredSchema.parse(stored);
            expect(opened).toEqual({ body });
            expect(ArtifactBodyEnvelopeV1Schema.safeParse(stored).success).toBe(false);
            expect(ArtifactBodyEnvelopeV1Schema.parse(opened)).toEqual({ body });
        }
        expect(ArtifactBodyEnvelopeV1Schema.safeParse({ body: { ...reference, extension: true } }).success).toBe(false);
        expect(ArtifactBodyEnvelopeV1StoredSchema.safeParse({ provenance }).success).toBe(false);
        expect(ArtifactBodyEnvelopeV1StoredSchema.safeParse({ body: { ...reference, sizeBytes: -1 }, provenance }).success).toBe(false);
    });
});

describe('Artifact upload destination identity', () => {
    it('admits a negotiated coarse kind on content writes while keeping conversion metadata closed', () => {
        const identity = { artifactId: '00000000-0000-4000-8000-000000000002',
            blobId: '00000000-0000-4000-8000-000000000001', t: 'plain', sizeBytes: 1 };
        for (const destination of [
            { kind: 'create', ...identity, header: 'header', body: 'body', dataEncryptionKey: 'key' },
            { kind: 'update', ...identity, header: 'header', expectedHeaderVersion: 1, body: 'body', expectedBodyVersion: 1 },
        ]) {
            expect(ArtifactBlobUploadInitV1Schema.parse({ ...destination, artifactKind: 'other' }))
                .toMatchObject({ artifactKind: 'other' });
            expect(ArtifactBlobUploadInitV1Schema.safeParse({ ...destination, artifactKind: 'unbounded-kind' }).success).toBe(false);
            expect(ArtifactBlobUploadInitV1Schema.safeParse({ ...destination, artifactKind: 'other', unknown: true }).success).toBe(false);
        }
        expect(ArtifactBlobUploadInitV1Schema.safeParse({ kind: 'encryption-conversion', ...identity, artifactKind: 'other' }).success).toBe(false);
    });

    it('uses the signed conversion UUID identity while preserving legacy update addresses', () => {
        const identity = { artifactId: 'legacy:document', blobId: '00000000-0000-4000-8000-000000000001', t: 'plain', sizeBytes: 1 };
        expect(ArtifactBlobUploadInitV1Schema.safeParse({ kind: 'encryption-conversion', ...identity }).success).toBe(false);
        expect(ArtifactBlobUploadInitV1Schema.safeParse({ kind: 'encryption-conversion', ...identity,
            artifactId: '00000000-0000-4000-8000-000000000002' }).success).toBe(true);
        expect(ArtifactBlobUploadInitV1Schema.safeParse({ kind: 'update', ...identity, body: 'body', expectedBodyVersion: 1 }).success).toBe(true);
        expect(ArtifactBlobUploadInitV1Schema.safeParse({ kind: 'update', ...identity, body: 'body', expectedBodyVersion: 1,
            provenance: 'private-metadata', provenanceDataEncryptionKey: null }).success).toBe(true);
    });
});
