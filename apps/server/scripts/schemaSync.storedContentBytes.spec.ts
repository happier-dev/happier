import { describe, expect, it } from 'vitest';
import { generateMySqlSchemaFromPostgres, generateSqliteSchemaFromPostgres } from './schemaSync';

describe('stored-content dialect capacity', () => {
    const models = { Session: ['metadataBytes', 'agentStateBytes'], Machine: ['metadataBytes', 'daemonStateBytes'], SessionSystemRecord: ['contentBytes'], AutomationRun: ['resultEnvelopeBytes', 'workflowCheckpointEnvelopeBytes'], AccountSettingsSnapshot: ['settingsDbValueBytes'] };
    const source = 'datasource db {\n    provider = "postgresql"\n    url = env("DATABASE_URL")\n}\n' + Object.entries(models).map(([model, fields]) => `model ${model} {\n    id String @id\n${fields.map(field => `    ${field} Bytes?`).join('\n')}\n}`).join('\n');
    it('retains full encrypted document capacity in MySQL', () => {
        const schema = generateMySqlSchemaFromPostgres(source);
        for (const field of Object.values(models).flat()) expect(schema).toContain(`${field} Bytes? @db.LongBlob`);
    });
    it('uses native SQLite bytes without MySQL annotations', () => {
        const schema = generateSqliteSchemaFromPostgres(source);
        for (const field of Object.values(models).flat()) expect(schema).toContain(`${field} Bytes?`);
        expect(schema).not.toContain('@db.LongBlob');
    });
});
