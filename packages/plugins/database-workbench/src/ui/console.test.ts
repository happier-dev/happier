import { expect, it } from 'vitest';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { createConsole, type WorkbenchConsoleHost } from './console.js';
import { createConsoleState } from './consoleState.js';

const descriptor = createDatabaseDescriptorV1Fixture();

it('prepares current SQL only when the host control asks and keeps parameters out of history', async () => {
    const text = createConsoleState({ read: async () => null, write: async () => {} });
    let dispatched = 0;
    const client = { commit: async () => { dispatched++; return { ok: true as const, operation: 'statement.run' as const, results: [] }; },
        presentDeviceStorageError: (error: unknown) => { throw error; } };
    const host: WorkbenchConsoleHost = { consoleState: () => text, target: () => descriptor,
        statementRanges: sql => [{ start: 0, end: sql.length }], client };
    const console = createConsole(host, 'target');
    await console.setText('select $1');
    console.setParameters([[{ type: 'text', value: 'private parameter' }]]);
    const binding = console.run();
    expect(dispatched).toBe(0);
    const preparation = await binding.controller.prepare({ signal: new AbortController().signal });
    expect(preparation?.input).toMatchObject({ operation: 'statement.run', mode: 'read', statement: {
        sql: 'select $1', parameters: [{ type: 'text', value: 'private parameter' }] } });
    binding.controller.onSettled({ ok: true, result: { ok: true, operation: 'statement.run', results: [] } });
    expect(console.execution.get('run').running).toBe(false);
    expect(text.get().history).toEqual([{ sql: 'select $1' }]);
});

it('explains the caret statement with read access and projects Unicode engine positions into the original document', async () => {
    const sql = 'select 1;\r\nselect 😀;';
    const start = sql.indexOf('select 😀');
    const text = createConsoleState({ read: async () => null, write: async () => {} });
    const client = { commit: async () => { throw new Error('Only the host control may execute'); },
        presentDeviceStorageError(error: unknown) { throw error; } };
    const console = createConsole({ consoleState: () => text, target: () => descriptor, client,
        statementRanges: () => [{ start: 0, end: start - 2 }, { start, end: sql.length }] }, 'target');
    await console.setText(sql);
    console.setMode('write');
    console.setSelection({ start: sql.length, end: sql.length });
    const binding = console.explain('analyze');
    const prepared = await binding.controller.prepare({ signal: new AbortController().signal });
    expect(prepared?.input).toMatchObject({ operation: 'statement.explain', accessMode: 'read', mode: 'analyze', statement: { sql: 'select 😀;' } });
    binding.controller.onSettled({ ok: true, result: { ok: false, status: 'failed', code: 'syntax_error',
        cause: { source: 'engine', code: '42601', message: 'Positioned error', position: 8 } } });
    expect(console.execution.get('run').error).toMatchObject({ range: { start: start + 7, end: start + 9 },
        positionedIn: sql, statementRange: { start, end: sql.length } });
    expect(text.get().history).toEqual([]);
});

it('keeps the typed phase and request of a failed mounted Console write without claiming rollback', async () => {
    const text = createConsoleState({ read: async () => null, write: async () => {} });
    const console = createConsole({ consoleState: () => text, target: () => descriptor,
        statementRanges: sql => [{ start: 0, end: sql.length }],
        client: { presentDeviceStorageError(error) { throw error; } } }, 'target');
    await console.setText('update selected set flag = 1');
    console.setMode('write');
    const binding = console.run();
    await binding.controller.prepare({ signal: new AbortController().signal });
    binding.controller.onSettled({ ok: false, errorCode: 'action_outcome_unknown', error: 'The Machine lost the receipt.',
        requestId: 'console-receipt', effectAttempted: true, details: { layer: 'transport', phase: 'settlement' } });
    expect(console.execution.get('run')).toMatchObject({ running: false, error: {
        code: 'action_outcome_unknown', message: 'The Machine lost the receipt.',
        requestId: 'console-receipt', phase: 'settlement', outcomeUnknown: true,
    } });
    expect(text.get().history).toEqual([]);
});

