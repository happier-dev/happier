import { expect, it } from 'vitest';
import { executePostgresqlOperation, type PostgresqlQuery } from '@happier-dev/databases/postgresql';
import { DatabaseFindingBriefBuildResultV1Schema, DatabaseFindingsListResultV1Schema, type DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
    DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
    DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
    DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1,
    DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1,
    DatabaseCaptureTraceGetResultV1Schema,
    databaseActionLocalIdV1,
} from '@happier-dev/database-protocol';
import { plugin } from '../manifest.js';
import { buildDatabaseFindingBriefV1 } from './brief.js';

it('keeps the selected committed trace and follow-up Action operands in the Session brief', () => {
    const source = { kind: 'environment', serverId: 'home', environmentId: 'production' } as const;
    const traceId = 'trace';
    const page = { limit: 10 };
    const verification = {
        observationKey: 'request',
        httpStatusCode: 503,
        readBefore: { action: DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, input: { source, traceId, page } },
        findAfter: { action: DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, input: { source, since: 140, page } },
    };
    const result = DatabaseCaptureTraceGetResultV1Schema.parse({
        ok: true, source, traceId, summaries: [], repeatedQueries: [], slowChildSpans: [], logCorrelations: [],
        findings: [{ v: 1, sourceRef: { pluginId: 'happier.telemetry', localId: 'capture-findings' },
            sourceScope: { serverId: 'home', machineId: 'collector' }, evidenceIdentity: 'observation',
            kind: 'failing_endpoint', title: 'Endpoint request failed', observedWindow: { fromMs: 100, toMs: 140 },
            coverage: { status: 'partial', reasons: ['partial_observation'] }, summary: { records: 1, totalTimeMs: 40 },
            environmentObservation: { shapeKey: 'checkout-failure', reportedService: { kind: 'workload_reported', name: 'checkout' } },
            exercise: 'Repeat the selected application request', verification }],
    });
    if (!result.ok || !result.findings?.[0]) throw new Error('Expected collector finding');
    const finding = result.findings[0];
    const brief = buildDatabaseFindingBriefV1(finding);
    expect(brief.text).toContain(finding.exercise);
    expect(brief.text).toContain(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1);
    expect(brief.text).toContain(DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1);
    expect(JSON.parse(brief.evidence.items[0].text)).toMatchObject({ currentDetail: finding, verification });
});

it('previews the selected native managed database finding through the Workbench Action', async () => {
    const target = { kind: 'managed_deployment', environment: { serverId: 'home', environmentId: 'production', projectSourceId: 'project' },
        targetLinkId: 'link', contribution: { pluginId: 'fixture.database', contributionId: 'postgres' },
        platformProjectId: 'project', branchId: 'branch', database: 'billing' } as const;
    const descriptor: DatabaseDescriptorV1 = { target, engine: 'postgresql', label: 'Billing',
        origin: { label: 'Managed' }, capabilities: [], placement: { serverId: 'home', accountId: 'account',
            machineId: 'machine', installationId: 'installation' } };
    const relation = { schema: 'public', name: 'invoices' };
    const basis = { bindingKey: 'managed-link', databaseIdentity: 'billing', selectionKey: 'fixture' };
    const query: PostgresqlQuery = async statement => {
        // The native provider boundary returns real PostgreSQL stats aliases.
        const names = ['key', 'schema_name', 'relation_name', 'live_rows', 'size_bytes'];
        const rows = [['1', 'public', 'invoices', '10', '4096'], ['2', 'public', 'receipts', '6', '2048']];
        const selected = statement.values.length === 2 ? rows.filter(row => row[2] === statement.values[1]) : rows;
        return { fields: names.map(name => ({ name, dataTypeID: 25 })), rows: selected, command: 'SELECT', rowCount: selected.length };
    };
    const unexpected = async (): Promise<never> => { throw new Error('The selected preview must use the existing read connection'); };
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: {
        deploymentDatabases: {
            listTargets: unexpected, admit: unexpected, attachReadAccess: unexpected, createReadAccess: unexpected,
            async resolve(input, access) {
                expect(input.target).toEqual(target);
                expect(access).toBe('read');
                return { descriptor, connection: { engine: 'postgresql', execute: input => executePostgresqlOperation(input, query, {
                    stats: { database: target.database, intervalBasis: basis },
                }), close: async () => {} } };
            },
        },
    } });
    const invocation = { chosenMachine: { machineId: 'machine', installationId: 'installation' } };
    try {
        const list = DatabaseFindingsListResultV1Schema.parse(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_INSIGHTS_FINDINGS_LIST_ACTION_ID_V1),
            { target, request: { kind: 'stats.read', group: 'tables', selection: { schema: relation.schema, page: { rows: 20 } } } }, invocation));
        if (!list.ok) throw new Error(list.code);
        expect(list.findings).toHaveLength(2);
        const selected = list.findings.find(finding => finding.object?.kind === 'table' && finding.object.relation.name === relation.name);
        if (!selected) throw new Error('Expected the managed invoices finding');
        const request = { kind: 'stats.read', group: 'tables', selection: { relation } };
        const result = DatabaseFindingBriefBuildResultV1Schema.parse(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1),
            { target, request, recordKey: selected.recordKey }, invocation));
        if (!result.ok) throw new Error(result.code);
        expect(JSON.parse(result.brief.evidence.items[0]!.text)).toMatchObject({
            baseline: { summary: { records: 1, size: { bytes: '4096' } } },
            currentDetail: { target, object: { kind: 'table', relation }, verification: { read: request, basis } },
        });
    } finally {
        await kit.dispose();
    }
});
