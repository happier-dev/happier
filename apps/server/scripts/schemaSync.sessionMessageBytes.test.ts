import { describe, expect, it } from 'vitest';
import { generateMySqlSchemaFromPostgres } from './schemaSync';

describe('SessionMessage MySQL ciphertext storage', () => {
    it('preserves the existing JSON message capacity for raw ciphertext', () => {
        const schema = generateMySqlSchemaFromPostgres(`datasource db {
    provider = "postgresql"
    url = env("DATABASE_URL")
}

model SessionMessage {
    id String @id
    content Json
    contentBytes Bytes?
}
`);
        expect(schema).toContain('contentBytes Bytes? @db.LongBlob');
    });
});
