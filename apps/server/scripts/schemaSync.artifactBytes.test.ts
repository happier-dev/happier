import { describe, expect, it } from 'vitest';
import { generateMySqlSchemaFromPostgres } from './schemaSync';

describe('Artifact MySQL stored-byte mappings', () => {
    it('maps nullable private metadata and key envelopes to the same LongBlob storage contract', () => {
        const result = generateMySqlSchemaFromPostgres(`datasource db {
    provider = "postgresql"
    url = env("DATABASE_URL")
}

model Artifact {
    id String @id
    body Bytes
    provenance Bytes?
    provenanceDataEncryptionKey Bytes?
}

model ArtifactRevision {
    id String @id
    provenance Bytes?
}

model ArtifactKeyEnvelope {
    id String @id
    encryptedProvenanceDataKey Bytes?
}
`);
        for (const field of ['provenance', 'provenanceDataEncryptionKey', 'encryptedProvenanceDataKey']) {
            expect(result).toContain(`${field} Bytes? @db.LongBlob`);
        }
        expect(result).toContain('body Bytes @db.LongBlob');
        expect(result).not.toContain('@db.LongBlob?');
    });
});
