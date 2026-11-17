import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, vi } from 'vitest';
import { openNativeDockerStream } from '@/daemon/local/services/launch/nativeDockerStream';

const run = promisify(execFile);
export const nativeMysqlImage = process.env.HAPPIER_TEST_NATIVE_MYSQL_IMAGE;
export const nativePostgresqlImage = process.env.HAPPIER_TEST_NATIVE_POSTGRES_IMAGE;
const docker = process.env.HAPPIER_TEST_NATIVE_DATABASE_DOCKER_COMMAND ?? 'docker';

/** Real template engines, without host publication. Docker is the OS boundary. */
export async function createNativeDatabaseContainerFixture(engine: 'mysql' | 'postgresql', image: string) {
    const name = `happier-native-${engine}-${randomUUID()}`;
    await run(docker, ['run', '--detach', '--rm', '--name', name, '--network', 'none',
        ...(engine === 'mysql' ? ['--env', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes', '--env', 'MYSQL_DATABASE=native_fixture']
            : ['--env', 'POSTGRES_PASSWORD=native-admin', '--env', 'POSTGRES_DB=native_fixture']), image]);
    const execute = (sql: string) => run(docker, engine === 'mysql'
        ? ['exec', name, 'mysql', '--protocol=TCP', '--host=127.0.0.1', '--user=root', '--batch', '--skip-column-names', '-e', sql]
        : ['exec', '--env', 'PGPASSWORD=native-admin', name, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
            '--host=127.0.0.1', '--username=postgres', '--dbname=native_fixture', '-c', sql]);
    try {
        await vi.waitFor(async () => { expect((await execute(engine === 'mysql'
            ? "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='native_fixture'" : 'SELECT 1')).stdout.trim()).toBe('1'); }, { timeout: 60_000 });
    } catch (error) { await run(docker, ['stop', name]); throw error; }
    let closing: Promise<unknown> | undefined;
    return {
        name, execute,
        async openStream(args: readonly string[], signal?: AbortSignal) {
            return openNativeDockerStream({ command: docker, args: [], env: process.env, release() {} }, [], args, signal);
        },
        async close() { await (closing ??= run(docker, ['stop', name])); },
    };
}
