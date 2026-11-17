import { expect, it } from 'vitest';
import { SessionInputHandoffInputV1Schema, runSessionInputHandoffV1 } from '@happier-dev/plugin-sdk/sessions';
import { DatabaseTaskEvidenceV1Schema } from '@happier-dev/database-protocol';
import { createDatabaseMigrationHandoffControl } from './migration.js';
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
