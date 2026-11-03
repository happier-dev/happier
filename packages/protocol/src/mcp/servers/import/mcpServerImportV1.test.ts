import { describe, expect, it } from 'vitest';
import { McpServerCatalogEntryV1Schema } from '../settingsV1.js';
import { parseMcpServerImportV1 } from './parseMcpServerImportV1.js';
import { materializeMcpServerImportV1, prepareMcpServerImportV1, prepareDetectedMcpServerImportV1,
    McpImportPreviewV1Schema, McpImportCommitV1Schema, McpImportValueChoiceV1Schema } from './mcpServerImportV1.js';

const parsed = parseMcpServerImportV1(JSON.stringify({ servers: { one: { command: 'tool', env: { API_KEY: 'private-token', MODE: 'read' } } } }));
const base = { parsed, catalog: { servers: [] }, nowMs: 10, newId: () => 'server-1',
    createSecret: async () => { throw new Error('unexpected secret write'); } };
describe('MCP import preparation', () => {
    it('admits create and save choices without imposing create-only cross-field checks on save metadata', () => {
        const create = { t: 'createSecret', name: 'Imported credential', value: 'private-token' };
        const save = { t: 'saveSecret', name: 'Imported credential' };
        expect(McpImportValueChoiceV1Schema.parse(create)).toEqual(create);
        expect(McpImportValueChoiceV1Schema.parse(save)).toEqual(save);
        expect(McpImportValueChoiceV1Schema.safeParse({ ...save, value: 'unexpected' }).success).toBe(false);
        expect(McpImportValueChoiceV1Schema.safeParse({ ...create, unexpected: true }).success).toBe(false);
    });
    it('exposes the inferred transport in the strict preview and commits a revised explicit choice', async () => {
        const config = { mcpServers: { one: { url: 'https://mcp.example.test/sse' } } };
        const initial = parseMcpServerImportV1(JSON.stringify(config));
        expect(McpImportPreviewV1Schema.parse(prepareMcpServerImportV1({ ...base, parsed: initial })).servers)
            .toEqual([{ name: 'one', transport: 'http', envNames: [], headerNames: [] }]);
        const revised = parseMcpServerImportV1(JSON.stringify({ mcpServers: {
            one: { ...config.mcpServers.one, transport: 'sse' },
        } }));
        const result = await materializeMcpServerImportV1({ ...base, parsed: revised });
        expect(result.ok && McpServerCatalogEntryV1Schema.parse(result.entries[0])).toMatchObject({
            transport: 'sse', remote: { url: config.mcpServers.one.url },
        });
    });
    it('refuses all unresolved values before any persistent write and keeps literal secrets out of preview', async () => {
        const preview = prepareMcpServerImportV1(base);
        expect(McpImportPreviewV1Schema.parse(preview)).toEqual(preview);
        expect(preview.missingValues.map(input => input.inputId)).toEqual(['one:env:API_KEY', 'one:env:MODE']);
        expect(JSON.stringify(preview)).not.toContain('private-token');
        expect(await materializeMcpServerImportV1(base)).toMatchObject({ ok: false, code: 'missing_values' });
        expect(await materializeMcpServerImportV1({ ...base, values: { 'one:env:API_KEY': { t: 'createSecret', name: 'Key', value: 'token' } } }))
            .toMatchObject({ ok: false, code: 'missing_values' });
    });

    it('accepts explicit machine and literal choices and produces the exact current entry schema', async () => {
        const result = await materializeMcpServerImportV1({ ...base, values: {
            'one:env:API_KEY': { t: 'literal', v: '${API_KEY}' }, 'one:env:MODE': { t: 'literal', v: 'read' },
        } });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(McpImportCommitV1Schema.parse({ ok: true, revision: 1, serverIds: result.entries.map(entry => entry.id),
            duplicates: result.duplicates, movedSecrets: result.movedSecrets })).toMatchObject({ serverIds: ['server-1'] });
        expect(McpServerCatalogEntryV1Schema.parse(result.entries[0]).env).toEqual({ API_KEY: { t: 'literal', v: '${API_KEY}' }, MODE: { t: 'literal', v: 'read' } });
    });

    it('migrates admitted literal secrets through the canonical returned ref, with shared input reuse in templates', async () => {
        const writes: unknown[] = [];
        const imported = parseMcpServerImportV1(JSON.stringify({ servers: {
            one: { url: 'https://mcp.example.test', headers: { Authorization: 'Bearer ${input:token}' } },
            two: { command: 'tool', env: { API_KEY: '${input:token}' } },
        }, inputs: [{ id: 'token', password: true }] }));
        let id = 0;
        const result = await materializeMcpServerImportV1({ ...base, parsed: imported, newId: () => `server-${++id}`,
            values: { token: { t: 'createSecret', name: 'Key', value: 'private-token' } },
            createSecret: async input => { writes.push(input); return { secretId: 'resource-id', secretRef: 'canonical-private-ref' }; } });
        expect(writes).toEqual([{ name: 'Key', value: 'private-token' }]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.entries[0]?.remote?.headers.Authorization).toEqual({ t: 'template', template: 'Bearer {token}', vars: { token: { t: 'savedSecret', secretId: 'canonical-private-ref' } } });
        expect(result.entries[1]?.env.API_KEY).toEqual({ t: 'savedSecret', secretId: 'canonical-private-ref' });
        expect(JSON.stringify(result)).not.toContain('private-token');
        const literal = await materializeMcpServerImportV1({ ...base, values: { 'one:env:API_KEY': { t: 'saveSecret', name: 'Imported key' },
            'one:env:MODE': { t: 'literal', v: 'read' } }, createSecret: async input => {
                expect(input.value).toBe('private-token'); return { secretId: 'different-id', secretRef: 'saved-ref' };
            } });
        expect(literal.ok && literal.entries[0]?.env.API_KEY).toEqual({ t: 'savedSecret', secretId: 'saved-ref' });
    });

    it('skips normalized duplicates before requiring their values and leaves different arguments distinct', async () => {
        const source = parseMcpServerImportV1(JSON.stringify({ servers: {
            one: { url: 'https://MCP.example.test:443', headers: { Authorization: 'private-token' } },
            two: { url: 'https://mcp.example.test/' },
            three: { command: 'tool', args: ['one'] }, four: { command: 'tool', args: ['two'] },
        } }));
        const catalog = { servers: [McpServerCatalogEntryV1Schema.parse({ id: 'existing', name: 'existing', transport: 'http', remote: { url: 'https://mcp.example.test/', headers: {} }, env: {}, createdAt: 0, updatedAt: 0 })] };
        const result = await materializeMcpServerImportV1({ ...base, parsed: source, catalog });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.duplicates).toEqual([{ name: 'one', serverId: 'existing' }, { name: 'two', serverId: 'existing' }]);
        expect(result.entries.map(entry => entry.name)).toEqual(['three', 'four']);
    });

    it('keeps a relative executable distinct from a PATH lookup with the same basename', async () => {
        const source = parseMcpServerImportV1(JSON.stringify({ servers: { relative: { command: './tool' }, path: { command: 'tool' } } }));
        const result = await materializeMcpServerImportV1({ ...base, parsed: source });
        expect(result.ok && result.entries.map(entry => entry.name)).toEqual(['relative', 'path']);
    });

    it('rejects unsafe remote addresses and invalid env names before creating secrets', async () => {
        const invalid = parseMcpServerImportV1(JSON.stringify({ servers: { one: { url: 'https://user:password@mcp.example.test', env: { API_KEY: 'token' } } } }));
        expect(await materializeMcpServerImportV1({ ...base, parsed: invalid, values: { 'one:env:API_KEY': { t: 'saveSecret', name: 'Key' } } })).toMatchObject({ ok: false, code: 'invalid_import' });
    });

    it('Found requires both headers and env values, and records the real machine/Agent origin', async () => {
        const found = prepareDetectedMcpServerImportV1([{ provider: 'custom-agent', name: 'one', transport: 'http',
            remote: { url: 'https://mcp.example.test', headers: ['Authorization'] }, envKeys: ['API_KEY'], enabled: true,
            source: { kind: 'user', path: 'C:\\config.json' } }], 'machine-1');
        expect(await materializeMcpServerImportV1({ ...base, parsed: found })).toMatchObject({ ok: false, missingValues: [
            { inputId: 'one:header:Authorization' }, { inputId: 'one:env:API_KEY' },
        ] });
        const result = await materializeMcpServerImportV1({ ...base, parsed: found, values: {
            'one:header:Authorization': { t: 'savedSecret', secretId: 'canonical-ref' }, 'one:env:API_KEY': { t: 'literal', v: '${API_KEY}' },
        } });
        expect(result.ok && result.entries[0]?.origin).toEqual({ kind: 'machine', machineId: 'machine-1', agentId: 'custom-agent' });
    });

    it('preserves acknowledged secret refs when a later secret creation fails so a retry can reuse them', async () => {
        const source = parseMcpServerImportV1(JSON.stringify({ servers: { one: { command: 'tool', env: { API_KEY: 'key', API_SECRET: 'secret' } } } }));
        let writes = 0;
        const result = await materializeMcpServerImportV1({ ...base, parsed: source, values: {
            'one:env:API_KEY': { t: 'saveSecret', name: 'Key' }, 'one:env:API_SECRET': { t: 'saveSecret', name: 'Secret' },
        }, createSecret: async () => {
            if (++writes === 1) return { secretId: 'resource-id', secretRef: 'acknowledged-ref' };
            throw Object.assign(new Error('private failure detail'), { code: 'scope-retired' });
        } }).catch(() => ({ ok: false, code: 'unprojected-failure' }));
        expect(result).toMatchObject({ ok: false, code: 'secret_creation_failed',
            movedSecrets: [{ inputId: 'one:env:API_KEY', secretId: 'resource-id', secretRef: 'acknowledged-ref' }] });
    });
});
