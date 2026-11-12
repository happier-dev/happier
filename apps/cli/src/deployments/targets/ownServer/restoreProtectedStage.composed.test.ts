import { describe, expect, it } from 'vitest';
import { confirmDeploymentRestoreV1, type DeploymentRestoreNativeRequestV1,
    type DeploymentRestoreNativeResultV1 } from '@happier-dev/deployments';
import { createMachineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';

const snapshotId = 'a'.repeat(64), treeId = 'b'.repeat(64), repositoryId = 'c'.repeat(64), checksum = 'd'.repeat(64);
const source = { schemaVersion: 1, environmentId: 'source', sourceId: 'main', kind: 'dump', configRevision: 1,
    repositoryId, snapshot: { snapshotId, treeId, hostname: 'happier-env-source', time: '2026-10-30T19:00:00Z',
        paths: ['/db.dump'], tags: ['happier', 'env:source', 'src:main', 'kind:dump'] },
    totalBytesProcessed: 123, totalFilesProcessed: 1, producerChecksumSha256: checksum } as const;
const destination = { environmentId: 'target', revision: 2, service: 'db', adapter: 'postgres-v1', database: 'app',
    stagingDatabase: 'restore_stage', recoveryDatabase: 'restore_old', databaseExists: true,
    hasMeaningfulData: false, writerServices: ['web'] } as const;
const access = { repository: '/repository', passwordFilePath: '/run/password', credentialFiles: [], environmentVariableNames: [] } as const;
const completed = (stdout = '') => ({ kind: 'completed', exitCode: 0, stdout, stdoutTruncated: false } as const);

describe('restore through the canonical native admission owner', () => {
    it.each([{ stopAt: 'swap', healthFails: false }, { stopAt: 'swap', healthFails: true },
        { stopAt: 'writerStop', healthFails: false }])('defers Stop at $stopAt through settlement (health failure: $healthFails)', async ({ healthFails, stopAt }) => {
        const admission = createMachineNativeEffectAdmission();
        const stop = new AbortController();
        const names = new Set(['app']);
        let writersRunning = true;
        let protectedStages = 0;
        let forwardedSignal: AbortSignal | undefined;
        const pending: string[] = [];
        // Only database/process and P41 health IO are substituted. Restore SQL,
        // native admission, child scope and cancellation forwarding remain real.
        const database = async (request: DeploymentRestoreNativeRequestV1): Promise<DeploymentRestoreNativeResultV1> => {
            if (request.kind === 'restic') {
                const argv = request.request.argv;
                if (argv.includes('config')) return completed(JSON.stringify({ id: repositoryId, version: 2 }));
                if (argv.includes('snapshots')) return completed(JSON.stringify([{ id: snapshotId, tree: treeId,
                    hostname: source.snapshot.hostname, time: source.snapshot.time, paths: source.snapshot.paths, tags: source.snapshot.tags }]));
                if (argv.includes('blob')) return completed(JSON.stringify({ nodes: [{ name: 'db.dump', type: 'file', size: 123 }] }));
                return { ...completed(), stdoutChecksumSha256: checksum, stdoutBytes: 123 };
            }
            if (request.kind === 'restoreStream') return { ...completed(), producer: { exitCode: 0, checksumSha256: checksum, bytes: 123 } };
            if (request.kind === 'health') return { kind: 'health', status: healthFails ? 'unhealthy' : 'healthy' };
            if (request.kind === 'writers') {
                writersRunning = request.operation === 'start';
                if (stopAt === 'writerStop' && request.operation === 'stop') stop.abort();
                return completed();
            }
            if (request.kind === 'integrity') return completed();
            if (request.kind === 'service' && request.stdin !== undefined) return completed();
            if (request.argv[0] === 'createdb') { names.add('restore_stage'); return completed(); }
            const sql = request.argv.at(-1) ?? '';
            if (sql.startsWith('SELECT current_user =')) return completed('t');
            if (sql.startsWith('SELECT')) return completed(JSON.stringify([...names]));
            const rename = /ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"/u.exec(sql);
            if (!rename) throw new Error('Unexpected native database command');
            const from = rename[1]!, to = rename[2]!;
            expect(names.has(from)).toBe(true);
            expect(names.has(to)).toBe(false);
            names.delete(from); names.add(to);
            if (stopAt === 'swap' && from === 'app' && to === 'restore_old') stop.abort();
            return completed();
        };
        const result = await admission.run({ operation: { operationId: 'restore', kind: 'restore', signal: stop.signal },
            keys: [{ kind: 'composeProject', dockerEndpoint: 'engine', projectName: 'app' }] }, async context => {
            forwardedSignal = context.operation.signal;
            const input = { source, sourceFormat: 'postgresCustom' as const, destination, access,
                prepare: { kind: 'prepared' as const, operationId: 'prepare', source, sourceFormat: 'postgresCustom' as const, destination },
                signal: context.operation.signal!,
                execute: (request: DeploymentRestoreNativeRequestV1) => admission.runStage(context, () => database(request)),
                runProtectedStage: <T>(effect: () => Promise<T>): Promise<T> => {
                    protectedStages++;
                    return admission.runStage(context, effect, { protected: true, onStopPending(status) {
                        expect(context.operation.signal?.aborted).toBe(false);
                        pending.push(status);
                    } });
                } };
            const terminal = await confirmDeploymentRestoreV1(input);
            expect(stop.signal.aborted, JSON.stringify({ terminal, names: [...names], protectedStages, pending })).toBe(true);
            await expect(admission.runStage(context, async () => { throw new Error('Unstarted stage ran after Stop'); }))
                .rejects.toMatchObject({ code: 'cancelled' });
            return terminal;
        });
        expect(names.has('app'), 'Stop must never settle with the canonical database absent').toBe(true);
        expect(writersRunning).toBe(true);
        expect(protectedStages).toBe(1);
        expect(pending).toEqual(['stop_pending']);
        expect(result).toMatchObject(healthFails ? { kind: 'rolledBack', verified: false } : { kind: 'restored', verified: true });
        expect([...names].sort()).toEqual(healthFails ? ['app', 'restore_stage'] : ['app', 'restore_old']);
        expect(forwardedSignal?.aborted).toBe(true);
    });
});
