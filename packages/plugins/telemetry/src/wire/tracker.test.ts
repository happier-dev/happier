import { describe, expect, it } from 'vitest';
import { PostgresWireTracker, type WireObservation } from './tracker';

export function frame(tag: string, body: Buffer | string = ''): Buffer {
    const payload = typeof body === 'string' ? Buffer.from(body) : body;
    const header = Buffer.alloc(5);
    header.write(tag); header.writeInt32BE(payload.length + 4, 1);
    return Buffer.concat([header, payload]);
}
export function startup(): Buffer {
    const data = Buffer.alloc(8); data.writeInt32BE(8); data.writeInt32BE(196608, 4); return data;
}
function int16(value: number): Buffer { const data = Buffer.alloc(2); data.writeUInt16BE(value); return data; }
function int32(value: number): Buffer { const data = Buffer.alloc(4); data.writeInt32BE(value); return data; }
function ready(status = 'I'): Buffer { return frame('Z', status); }
function connected(observations: WireObservation[], coverage: string[] = []): PostgresWireTracker {
    const tracker = new PostgresWireTracker({ connectionId: 'connection', onObservation: item => observations.push(item), onCoverage: item => coverage.push(item.reason) });
    tracker.frontend(startup()); tracker.backend(ready()); return tracker;
}

