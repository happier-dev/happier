import { createConnection, createServer, type Socket } from 'node:net';

/** Observe native Prisma's physical results, not its lossy query-event params.
 * PostgreSQL 17 protocol 3: Parse/Bind/Execute identify the SQL; each DataRow
 * is a row actually returned. Bytes, including binary binds, pass unchanged.
 * https://www.postgresql.org/docs/17/protocol-message-formats.html
 */
export async function observePostgresSessionRows(databaseUrl: string) {
    if (databaseUrl !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
        throw new Error('Physical SQL observation requires the disposable PostgreSQL harness');
    }
    const target = new URL(databaseUrl);
    const reads: Array<{ query: string; rows: number }> = [];
    const completedStatements: Array<{ query: string; rows: number }> = [];
    const sockets = new Set<Socket>();
    let failure: Error | undefined;
    const server = createServer(downstream => {
        const upstream = createConnection({ host: target.hostname, port: Number(target.port || 5432) });
        for (const socket of [downstream, upstream]) {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            socket.on('error', () => {
                failure ??= new Error('PostgreSQL observation connection failed');
                downstream.destroy();
                upstream.destroy();
            });
        }
        const statements = new Map<string, string>();
        const portals = new Map<string, string>();
        const executing: Array<{ kind: 'query'; query: string; rows: number } | { kind: 'sync' }> = [];
        const stringAt = (body: Buffer, offset = 0) => {
            const end = body.indexOf(0, offset);
            if (end < 0) throw new Error('Invalid PostgreSQL observation message');
            return { value: body.toString('utf8', offset, end), next: end + 1 };
        };
        const frontend = (kind: string, body: Buffer) => {
            if (kind === 'P') {
                const name = stringAt(body);
                statements.set(name.value, stringAt(body, name.next).value);
            } else if (kind === 'B') {
                const portal = stringAt(body);
                const statement = statements.get(stringAt(body, portal.next).value);
                if (statement === undefined) throw new Error('Unobserved PostgreSQL prepared statement');
                portals.set(portal.value, statement);
            } else if (kind === 'E') {
                const portal = stringAt(body);
                const query = portals.get(portal.value);
                if (query === undefined || body.readUInt32BE(portal.next) !== 0) {
                    throw new Error('Expected an observed, unpaged PostgreSQL execution');
                }
                executing.push({ kind: 'query', query, rows: 0 });
            } else if (kind === 'Q') {
                executing.push({ kind: 'query', query: stringAt(body).value, rows: 0 }, { kind: 'sync' });
            } else if (kind === 'S') {
                executing.push({ kind: 'sync' });
            } else if (kind === 'C') {
                const name = stringAt(body, 1).value;
                if (body[0] === 83) statements.delete(name);
                else portals.delete(name);
            }
        };
        const backend = (kind: string, body: Buffer) => {
            if (kind === 'D') {
                if (executing[0]?.kind !== 'query') throw new Error('Unattributed PostgreSQL result row');
                executing[0].rows++;
            } else if (kind === 'C') {
                const result = executing.shift();
                if (result?.kind !== 'query') throw new Error('Unattributed PostgreSQL completion');
                completedStatements.push({ query: result.query, rows: result.rows });
                if (/^SELECT\b/.test(result.query) && /FROM "public"\."Session"(?:\s|$)/.test(result.query)) {
                    if (stringAt(body).value !== `SELECT ${result.rows}`) {
                        throw new Error('PostgreSQL returned-row count disagrees with completion');
                    }
                    reads.push({ query: result.query, rows: result.rows });
                }
            } else if (kind === 'E') {
                // The backend skips the failed extended-query group up to Sync.
                while (executing[0]?.kind === 'query') executing.shift();
            } else if (kind === 'I') {
                executing.shift();
            } else if (kind === 'Z') {
                // Prisma pipelines later groups before this ReadyForQuery.
                // Consume its matching Sync, never discard later executions.
                if (executing.length && executing.shift()?.kind !== 'sync') {
                    throw new Error('Unfinished PostgreSQL observation at ready');
                }
            }
        };
        const frames = (startup: boolean, observe: (kind: string, body: Buffer) => void) => {
            let buffered: Buffer = Buffer.alloc(0);
            return (chunk: Buffer) => {
                try {
                    buffered = Buffer.concat([buffered, chunk]);
                    if (startup) {
                        if (buffered.length < 4 || buffered.length < buffered.readUInt32BE(0)) return;
                        if (buffered.readUInt32BE(4) !== 196608) throw new Error('Expected plaintext PostgreSQL protocol 3 startup');
                        buffered = buffered.subarray(buffered.readUInt32BE(0));
                        startup = false;
                    }
                    while (buffered.length >= 5) {
                        const size = buffered.readUInt32BE(1) + 1;
                        if (size < 5) throw new Error('Invalid PostgreSQL observation frame length');
                        if (buffered.length < size) return;
                        observe(String.fromCharCode(buffered[0]!), buffered.subarray(5, size));
                        buffered = buffered.subarray(size);
                    }
                } catch (error) {
                    failure ??= error instanceof Error ? error : new Error('PostgreSQL observation failed');
                    downstream.destroy();
                    upstream.destroy();
                }
            };
        };
        downstream.on('data', frames(true, frontend));
        upstream.on('data', frames(false, backend));
        downstream.pipe(upstream);
        upstream.pipe(downstream);
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing PostgreSQL observation listener');
    const observedUrl = new URL(databaseUrl);
    observedUrl.hostname = '127.0.0.1';
    observedUrl.port = String(address.port);
    // The runner owns a loopback disposable PG17 container. Encryption would
    // hide wire results; this test-only client explicitly uses its plain socket.
    observedUrl.searchParams.set('sslmode', 'disable');
    return {
        databaseUrl: observedUrl.toString(),
        reads,
        statements: completedStatements,
        assertHealthy() { if (failure) throw failure; },
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            if (failure) throw failure;
        },
    };
}
