import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { DeploymentBackupManifestV1 } from '@happier-dev/deployments/contracts/v1';
import { prepareDeploymentRestoreV1, confirmDeploymentRestoreV1,
    type DeploymentRestoreNativeRequestV1, type DeploymentRestoreNativeResultV1 } from './restoreLifecycle.js';

const postgresBin = '/usr/lib/postgresql/16/bin';
const complete = (stdout = '') => ({ kind: 'completed', exitCode: 0, stdout, stdoutTruncated: false } as const);

// PostgreSQL itself is the boundary. The test owns this cluster and its socket;
// no application database, Docker daemon, or retained development data is used.
it.skipIf(!existsSync(join(postgresBin, 'initdb'))).each(['safe', 'ordinaryActor', 'program', 'commentedProgram', 'resetRole'] as const)(
    'imports an SQL upload as a separate non-superuser before activating it (%s)', async mode => {
        const unsafe = mode === 'program' || mode === 'commentedProgram' || mode === 'resetRole';
        const root = await mkdtemp(join(tmpdir(), 'happier-upload-pg-'));
        const data = join(root, 'data');
        const ctl = (args: string[]) => execFileSync(join(postgresBin, 'pg_ctl'), ['-D', data, ...args], { stdio: 'pipe' });
        execFileSync(join(postgresBin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
        // The temporary import user must authenticate with its actual credential,
        // rather than borrowing a superuser connection followed by SET ROLE.
        await writeFile(join(data, 'pg_hba.conf'), 'local all restore_stage,restore_stage_copy scram-sha-256\nlocal all all trust\n');
        ctl(['-l', join(root, 'server.log'), '-o', `-c listen_addresses= -k ${root}`, '-w', 'start']);
        const pid = Number((await readFile(join(data, 'postmaster.pid'), 'utf8')).split('\n')[0]);
        expect(pid).toBeGreaterThan(0);
        let nativePrincipal = userInfo().username;
        const run = (argv: readonly string[], stdin?: string | Buffer, environment?: Readonly<Record<string, string>>) => {
            const result = spawnSync(join(postgresBin, argv[0]!), argv.slice(1), { input: stdin, encoding: 'utf8',
                env: { ...process.env, PGHOST: root, PGUSER: nativePrincipal, ...environment } });
            return { ...complete(result.stdout), exitCode: result.status ?? 1,
                stderr: result.stderr, stderrTruncated: false };
        };
        const psql = (statement: string, database = 'postgres') => run(['psql', '-X', '-v', 'ON_ERROR_STOP=1',
            `--dbname=${database}`, '-At', '-c', statement]);
        if (mode === 'ordinaryActor') {
            const actor = psql('CREATE ROLE native_actor LOGIN CREATEDB CREATEROLE INHERIT');
            expect(actor.exitCode, actor.stderr).toBe(0);
            nativePrincipal = 'native_actor';
        }
        let writersRunning = true;
        let writerStops = 0;
        let importedIdentity: string | undefined;
        const marker = join(root, 'unsafe-program-ran');
        const handoffPayload = `CREATE TABLE trigger_target(value text);
CREATE FUNCTION imported_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $body$ BEGIN EXECUTE 'COPY (SELECT 1) TO PROGRAM ''touch ${marker}'''; RETURN NEW; END; $body$;
CREATE TRIGGER imported_effect BEFORE INSERT ON trigger_target FOR EACH ROW EXECUTE FUNCTION imported_trigger();
`;
        const payload = 'CREATE TABLE imported_value(value text); INSERT INTO imported_value VALUES (\'uploaded\');\n'
            + (mode === 'program' ? `COPY (SELECT 1) TO PROGRAM 'touch ${marker}';\n`
                : mode === 'commentedProgram' ? `COPY (SELECT "value" FROM "imported_value") TO /* native grant check */ PROGRAM 'touch ${marker}';\n`
                    : mode === 'resetRole' ? `RESET ROLE; COPY (SELECT 1) TO PROGRAM 'touch ${marker}';\n`
                    : "DO $body$\nBEGIN\nPERFORM 'COPY (SELECT 1) TO PROGRAM';\nEND\n$body$;\n" + handoffPayload);
        const source = { kind: 'upload', transferId: 'admitted-requester-upload', sizeBytes: Buffer.byteLength(payload),
            sha256: createHash('sha256').update(payload).digest('hex') } as const;
        const destination = { environmentId: 'target', revision: 1, adapter: 'postgres-v1', service: 'db',
            database: 'app', stagingDatabase: 'restore_stage', recoveryDatabase: 'restore_old', databaseExists: false,
            hasMeaningfulData: false, writerServices: ['web'] } as const;
        const execute = async (request: DeploymentRestoreNativeRequestV1): Promise<DeploymentRestoreNativeResultV1> => {
            if (request.kind === 'writers') {
                writersRunning = request.operation === 'start';
                if (!writersRunning) writerStops++;
                return complete();
            }
            if (request.kind === 'health') return { kind: 'health', status: 'healthy' };
            if (request.kind === 'service') {
                const input = 'stdin' in request && typeof request.stdin === 'string' ? request.stdin : undefined;
                const environment: Record<string, string> = {};
                if ('environmentOverrides' in request && request.environmentOverrides && typeof request.environmentOverrides === 'object') {
                    for (const [key, value] of Object.entries(request.environmentOverrides)) {
                        if (typeof value === 'string') environment[key] = value;
                    }
                }
                return run(request.argv, input, environment);
            }
            if (request.kind === 'integrity') return psql('SELECT value FROM imported_value', request.database);
            // The new native request is deliberately read as boundary input
            // until its production declaration lands with the implementation.
            const value: unknown = request;
            if (value && typeof value === 'object' && 'kind' in value && value.kind === 'restoreUpload'
                && 'consumer' in value && value.consumer && typeof value.consumer === 'object'
                && 'argv' in value.consumer && Array.isArray(value.consumer.argv)) {
                const argv: string[] = [];
                for (const arg of value.consumer.argv) {
                    if (typeof arg !== 'string') throw new Error('Expected native client argument');
                    argv.push(arg);
                }
                const environment: Record<string, string> = {};
                if ('environmentOverrides' in value.consumer && value.consumer.environmentOverrides
                    && typeof value.consumer.environmentOverrides === 'object') {
                    for (const [key, entry] of Object.entries(value.consumer.environmentOverrides)) {
                        if (typeof entry === 'string') environment[key] = entry;
                    }
                }
                expect(writersRunning).toBe(true);
                const connection = argv.find(arg => arg.startsWith('--dbname='));
                if (!connection) throw new Error('Expected explicit import connection');
                expect(environment.PGPASSWORD).toBeTruthy();
                expect(argv.join(' ')).not.toContain(environment.PGPASSWORD);
                const username = argv.find(arg => arg.startsWith('--username='));
                if (!username) throw new Error('Expected explicit import username');
                const identity = run(['psql', '-X', username, connection, '-At', '-c', 'SELECT session_user, current_user'], undefined, environment);
                expect(identity.exitCode, identity.stderr).toBe(0);
                const [sessionUser, currentUser] = identity.stdout.trim().split('|');
                expect(sessionUser).toBe(currentUser);
                importedIdentity = currentUser;
                expect(importedIdentity).toBe(destination.stagingDatabase);
                expect(importedIdentity).not.toBe(userInfo().username);
                return run(argv, payload, environment);
            }
            throw new Error(`Unexpected repository or volume effect ${request.kind}`);
        };
        try {
            const capture = { operationId: 'upload-import', source, sourceFormat: 'postgresSql', destination,
                signal: new AbortController().signal, execute };
            const prepare: unknown = await Reflect.apply(prepareDeploymentRestoreV1, undefined, [capture]);
            const result: unknown = await Reflect.apply(confirmDeploymentRestoreV1, undefined, [{ ...capture, prepare,
                runProtectedStage: async <T>(effect: () => Promise<T>) => effect() }]);
            expect(importedIdentity).toBe('restore_stage');
            if (unsafe) {
                expect(result).toMatchObject({ kind: 'recoveryRequired', verified: false, code: 'restore_failed' });
                expect(existsSync(marker)).toBe(false);
                expect(writerStops).toBe(0);
                expect(psql("SELECT COUNT(*) FROM pg_database WHERE datname='app'").stdout.trim()).toBe('0');
            } else {
                expect(result).toMatchObject({ kind: 'restored', verified: true });
                const appRead = psql('SELECT value FROM imported_value', 'app');
                expect(appRead.exitCode, appRead.stderr).toBe(0);
                expect(appRead.stdout.trim()).toBe('uploaded');
                if (mode === 'ordinaryActor') expect(psql('SELECT rolsuper FROM pg_roles WHERE rolname=current_user', 'app').stdout.trim()).toBe('f');
                expect(psql("SELECT rolsuper, rolcanlogin, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname='restore_stage'").stdout.trim()).toBe('f|f|f|f|f|f');
                expect(psql("SELECT r.rolsuper, r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname='imported_trigger'", 'app').stdout.trim()).toBe('f|restore_stage');
                const handoff = psql("INSERT INTO trigger_target VALUES ('later app request')", 'app');
                expect(handoff.exitCode).not.toBe(0);
                expect(handoff.stderr).toContain('COPY to or from an external program');
                expect(existsSync(marker)).toBe(false);
                // Re-backup the untrusted function, then exercise the SAME restore
                // lifecycle's repository arm. --no-owner must not promote it.
                const archive = spawnSync(join(postgresBin, 'pg_dump'), ['-Fc', '--no-owner', '--no-acl', '--dbname=app'],
                    { env: { ...process.env, PGHOST: root, PGUSER: nativePrincipal } });
                expect(archive.status, archive.stderr.toString()).toBe(0);
                const checksum = createHash('sha256').update(archive.stdout).digest('hex');
                const manifest = { schemaVersion: 1, environmentId: 'source', sourceId: 'main', kind: 'dump', configRevision: 1,
                    repositoryId: 'c'.repeat(64), snapshot: { snapshotId: 'a'.repeat(64), treeId: 'b'.repeat(64),
                        hostname: 'happier-env-source', time: '2026-10-30T19:00:00Z', paths: ['/db.dump'],
                        tags: ['happier', 'env:source', 'src:main', 'kind:dump'] },
                    totalBytesProcessed: archive.stdout.length, totalFilesProcessed: 1, producerChecksumSha256: checksum } satisfies DeploymentBackupManifestV1;
                const repositoryDestination = { ...destination, database: 'app_copy', stagingDatabase: 'restore_stage_copy',
                    recoveryDatabase: 'restore_old_copy' };
                const repositoryExecute = async (request: DeploymentRestoreNativeRequestV1): Promise<DeploymentRestoreNativeResultV1> => {
                    if (request.kind === 'restic') {
                        const argv = request.request.argv;
                        if (argv.includes('config')) return complete(JSON.stringify({ id: manifest.repositoryId, version: 2 }));
                        if (argv.includes('snapshots')) return complete(JSON.stringify([{ ...manifest.snapshot,
                            id: manifest.snapshot.snapshotId, tree: manifest.snapshot.treeId }]));
                        if (argv.includes('blob')) return complete(JSON.stringify({ nodes: [{ name: 'db.dump', type: 'file', size: archive.stdout.length }] }));
                        return { ...complete(), stdoutChecksumSha256: checksum, stdoutBytes: archive.stdout.length };
                    }
                    if (request.kind === 'restoreStream') {
                        const connection = request.consumer.argv.filter(arg => arg.startsWith('--username=') || arg.startsWith('--dbname='));
                        const identity = run(['psql', '-X', ...connection, '-At', '-c', 'SELECT session_user, current_user'],
                            undefined, request.consumer.environmentOverrides);
                        expect(identity.exitCode, identity.stderr).toBe(0);
                        expect(identity.stdout.trim()).toBe('restore_stage_copy|restore_stage_copy');
                        const imported = run(request.consumer.argv, archive.stdout, request.consumer.environmentOverrides);
                        return { ...imported, producer: { exitCode: 0, checksumSha256: checksum, bytes: archive.stdout.length } };
                    }
                    return execute(request);
                };
                const repositoryCapture = { operationId: 'repository-import', source: manifest, sourceFormat: 'postgresCustom' as const,
                    destination: repositoryDestination, access: { repository: '/boundary-repository', passwordFilePath: '/boundary-password',
                        credentialFiles: [], environmentVariableNames: [] }, signal: new AbortController().signal, execute: repositoryExecute };
                const repositoryPrepare = await prepareDeploymentRestoreV1(repositoryCapture);
                const repositoryResult = await confirmDeploymentRestoreV1({ ...repositoryCapture, prepare: repositoryPrepare,
                    runProtectedStage: async <T>(effect: () => Promise<T>) => effect() });
                expect(repositoryResult).toMatchObject({ kind: 'restored', verified: true });
                expect(psql("SELECT r.rolsuper, r.rolcanlogin, r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname='imported_trigger'", 'app_copy').stdout.trim()).toBe('f|f|restore_stage_copy');
                const restoredHandoff = psql("INSERT INTO trigger_target VALUES ('later restored app request')", 'app_copy');
                expect(restoredHandoff.exitCode).not.toBe(0);
                expect(existsSync(marker)).toBe(false);
                expect(writerStops).toBe(2);
                expect(writersRunning).toBe(true);
            }
        } finally { ctl(['-m', 'fast', '-w', 'stop']); await rm(root, { recursive: true, force: true }); }
    });
