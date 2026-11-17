import { describe, expect, it } from 'vitest';
import * as capture from './databaseCapture.js';

const source = { kind: 'worktree', serverId: 'home', machineId: 'machine', projectId: 'project', workspaceId: 'workspace' };

describe('canonical capture transport', () => {
    it('admits explicit source/page operands and rejects caller-supplied partition and authority', () => {
        const input = { source, page: { limit: 2, before: { at: 10, id: 'query' } }, since: 0 };
        expect(capture.DatabaseCaptureQueriesListInputV1ProtocolSchema.parse(input)).toEqual(input);
        expect(capture.DatabaseCaptureQueriesListInputV1Schema.safeParse({ ...input, worktree: 'another-account' }).success).toBe(false);
        expect(capture.DatabaseCaptureQueriesListInputV1Schema.safeParse({ ...input, source: { ...source, accountId: 'another-account' } }).success).toBe(false);
        expect(capture.DatabaseCaptureQueriesListInputV1Schema.safeParse({ ...input, page: { limit: 0 } }).success).toBe(false);
        expect(capture.DatabaseCaptureStatusInputV1Schema.parse({ source: { kind: 'environment', serverId: 'home', environmentId: 'environment' } }))
            .toEqual({ source: { kind: 'environment', serverId: 'home', environmentId: 'environment' } });
    });

    it('carries summary metadata without admitting demanded SQL/parameter/log bodies in list results', () => {
        const result = { ok: true, source, items: [{ id: 'query', worktree: 'selected', kind: 'query', source: 'wire', at: 1,
            shape: 'select ?', durationMs: 2, statementKind: 'select', executionIdentity: 'execution' }], nextCursor: { at: 1, id: 'query' } };
        expect(capture.DatabaseCaptureQueriesListResultV1ProtocolSchema.parse(result)).toEqual(result);
        expect(capture.DatabaseCaptureQueriesListResultV1Schema.safeParse({ ...result, items: [{ ...result.items[0], detail: { parameters: ['private'] } }] }).success).toBe(false);
        expect(capture.DatabaseCaptureQueryGetResultV1ProtocolSchema.parse({ ok: true, source, detail: { sql: 'select ?', parameters: [{ ordinal: 1, format: 'text', value: '[REDACTED]' }] } }))
            .toEqual({ ok: true, source, detail: { sql: 'select ?', parameters: [{ ordinal: 1, format: 'text', value: '[REDACTED]' }] } });
        expect(capture.DatabaseCaptureQueryGetResultV1ProtocolSchema.parse({ ok: true, source, detail: null })).toEqual({ ok: true, source, detail: null });
    });

    it('uses the same strict demanded read operands and results for Resource views', () => {
        const demand = { view: 'logs', input: { source, page: { limit: 1 }, serviceName: '', severityNumber: 0 } };
        expect(capture.DatabaseCaptureResourceInputV1ProtocolSchema.parse(demand)).toEqual(demand);
        expect(capture.DatabaseCaptureResourceInputV1Schema.safeParse({ view: 'queries', input: { source, page: { limit: 0 } } }).success).toBe(false);
        expect(capture.DatabaseCaptureResourceSnapshotV1ProtocolSchema.parse({ view: 'query', result: { ok: true, source, detail: { value: 'masked' } } }))
            .toEqual({ view: 'query', result: { ok: true, source, detail: { value: 'masked' } } });
    });

    it('preserves endpoint and request evidence and keeps configuration scoped to a project', () => {
        const endpoints = { ok: true, source, items: [{ serviceName: 'api', method: 'GET', route: '/users/:id', requestCount: 2,
            errorCount: 1, errorRate: 0.5, totalDurationMs: 10, databaseTimeMs: 3 }] };
        expect(capture.DatabaseCaptureEndpointsListResultV1ProtocolSchema.parse(endpoints)).toEqual(endpoints);
        expect(capture.DatabaseCaptureConfigureInputV1Schema.parse({ project: { serverId: 'home', machineId: 'machine', projectId: 'project' }, enabled: false }))
            .toEqual({ project: { serverId: 'home', machineId: 'machine', projectId: 'project' }, enabled: false });
        expect(capture.DatabaseCaptureConfigureInputV1Schema.safeParse({ source, enabled: false }).success).toBe(false);
    });
});
