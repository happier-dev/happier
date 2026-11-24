import { expect, it } from 'vitest';
import { DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { SessionInputHandoffInputV1Schema, runSessionInputHandoffV1 } from '@happier-dev/plugin-sdk/sessions';
import { DatabaseTaskEvidenceV1Schema } from '@happier-dev/plugin-sdk/database';
import { createDatabaseBriefHandoffControl, createDatabaseMigrationHandoffControl } from './migration.js';
import { buildDatabaseFindingBriefV1 } from './brief.js';
import { DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { target } from './nativeFixture.testkit.js';

it('hands a scoped migration to the shared editable Session path without sending or applying it', async () => {
    const task = DatabaseTaskEvidenceV1Schema.parse({ kind: 'migration', target,
        sourceScope: { serverId: 'server', machineId: 'machine' }, engineId: 'sqlite' });
    if (task.kind !== 'migration') throw new Error('Expected migration task');
    const control = createDatabaseMigrationHandoffControl({ task: { ...task, kind: 'migration' },
        handoff: { v: 1, sessionChoice: { kind: 'existing', session: 'existing' }, delivery: 'compose' },
        idempotencyKey: () => 'person-press' });
    const signal = new AbortController().signal;
    const prepared = await control.controller.prepare({ signal });
    const handoff = SessionInputHandoffInputV1Schema.parse(prepared?.input);
    let drafted: unknown;
    const result = await runSessionInputHandoffV1(handoff, {
        async compose(session, input) { drafted = { session, input }; return { ok: true, result: 'composed' }; },
        async send() { throw new Error('A migration preview must not send a turn'); },
    }, { resolvedSession: { sessionId: 'existing', serverId: 'server' }, signal });
    expect(control.action).toBe('session.input.handoff');
    expect(result).toMatchObject({ kind: 'composed', destination: { kind: 'existing', session: { sessionId: 'existing' } } });
    expect(drafted).toMatchObject({ input: { forgeEvidence: { items: [{ source: { kind: 'databaseFinding' } }] } } });
    expect(handoff.input.attachments).toBeUndefined();
    expect(JSON.parse(handoff.input.forgeEvidence!.items[0]!.text)).toEqual({ task });
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await control.controller.prepare({ signal: cancelled.signal })).toBeNull();
});


it('preserves the production observation and exact scoped capture read in the editable handoff', async () => {
    const source = { kind: 'environment', serverId: 'home', environmentId: 'prod' } as const;
    const finding = {
        v: 1, sourceRef: { pluginId: 'happier.telemetry', localId: 'capture-findings' },
        sourceScope: { serverId: 'home', machineId: 'collector' }, evidenceIdentity: 'retained-query-finding',
        kind: 'suspected_n_plus_one', title: 'Suspected N+1 queries',
        observedWindow: { fromMs: 201, toMs: 238 }, coverage: { status: 'complete' },
        summary: { records: 1, calls: '5', totalTimeMs: 31 },
        verification: {
            observationKey: 'span:trace:root', httpStatusCode: 200,
            readBefore: { action: DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, input: { source, traceId: 'trace', page: { limit: 10 } } },
            findAfter: { action: DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1, input: { source, since: 238, page: { limit: 10 } } },
        },
    } as const;
    const control = createDatabaseBriefHandoffControl(() => buildDatabaseFindingBriefV1(finding), {
        handoff: { v: 1, sessionChoice: { kind: 'existing', session: 'existing' }, delivery: 'compose' },
        idempotencyKey: () => 'production-brief',
    });
    const signal = new AbortController().signal;
    const handoff = SessionInputHandoffInputV1Schema.parse((await control.controller.prepare({ signal }))?.input);
    let evidence: unknown;
    const result = await runSessionInputHandoffV1(handoff, {
        async compose(_session, input) {
            evidence = JSON.parse(input.forgeEvidence!.items[0]!.text);
            return { ok: true, result: 'composed' };
        },
        async send() { throw new Error('A finding handoff opens a draft before sending'); },
    }, { resolvedSession: { sessionId: 'existing', serverId: 'home' }, signal });

    expect(result.kind).toBe('composed');
    expect(evidence).toEqual({ currentDetail: finding, verification: finding.verification });
});

it('opens an editable collector-role recovery brief with the exact Environment and Machine evidence', async () => {
    const task = DatabaseTaskEvidenceV1Schema.parse({
        kind: 'collector_role_recovery',
        environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'prod' },
        sourceScope: { serverId: 'home', machineId: 'collector' },
        roleId: DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1,
    });
    const control = createDatabaseBriefHandoffControl(() => buildDatabaseFindingBriefV1(task), {
        handoff: { v: 1, sessionChoice: { kind: 'existing', session: 'existing' }, delivery: 'compose' },
        idempotencyKey: () => 'collector-role-recovery',
    });
    const signal = new AbortController().signal;
    const handoff = SessionInputHandoffInputV1Schema.parse((await control.controller.prepare({ signal }))?.input);
    let evidence: unknown;
    const result = await runSessionInputHandoffV1(handoff, {
        async compose(_session, input) {
            expect(input.text).toContain('Machine Roles');
            evidence = JSON.parse(input.forgeEvidence!.items[0]!.text);
            return { ok: true, result: 'composed' };
        },
        async send() { throw new Error('Role recovery starts in a reviewable draft'); },
    }, { resolvedSession: { sessionId: 'existing', serverId: 'home' }, signal });
    expect(result.kind).toBe('composed');
    expect(evidence).toEqual({ task });
});
