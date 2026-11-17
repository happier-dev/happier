import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const binaries = '/usr/lib/postgresql/16/bin';
export const nativePostgresqlAvailable = existsSync(join(binaries, 'initdb'));

/** Actual PostgreSQL, with SCRAM TCP and a separate local administrator socket. */
export async function createNativePostgresqlFixture(directory: string) {
    await mkdir(directory, { recursive: true });
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Expected a native fixture TCP port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const data = join(directory, 'data');
    await run(join(binaries, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'fixture', '--no-locale', '-E', 'UTF8']);
    await writeFile(join(data, 'pg_hba.conf'), 'local all all trust\nhost all all 127.0.0.1/32 scram-sha-256\n');
    await run(join(binaries, 'pg_ctl'), ['-D', data, '-l', join(directory, 'postgres.log'),
        '-o', `-h 127.0.0.1 -p ${port} -k ${directory}`, '-w', 'start']);
    const connectionString = (database: string) => `postgresql://fixture@localhost/${encodeURIComponent(database)}?host=${encodeURIComponent(directory)}&port=${port}`;
    let closing: Promise<unknown> | undefined;
    return {
        port, psqlPath: join(binaries, 'psql'), connectionString,
        async execute(sql: string, database = 'postgres') {
            return run(join(binaries, 'psql'), ['-X', '-v', 'ON_ERROR_STOP=1', '--dbname', connectionString(database), '-c', sql]);
        },
        async close() { await (closing ??= run(join(binaries, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'])); },
    };
}