it('keeps the native write outcome unknown when the driver loses the COMMIT acknowledgement', async () => {
    const text = createConsoleState({ read: async () => null, write: async () => {} });
    const console = createConsole({ consoleState: () => text, target: () => descriptor,
        statementRanges: sql => [{ start: 0, end: sql.length }],
        client: { presentDeviceStorageError(error) { throw error; } } }, 'target');
    await console.setText('update selected set flag = 1');
    console.setMode('write');
    const binding = console.run();
    await binding.controller.prepare({ signal: new AbortController().signal });
    const result = { ok: false as const, status: 'outcome_unknown', code: 'database_outcome_unknown',
        cause: { source: 'transport', code: 'ECONNRESET', message: 'Connection reset during COMMIT' } };
    binding.controller.onSettled({ ok: true, result });
    expect(console.execution.get('run')).toMatchObject({ running: false, result, error: {
        code: 'database_outcome_unknown', outcomeUnknown: true,
    } });
    expect(text.get().history).toEqual([]);
});

it('stops the exact host control signal and leaves the same console ready for another deliberate run', async () => {
    const text = createConsoleState({ read: async () => null, write: async () => {} });
    const console = createConsole({ consoleState: () => text, target: () => descriptor,
        statementRanges: sql => [{ start: 0, end: sql.length }],
        client: { presentDeviceStorageError(error) { throw error; } } }, 'target');
    await console.setText('select 1');
    const binding = console.run();
    await binding.controller.prepare({ signal: new AbortController().signal });
    const signal: unknown = Reflect.get(binding, 'signal');
    expect(signal).toBeInstanceOf(AbortSignal);
    if (!(signal instanceof AbortSignal)) throw new Error('The host Action control needs its existing cancellation signal');
    await console.cancel();
    expect(signal.aborted).toBe(true);
    binding.controller.onSettled({ ok: false, errorCode: 'aborted', error: 'Stopped' });
    expect(console.run()).toBe(binding);
    const next: unknown = Reflect.get(binding, 'signal');
    expect(next).toBeInstanceOf(AbortSignal);
    expect(next).not.toBe(signal);
    if (!(next instanceof AbortSignal)) throw new Error('The next deliberate Run needs its own signal');
    expect(next.aborted).toBe(false);
    expect(await binding.controller.prepare({ signal: next })).toMatchObject({ input: { statement: { sql: 'select 1' } } });
});

it('publishes typed parameter inputs locally and submits them without persisting values', async () => {
    const writes: unknown[] = [];
    const text = createConsoleState({ read: async () => null, write: async value => { writes.push(value); } });
    const console = createConsole({ consoleState: () => text, target: () => descriptor,
        statementRanges: sql => [{ start: 0, end: sql.length }], client: { presentDeviceStorageError(error) { throw error; } } }, 'target');
    await console.setText('select $1, $2');
    console.setParameterInputs([[{ type: 'integer', text: 'invalid private value' }]]);
    expect(await console.run().controller.prepare({ signal: new AbortController().signal })).toBeNull();
    expect(console.execution.get('run').error).toEqual({ code: 'invalid_parameters', message: 'A parameter does not match its selected type.' });
    expect(JSON.stringify(console.execution.get('run'))).not.toContain('invalid private value');
    console.setParameterInputs([[{ type: 'integer', text: '9007199254740993' }, { type: 'text', text: 'secret parameter' }]]);
    expect(console.parameterInputs.get('parameters')[0]?.[0]).toEqual({ type: 'integer', text: '9007199254740993' });
    const binding = console.run();
    expect(await binding.controller.prepare({ signal: new AbortController().signal })).toMatchObject({ input: { statement: { parameters: [
        { type: 'integer', value: '9007199254740993' }, { type: 'text', value: 'secret parameter' }] } } });
    binding.controller.onSettled({ ok: true, result: { ok: true, operation: 'statement.run', results: [] } });
    expect(JSON.stringify(writes)).not.toContain('secret parameter');
    expect(JSON.stringify(text.get())).not.toContain('9007199254740993');
    console.close();
    expect(console.parameterInputs.get('parameters')).toEqual([]);
});
