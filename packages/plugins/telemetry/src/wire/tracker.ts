import { PostgresFrames, WireReader } from './frames.js';
import { normalizePostgresqlStatement, postgresqlStatementRanges } from '@happier-dev/databases/postgresql';

/** Raw detail must pass the shared dialect normalizer before persistence or disclosure. Binary values use base64. */
export type WireParameter = { ordinal: number; typeOid?: number; format: 'null' | 'text' | 'binary'; value: string | null };
export type WireError = { code?: string; severity?: string; position?: number; message?: string };
export type WireExecutionObservation = {
    kind: 'execution'; id: string; connectionId: string; transactionId?: string; protocol: 'simple' | 'extended';
    /** One selected statement, never the original simple-query batch. Empty when unavailable. */
    rawSql: string; sqlUnavailable?: true; parameters: readonly WireParameter[]; statementIndex: number; role: 'query' | 'control';
    startedAt: number; durationMs: number; commandTag?: string; rowCount?: number; outcome: 'success' | 'error' | 'incomplete'; error?: WireError;
};
export type WireTransactionObservation = {
    kind: 'transaction'; id: string; connectionId: string; executionIds: readonly string[];
    startedAt: number; durationMs: number; outcome: 'commit' | 'rollback' | 'incomplete';
};
export type WireObservation = WireExecutionObservation | WireTransactionObservation;
export type WireCoverage = { reason: 'ssl' | 'cancel' | 'unsupported-startup' | 'unknown-message' | 'malformed-frame' | 'unsupported-statement' | 'copy' | 'observer-failed'; connectionId: string };
export type WireTrackerOptions = { connectionId: string; onObservation: (observation: WireObservation) => void; onCoverage?: (coverage: WireCoverage) => void };

type Statement = { rawSql: string; typeOids: number[] };
type Portal = { statement: Statement; parameters: WireParameter[] };
type OperationInput =
    | { kind: 'query'; rawSql: string; statementRanges?: ReturnType<typeof postgresqlStatementRanges> }
    | { kind: 'parse'; name: string; statement: Statement }
    | { kind: 'bind'; name: string; statementName: string; parameters: WireParameter[] }
    | { kind: 'execute'; name: string }
    | { kind: 'close' | 'describe'; name: string; target: string }
    | { kind: 'sync' }
;
type Operation = OperationInput & { startedAt: number; monotonicStart: number; rows: number; statementIndex: number; unsupported?: boolean };
type Transaction = { id: string; executionIds: string[]; startedAt: number; monotonicStart: number; outcome?: 'commit' | 'rollback' };

// Protocol basis: PostgreSQL 18 §§54.2/54.7. No SQL grammar or masking policy lives here.
export class PostgresWireTracker {
    private readonly client: PostgresFrames;
    private readonly server: PostgresFrames;
    private readonly statements = new Map<string, Statement>();
    private readonly portals = new Map<string, Portal>();
    private operations: Operation[] = [];
    private cursor = 0;
    private stopped = false;
    private recovering = false;
    private transaction: Transaction | undefined;
    private executionSequence = 0;
    private transactionSequence = 0;

    constructor(private readonly options: WireTrackerOptions) {
        this.client = new PostgresFrames(true, tag => 'QPBECD'.includes(tag), (tag, body) => this.clientFrame(tag, body), code => {
            if (code === 80877103) this.unsupported('ssl');
            else if (code === 80877102) this.unsupported('cancel');
            else if (code < 196608 || code > 196610) this.unsupported('unsupported-startup');
        });
        this.server = new PostgresFrames(false, tag => 'CEZ'.includes(tag), (tag, body) => this.serverFrame(tag, body), () => {});
    }

