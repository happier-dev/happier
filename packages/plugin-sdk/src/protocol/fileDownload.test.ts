import { describe, expect, expectTypeOf, it } from 'vitest';
import { FileDownloadDestinationV1ProtocolSchema as canonicalDestination, FileDownloadResultV1ProtocolSchema as canonicalResult, FilesystemDownloadInputSchema, FilesystemDownloadOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { ScmHostingRepositoryIdentityV1ProtocolSchema as canonicalRepository, ScmHostingRepositoryIdentityV1Schema } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

import {
    defineProtocolObject,
    FileDownloadDestinationV1ProtocolSchema,
    FileDownloadResultV1ProtocolSchema,
    ScmHostingRepositoryIdentityV1ProtocolSchema,
    type FileDownloadDestinationV1,
    type FileDownloadResultV1,
} from './index.js';

describe('canonical host values embedded in feature protocols', () => {
    it('composes receiver destinations and repository identities without accepting path or URL authority', () => {
        expect(FileDownloadDestinationV1ProtocolSchema).toBe(canonicalDestination);
        expect(ScmHostingRepositoryIdentityV1ProtocolSchema).toBe(canonicalRepository);
        const input = defineProtocolObject({
            destination: FileDownloadDestinationV1ProtocolSchema,
            repository: ScmHostingRepositoryIdentityV1ProtocolSchema,
        }, { policy: 'closed' });
        const destination = { destinationId: 'receiver-destination' } satisfies FileDownloadDestinationV1;
        const repository = { kind: 'github', deployment: 'https://github.com', repository: 'owner/repository' } as const;
        expect(input.parse({ destination, repository })).toEqual({ destination, repository });
        expect(ScmHostingRepositoryIdentityV1ProtocolSchema.parse(repository))
            .toEqual(ScmHostingRepositoryIdentityV1Schema.parse(repository));
        for (const invalid of [{ path: '/tmp/output' }, { url: 'https://example.test/file' }, { ...destination, path: '/tmp/output' }]) {
            expect(input.safeParse({ destination: invalid, repository }).success).toBe(false);
            expect(FilesystemDownloadInputSchema.safeParse({ rootPath: '/repo', path: 'file', destination: invalid, asZip: false }).success).toBe(false);
        }
        expect(input.safeParse({ destination, repository: { ...repository, unexpected: true } }).success).toBe(false);
        expect(input.safeParse({ destination, repository: { ...repository, deployment: 'https://user:secret@example.test' } }).success).toBe(false);
        const validate = compilePluginJsonSchema(input.jsonSchema);
        expect(validate({ destination, repository })).toBe(true);
        expect(validate({ destination: { ...destination, path: '/tmp/output' }, repository })).toBe(false);
    });

    it('composes the canonical result union without interpreting accepted as completed', () => {
        expect(FileDownloadResultV1ProtocolSchema).toBe(canonicalResult);
        const result = defineProtocolObject({ download: FileDownloadResultV1ProtocolSchema }, { policy: 'closed' });
        const completed = {
            success: true, status: 'completed', transferId: 'transfer', destinationId: 'destination',
            name: 'output.zip', sizeBytes: 3, sha256: 'a'.repeat(64),
        } satisfies FileDownloadResultV1;
        const accepted = {
            success: true, status: 'accepted', operationId: 'operation', destinationId: 'destination',
            prepared: { transferId: 'transfer', name: 'output.zip', sizeBytes: 3, manifestHash: `sha256:${'a'.repeat(64)}`, expiresAt: 1, endpointCandidates: [] },
        } satisfies FileDownloadResultV1;
        for (const value of [completed, accepted, ...(['failed', 'cancelled', 'unknown'] as const).map(status => ({ success: false as const, status, error: 'unavailable' }))]) {
            expect(result.parse({ download: value }).download).toEqual(FilesystemDownloadOutputSchema.parse(value));
        }
        expect(result.safeParse({ download: { ...accepted, status: 'completed' } }).success).toBe(false);
        expect(result.safeParse({ download: { ...completed, url: 'https://example.test/file' } }).success).toBe(false);
        expect(FileDownloadResultV1ProtocolSchema.optional().parse(undefined)).toBeUndefined();
        expect(FileDownloadDestinationV1ProtocolSchema.nullable().parse(null)).toBeNull();
        expectTypeOf(FileDownloadDestinationV1ProtocolSchema.parse({ destinationId: 'destination' })).toEqualTypeOf<FileDownloadDestinationV1>();
    });
});