describe('PostgresWireTracker', () => {
    it('tracks fragmented multi-statement results, transaction ordering and errors without retaining row/auth values', () => {
        const observations: WireObservation[] = [];
        const tracker = connected(observations);
        tracker.frontend(frame('p', 'authentication-secret\0'));
        for (const byte of frame('Q', 'BEGIN; SELECT 42; SELECT broken\0')) tracker.frontend(Buffer.from([byte]));
        const responses = Buffer.concat([frame('C', 'BEGIN\0'), frame('D', 'result-secret'), frame('C', 'SELECT 1\0'), frame('E', 'SERROR\0C42703\0Mmissing secret-value\0P25\0\0'), ready('E')]);
        for (const byte of responses) tracker.backend(Buffer.from([byte]));
        tracker.frontend(frame('Q', 'ROLLBACK\0')); tracker.backend(Buffer.concat([frame('C', 'ROLLBACK\0'), ready()]));
        const executions = observations.filter(item => item.kind === 'execution');
        expect(executions).toHaveLength(4);
        expect(executions.map(item => item.rawSql.trim())).toEqual(['BEGIN', 'SELECT 42', 'SELECT broken', 'ROLLBACK']);
        expect(executions.map(item => item.statementIndex)).toEqual([0, 1, 2, 0]);
        expect(executions[1]).toMatchObject({ rowCount: 1, commandTag: 'SELECT 1', role: 'query' });
        expect(executions[2]).toMatchObject({ outcome: 'error', error: { code: '42703', severity: 'ERROR', position: 25 } });
        expect(new Set(executions.map(item => item.transactionId)).size).toBe(1);
        expect(observations.find(item => item.kind === 'transaction')).toMatchObject({ outcome: 'rollback', executionIds: executions.map(item => item.id) });
        expect(JSON.stringify(observations)).not.toContain('authentication-secret');
        expect(JSON.stringify(observations)).not.toContain('result-secret');
        expect(executions.every(item => item.durationMs >= 0)).toBe(true);
    });

    it('resolves named portals in response order and skips failed pipeline operations until Sync', () => {
        const observations: WireObservation[] = [];
        const tracker = connected(observations);
        const parse = frame('P', Buffer.concat([Buffer.from('statement\0SELECT $1\0'), int16(1), int32(23)]));
        const bind = (portal: string, value: string) => frame('B', Buffer.concat([Buffer.from(portal + '\0statement\0'), int16(0), int16(2), int32(value.length), Buffer.from(value), int32(-1), int16(0)]));
        const execute = (portal: string) => frame('E', Buffer.concat([Buffer.from(portal + '\0'), int32(0)]));
        tracker.frontend(Buffer.concat([parse, bind('one', '7'), execute('one'), bind('two', '9'), execute('two'), frame('S')]));
        tracker.backend(Buffer.concat([frame('1'), frame('2'), frame('C', 'SELECT 1\0'), frame('2'), frame('E', 'SERROR\0C57014\0Mcancelled\0\0'), ready()]));
        const executions = observations.filter(item => item.kind === 'execution');
        expect(executions).toHaveLength(2);
        expect(executions.map(item => item.parameters)).toEqual([
            [{ ordinal: 1, typeOid: 23, format: 'text', value: '7' }, { ordinal: 2, format: 'null', value: null }],
            [{ ordinal: 1, typeOid: 23, format: 'text', value: '9' }, { ordinal: 2, format: 'null', value: null }],
        ]);
        expect(executions[1]).toMatchObject({ outcome: 'error', error: { code: '57014' } });
        tracker.frontend(Buffer.concat([frame('P', Buffer.concat([Buffer.from('bad\0bad SQL\0'), int16(0)])), execute('one'), frame('S'), frame('Q', 'SELECT 3\0')]));
        tracker.backend(Buffer.concat([frame('E', 'SERROR\0C42601\0\0'), ready(), frame('C', 'SELECT 1\0'), ready()]));
        expect(observations.filter(item => item.kind === 'execution').at(-1)).toMatchObject({ rawSql: 'SELECT 3', outcome: 'success' });
        expect(observations.filter(item => item.kind === 'execution')).toHaveLength(4);
    });

    it('keeps binary parameters typed and suspended portals as distinct executions; disconnect settles incomplete transaction', () => {
        const observations: WireObservation[] = []; const tracker = connected(observations);
        tracker.frontend(frame('Q', 'BEGIN\0')); tracker.backend(Buffer.concat([frame('C', 'BEGIN\0'), ready('T')]));
        tracker.frontend(Buffer.concat([
            frame('P', Buffer.concat([Buffer.from('s\0SELECT $1\0'), int16(1), int32(17)])),
            frame('B', Buffer.concat([Buffer.from('p\0s\0'), int16(1), int16(1), int16(1), int32(2), Buffer.from([0, 255]), int16(0)])),
            frame('E', Buffer.concat([Buffer.from('p\0'), int32(1)])), frame('S'),
        ]));
        tracker.backend(Buffer.concat([frame('1'), frame('2'), frame('D', 'not-stored'), frame('s'), ready('T')]));
        tracker.frontend(Buffer.concat([frame('E', Buffer.concat([Buffer.from('p\0'), int32(0)])), frame('S')]));
        tracker.backend(Buffer.concat([frame('C', 'SELECT 1\0'), ready('T')])); tracker.close();
        const executions = observations.filter(item => item.kind === 'execution');
        expect(executions).toHaveLength(3);
        expect(executions[1]).toMatchObject({ parameters: [{ ordinal: 1, typeOid: 17, format: 'binary', value: 'AP8=' }], outcome: 'success', rowCount: 1 });
        expect(observations.at(-1)).toMatchObject({ kind: 'transaction', outcome: 'incomplete', executionIds: executions.map(item => item.id) });
    });

    it('keeps a savepoint rollback in its transaction and starts chained transactions from ReadyForQuery', () => {
        const observations: WireObservation[] = []; const tracker = connected(observations);
        const query = (sql: string, tag: string, status: string) => { tracker.frontend(frame('Q', sql + '\0')); tracker.backend(Buffer.concat([frame('C', tag + '\0'), ready(status)])); };
        query('BEGIN', 'BEGIN', 'T'); query('SAVEPOINT marker', 'SAVEPOINT', 'T'); query('ROLLBACK TO marker', 'ROLLBACK', 'T'); query('SELECT 1', 'SELECT 1', 'T'); query('COMMIT AND CHAIN', 'COMMIT', 'T'); query('SELECT 2', 'SELECT 1', 'T'); query('ROLLBACK', 'ROLLBACK', 'I');
        const transactions = observations.filter(item => item.kind === 'transaction');
        const executions = observations.filter(item => item.kind === 'execution');
        expect(transactions.map(item => item.outcome)).toEqual(['commit', 'rollback']);
        expect(executions.slice(0, 5).every(item => item.transactionId === transactions[0]?.id)).toBe(true);
        expect(executions.slice(5).every(item => item.transactionId === transactions[1]?.id)).toBe(true);
    });

    it('distinguishes full and savepoint rollbacks inside a simple-query batch using the shared dialect', () => {
        const observations: WireObservation[] = []; const tracker = connected(observations);
        tracker.frontend(frame('Q', 'BEGIN; SAVEPOINT s; /* masked ; */ ROLLBACK WORK TO SAVEPOINT s; SELECT 1; COMMIT; BEGIN; SELECT 2; ROLLBACK; SELECT 3\0'));
        tracker.backend(Buffer.concat(['BEGIN', 'SAVEPOINT', 'ROLLBACK', 'SELECT 1', 'COMMIT', 'BEGIN', 'SELECT 1', 'ROLLBACK', 'SELECT 1'].map(tag => frame('C', tag + '\0')).concat(ready())));
        const transactions = observations.filter(item => item.kind === 'transaction');
        const executions = observations.filter(item => item.kind === 'execution');
        expect(transactions.map(item => item.outcome)).toEqual(['commit', 'rollback']);
        expect(executions.slice(0, 5).every(item => item.transactionId === transactions[0]?.id)).toBe(true);
        expect(executions.slice(5, 8).every(item => item.transactionId === transactions[1]?.id)).toBe(true);
        expect(executions[8]?.transactionId).toBeUndefined();
    });

    it('forwards unsupported SSL/unknown startup as unrecorded and resumes after COPY framing', () => {
        const observations: WireObservation[] = []; const coverage: string[] = [];
        const ssl = new PostgresWireTracker({ connectionId: 'ssl', onObservation: item => observations.push(item), onCoverage: item => coverage.push(item.reason) });
        const request = startup(); request.writeInt32BE(80877103, 4); ssl.frontend(request); ssl.backend(Buffer.from('S')); ssl.frontend(Buffer.from('encrypted bytes'));
        expect(coverage).toEqual(['ssl']); expect(observations).toEqual([]);
        const tracker = connected(observations, coverage);
        tracker.frontend(frame('Q', 'COPY data TO STDOUT\0'));
        tracker.backend(Buffer.concat([frame('H', Buffer.from([0, 0, 0])), frame('d', 'private-copy-value'), frame('c'), frame('C', 'COPY 1\0'), ready()]));
        tracker.frontend(frame('Q', 'SELECT 1\0')); tracker.backend(Buffer.concat([frame('C', 'SELECT 1\0'), ready()]));
        expect(coverage).toContain('copy');
        expect(observations.filter(item => item.kind === 'execution')).toHaveLength(1);
        expect(JSON.stringify(observations)).not.toContain('private-copy-value');
        tracker.frontend(frame('Q', "SELECT 'private-unterminated\0"));
        tracker.backend(Buffer.concat([frame('E', 'SERROR\0C42601\0\0'), ready()]));
        expect(observations.at(-1)).toMatchObject({ kind: 'execution', rawSql: '', sqlUnavailable: true, outcome: 'error', error: { code: '42601' } });
        expect(coverage).toContain('unsupported-statement');
        tracker.frontend(frame('?')); tracker.frontend(frame('Q', 'SELECT 2\0')); tracker.backend(Buffer.concat([frame('C', 'SELECT 1\0'), ready()]));
        expect(coverage).toContain('unknown-message');
        expect(observations.filter(item => item.kind === 'execution')).toHaveLength(2);
    });
});