    frontend(bytes: Buffer): void { this.feed(this.client, bytes); }
    backend(bytes: Buffer): void { this.feed(this.server, bytes); }
    private feed(frames: PostgresFrames, bytes: Buffer): void {
        if (this.stopped) return;
        try { frames.feed(bytes); } catch { this.unsupported('malformed-frame'); }
        if (this.cursor > 0) { this.operations.splice(0, this.cursor); this.cursor = 0; }
    }
    private enqueue(operation: OperationInput): void {
        this.operations.push({ ...operation, startedAt: Date.now(), monotonicStart: performance.now(), rows: 0, statementIndex: 0 });
    }
    private clientFrame(tag: string, body: Buffer): void {
        if (this.recovering && tag !== 'S') return;
        const reader = new WireReader(body);
        switch (tag) {
            case 'Q': {
                const rawSql = reader.string(); reader.end();
                let statementRanges: ReturnType<typeof postgresqlStatementRanges> | undefined;
                try { statementRanges = postgresqlStatementRanges(rawSql); } catch { this.coverage('unsupported-statement'); }
                this.enqueue({ kind: 'query', rawSql, statementRanges }); break;
            }
            case 'P': {
                const name = reader.string(); const rawSql = reader.string(); const count = reader.int16(); const typeOids = [];
                for (let index = 0; index < count; index++) typeOids.push(reader.int32());
                reader.end(); this.enqueue({ kind: 'parse', name, statement: { rawSql, typeOids } }); break;
            }
            case 'B': {
                const name = reader.string(); const statementName = reader.string(); const formatCount = reader.int16(); const formats = [];
                for (let index = 0; index < formatCount; index++) formats.push(reader.int16());
                const count = reader.int16(); const parameters: WireParameter[] = [];
                if (formatCount !== 0 && formatCount !== 1 && formatCount !== count) throw new Error('Invalid parameter format count');
                for (let index = 0; index < count; index++) {
                    const length = reader.int32(); const format = formats.length === 1 ? formats[0] : formats[index] ?? 0;
                    if (format !== 0 && format !== 1) throw new Error('Invalid parameter format');
                    const value = length === -1 ? null : reader.value(length);
                    parameters.push({ ordinal: index + 1, format: value === null ? 'null' : format === 1 ? 'binary' : 'text', value: value === null ? null : value.toString(format === 1 ? 'base64' : 'utf8') });
                }
                const resultCount = reader.int16(); for (let index = 0; index < resultCount; index++) reader.int16();
                reader.end(); this.enqueue({ kind: 'bind', name, statementName, parameters }); break;
            }
            case 'E': { const name = reader.string(); reader.int32(); reader.end(); this.enqueue({ kind: 'execute', name }); break; }
            case 'C': case 'D': { const target = reader.value(1).toString(); const name = reader.string(); reader.end(); this.enqueue({ kind: tag === 'C' ? 'close' : 'describe', name, target }); break; }
            case 'S': this.enqueue({ kind: 'sync' }); break;
            case 'p': case 'H': case 'X': case 'd': case 'c': case 'f': break;
            default: this.unsupported('unknown-message');
        }
    }
    private serverFrame(tag: string, body: Buffer): void {
        const operation = this.operations[this.cursor];
        switch (tag) {
            case '1': if (operation?.kind === 'parse') { this.statements.set(operation.name, operation.statement); this.cursor++; } break;
            case '2':
                if (operation?.kind === 'bind') {
                    const statement = this.statements.get(operation.statementName);
                    if (statement) this.portals.set(operation.name, { statement, parameters: operation.parameters.map((parameter, index) => ({ ...parameter, ...(statement.typeOids[index] === undefined ? {} : { typeOid: statement.typeOids[index] }) })) });
                    this.cursor++;
                } break;
            case '3':
                if (operation?.kind === 'close') { (operation.target === 'S' ? this.statements : this.portals).delete(operation.name); this.cursor++; } break;
            case 'T': case 'n': if (operation?.kind === 'describe') this.cursor++; break;
            case 'D': if (operation) operation.rows++; break;
            case 'C': case 's': case 'I': {
                if (!operation) break;
                const commandTag = tag === 'C' ? new WireReader(body).string() : undefined;
                this.complete(operation, 'success', commandTag);
                if (operation.kind === 'query') { operation.statementIndex++; operation.rows = 0; operation.unsupported = false; operation.monotonicStart = performance.now(); operation.startedAt = Date.now(); }
                else this.cursor++;
                break;
            }
            case 'E': {
                if (!operation) break;
                this.complete(operation, 'error', undefined, this.error(body));
                if (operation.kind !== 'query') {
                    this.cursor++;
                    while (this.cursor < this.operations.length && this.operations[this.cursor]?.kind !== 'sync') this.cursor++;
                    this.recovering = true;
                }
                break;
            }
            case 'Z':
                if (operation?.kind === 'query' || operation?.kind === 'sync') this.cursor++;
                this.recovering = false;
                if (body[0] === 73) { this.finishTransaction(this.transaction?.outcome ?? 'incomplete'); this.portals.clear(); }
                else if (body[0] === 84) {
                    if (!this.transaction) this.beginTransaction(Date.now(), performance.now());
                    if (this.transaction) this.transaction.outcome = undefined;
                }
                break;
            case 'G': case 'H': case 'W': if (operation) operation.unsupported = true; this.coverage('copy'); break;
            case 'R': case 'K': case 'S': case 'N': case 'A': case 'v': case 't': case 'd': case 'c': break;
            default: this.unsupported('unknown-message');
        }
    }
    private statement(operation: Operation): Portal | undefined {
        if (operation.kind === 'query') {
            const range = operation.statementRanges?.[operation.statementIndex];
            return { statement: { rawSql: range ? operation.rawSql.slice(range.start, range.end) : '', typeOids: [] }, parameters: [] };
        }
        if (operation.kind === 'parse') return { statement: operation.statement, parameters: [] };
        if (operation.kind === 'bind') { const statement = this.statements.get(operation.statementName); return statement ? { statement, parameters: operation.parameters } : undefined; }
        if (operation.kind === 'execute') return this.portals.get(operation.name);
        return undefined;
    }
    private complete(operation: Operation, outcome: WireExecutionObservation['outcome'], commandTag?: string, error?: WireError): void {
        const portal = this.statement(operation);
        if (!portal || operation.unsupported) return;
        if (commandTag === 'BEGIN') {
            if (this.transaction?.outcome) this.finishTransaction(this.transaction.outcome);
            if (!this.transaction) this.beginTransaction(operation.startedAt, operation.monotonicStart);
        }
        const id = `${this.options.connectionId}:q${++this.executionSequence}`;
        this.transaction?.executionIds.push(id);
        const rollbackEndsTransaction = commandTag === 'ROLLBACK' ? this.rollbackEndsTransaction(operation, portal.statement.rawSql) : undefined;
        if (this.transaction && (commandTag === 'COMMIT' || (commandTag === 'ROLLBACK' && rollbackEndsTransaction !== false))) this.transaction.outcome = commandTag === 'COMMIT' ? 'commit' : 'rollback';
        const count = commandTag?.match(/ (\d+)$/)?.[1];
        this.emit({ kind: 'execution', id, connectionId: this.options.connectionId, ...(this.transaction ? { transactionId: this.transaction.id } : {}), protocol: operation.kind === 'query' ? 'simple' : 'extended', rawSql: portal.statement.rawSql, ...(operation.kind === 'query' && !operation.statementRanges ? { sqlUnavailable: true as const } : {}), parameters: portal.parameters, statementIndex: operation.statementIndex, role: commandTag && /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)( |$)/.test(commandTag) ? 'control' : 'query', startedAt: operation.startedAt, durationMs: performance.now() - operation.monotonicStart, outcome, ...(commandTag ? { commandTag } : {}), rowCount: count === undefined ? operation.rows : Number(count), ...(error ? { error } : {}) });
        if (this.transaction?.outcome === 'commit' || (this.transaction?.outcome === 'rollback' && rollbackEndsTransaction === true)) this.finishTransaction(this.transaction.outcome);
    }
    private rollbackEndsTransaction(operation: Operation, rawSql: string): boolean | undefined {
        try {
            if (operation.kind === 'query' && !operation.statementRanges) return undefined;
            // The shared dialect alone lexes SQL, including comments and quoted values.
            const shape = normalizePostgresqlStatement(rawSql).shape;
            return !/^rollback(?: work| transaction)? to(?: |$)/.test(shape);
        } catch { return undefined; } // Unsupported SQL stays timing-only at the normalizer; ReadyForQuery still settles ordinary transactions.
    }
    private error(body: Buffer): WireError {
        let offset = 0; const result: WireError = {};
        while (offset < body.length && body[offset] !== 0) {
            const tag = String.fromCharCode(body[offset++]!); const end = body.indexOf(0, offset);
            if (end < 0) throw new Error('Invalid error field');
            const value = body.toString('utf8', offset, end); offset = end + 1;
            if (tag === 'C') result.code = value;
            else if (tag === 'V' || (tag === 'S' && !result.severity)) result.severity = value;
            else if (tag === 'M') result.message = value;
            else if (tag === 'P' && /^\d+$/.test(value)) result.position = Number(value);
        }
        return result;
    }
    private finishTransaction(outcome: WireTransactionObservation['outcome']): void {
        const transaction = this.transaction; this.transaction = undefined;
        if (transaction) this.emit({ kind: 'transaction', id: transaction.id, connectionId: this.options.connectionId, executionIds: transaction.executionIds, startedAt: transaction.startedAt, durationMs: performance.now() - transaction.monotonicStart, outcome });
    }
    private beginTransaction(startedAt: number, monotonicStart: number): void {
        this.transaction = { id: `${this.options.connectionId}:t${++this.transactionSequence}`, executionIds: [], startedAt, monotonicStart };
    }
    private emit(observation: WireObservation): void {
        try { this.options.onObservation(observation); } catch { this.coverage('observer-failed'); }
    }
    private coverage(reason: WireCoverage['reason']): void { try { this.options.onCoverage?.({ reason, connectionId: this.options.connectionId }); } catch { /* Observation failures cannot affect relay. */ } }
    private unsupported(reason: WireCoverage['reason']): void { this.coverage(reason); this.close(); }
    close(): void {
        if (this.stopped) return;
        const operation = this.operations[this.cursor];
        if (operation && (operation.kind === 'execute' || operation.kind === 'query')) this.complete(operation, 'incomplete');
        this.finishTransaction('incomplete'); this.disable();
    }
    disable(): void { this.stopped = true; this.client.disable(); this.server.disable(); this.operations = []; this.statements.clear(); this.portals.clear(); this.transaction = undefined; }
}
