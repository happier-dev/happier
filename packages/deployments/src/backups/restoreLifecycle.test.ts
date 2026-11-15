import { describe, expect, it } from 'vitest';
import * as owners from '../index.js';
import { createDeploymentDumpBackupSourceV1 } from './configurationV1.js';
import type { DeploymentRestoreConfirmInputV1, DeploymentRestoreNativeRequestV1, DeploymentRestoreNativeResultV1,
    DeploymentRestorePrepareInputV1, DeploymentRestorePrepareReceiptV1 } from '../index.js';
import type { DeploymentBackupRunInputV1 } from '../actions/backups.js';
import { DeploymentRestoreStepV1Schema } from '@happier-dev/deployment-protocol';
import type { DeploymentBackupManifestV1, DeploymentPreMigrationBackupV1 } from '@happier-dev/deployment-protocol';

const snapshotId = 'a'.repeat(64), treeId = 'b'.repeat(64), repositoryId = 'c'.repeat(64), checksum = 'd'.repeat(64);
const manifest: DeploymentBackupManifestV1 = { schemaVersion: 1, environmentId: 'source', sourceId: 'main', kind: 'dump', configRevision: 1,
    repositoryId, snapshot: { snapshotId, treeId, hostname: 'happier-env-source', time: '2026-10-30T19:00:00Z',
        paths: ['/db.dump'], tags: ['happier', 'env:source', 'src:main', 'kind:dump'] },
    totalBytesProcessed: 123, totalFilesProcessed: 1, producerChecksumSha256: checksum };
const access = { repository: '/repository', passwordFilePath: '/run/password', credentialFiles: [], environmentVariableNames: [] } as const;
const destination = { environmentId: 'target', revision: 2, service: 'db', adapter: 'postgres-v1', database: 'app',
    stagingDatabase: 'restore_stage', recoveryDatabase: 'restore_old', databaseExists: true,
    hasMeaningfulData: false, writerServices: ['web'] } as const;
const complete = (stdout = '') => ({ kind: 'completed', exitCode: 0, stdout, stdoutTruncated: false } as const);

function safetyBackup(producerExitCode = 0, onPayloadRead?: () => void): DeploymentBackupRunInputV1 {
    return { environmentId: 'target', access, signal: new AbortController().signal,
        configuration: { configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 's3' }, occurrenceId: 'storage',
            config: {}, credentialBindings: [], sources: [{ kind: 'dump', sourceId: 'main', service: 'db', consistency: 'logical' }],
            ownership: { environmentId: 'target', prefix: 'target' }, retention: { kind: 'keepEverything' } },
        data: [{ engine: 'postgres', service: 'db', logicalBackup: { adapter: 'postgres-v1', database: 'DATABASE_NAME' } }],
        async execute(request) {
            if (request.argv.includes('config')) return complete(JSON.stringify({ id: repositoryId, version: 2 }));
            if (request.argv.includes('backup')) return { ...complete(JSON.stringify({ message_type: 'summary', snapshot_id: 'e'.repeat(64),
                total_bytes_processed: 123, total_files_processed: 1 })), producer: { exitCode: producerExitCode, checksumSha256: checksum } };
            if (request.argv.includes('snapshots')) return complete(JSON.stringify([{ id: 'e'.repeat(64), tree: treeId,
                hostname: 'happier-env-target', time: manifest.snapshot.time, paths: ['/db.dump'], tags: ['happier', 'env:target', 'src:main', 'kind:dump'] }]));
            if (request.argv.includes('blob')) return complete(JSON.stringify({ nodes: [{ name: 'db.dump', type: 'file', size: 123 }] }));
            onPayloadRead?.();
            return { ...complete(), stdoutChecksumSha256: checksum, stdoutBytes: 123 };
        } };
}

function boundary(options: Readonly<{ healthFails?: boolean; streamFails?: boolean; unknownActivation?: boolean;
    unknownObservation?: boolean; failSecondRename?: boolean; wrongRepository?: boolean; integrityFails?: boolean;
    abortAfterActivation?: AbortController; abortAfterFirstRename?: AbortController; abortAfterWriterStop?: AbortController; nativeSignal?: AbortSignal;
    initialNames?: readonly string[]; unknownFirstWriterStart?: boolean; source?: DeploymentBackupManifestV1 }> = {}) {
    const source = options.source ?? manifest;
    let names = new Set(options.initialNames ?? ['app']);
    let startCount = 0;
    let writersRunning = true;
    let nativeSignal = options.nativeSignal;
    let callsAfterAbort = 0;
    const effects: string[] = [];
    // Substitute only native process, streaming and P41 health IO. All restore decisions and SQL remain real.
    const execute = async (request: DeploymentRestoreNativeRequestV1): Promise<DeploymentRestoreNativeResultV1> => {
        if (nativeSignal?.aborted) {
            callsAfterAbort++;
            throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
        }
        const argv = request.kind === 'service' ? request.argv : request.kind === 'restic' ? request.request.argv : [];
        effects.push(`${request.kind}:${argv.join(' ')}`);
        if (request.kind === 'restic') {
            if (argv.includes('config')) return complete(JSON.stringify({ id: options.wrongRepository ? 'f'.repeat(64) : repositoryId, version: 2 }));
            if (argv.includes('snapshots')) return complete(JSON.stringify([{ id: source.snapshot.snapshotId, tree: source.snapshot.treeId,
                hostname: source.snapshot.hostname, time: source.snapshot.time, paths: source.snapshot.paths, tags: source.snapshot.tags }]));
            if (argv.includes('blob')) return complete(JSON.stringify({ nodes: [{ name: 'db.dump', type: 'file', size: 123 }] }));
            return { ...complete(), stdoutChecksumSha256: checksum, stdoutBytes: 123 };
        }
        if (request.kind === 'restoreStream') return { ...complete(), exitCode: options.streamFails ? 1 : 0,
            ...(options.streamFails ? { stderr: 'pg_restore: native import failed [REDACTED]', stderrTruncated: false } : {}),
            producer: { exitCode: 0, checksumSha256: checksum, bytes: 123 } };
        if (request.kind === 'health') return { kind: 'health', status: options.healthFails ? 'unhealthy' : 'healthy' };
        if (request.kind === 'writers') {
            writersRunning = request.operation === 'start';
            if (request.operation === 'stop') options.abortAfterWriterStop?.abort();
            if (request.operation === 'start' && ++startCount === 1 && options.unknownFirstWriterStart) return { kind: 'outcome_unknown' };
            return complete();
        }
        if (argv[0] === 'createdb') {
            if (names.has('restore_stage')) return { ...complete(), exitCode: 1 };
            names.add('restore_stage'); return complete();
        }
        if (request.kind === 'integrity') return { ...complete(), exitCode: options.integrityFails ? 1 : 0 };
        const sql = argv.at(-1) ?? '';
        if (sql.startsWith('SELECT current_user =')) return complete('t');
        if (sql.startsWith('SELECT')) return options.unknownObservation && names.has('restore_old') ? { kind: 'outcome_unknown' }
            : complete(JSON.stringify([...names]));
        const match = /ALTER DATABASE "([^"]+)" RENAME TO "([^"]+)"/u.exec(sql);
        if (match) {
            if (writersRunning) return { ...complete(), exitCode: 1 };
            const [, from, to] = match;
            if (!names.has(from!) || names.has(to!)) return { ...complete(), exitCode: 1 };
            if (options.failSecondRename && from === 'restore_stage') return { ...complete(), exitCode: 1 };
            names.delete(from!); names.add(to!);
            if (from === 'app') options.abortAfterFirstRename?.abort();
            if (from === 'restore_stage') options.abortAfterActivation?.abort();
            if (options.unknownActivation && from === 'restore_stage') return { kind: 'outcome_unknown' };
        }
        return complete();
    };
    return { execute, effects, get names() { return [...names].sort(); }, get writersRunning() { return writersRunning; },
        get callsAfterAbort() { return callsAfterAbort; }, setNativeSignal(signal: AbortSignal) { nativeSignal = signal; } };
}

it.each([false, true])('records sqlite source validation within safety (fails=%s)', async fails => {
    const native = boundary();
    const input: DeploymentRestorePrepareInputV1 = {
        operationId: 'sqlite-prepare', source: manifest, sourceFormat: 'sqlite', access,
        destination: { environmentId: 'target', revision: 2, service: 'db', adapter: 'sqlite-v1',
            path: '/data/app.sqlite', stagingVolume: 'sqlite-staging', hasMeaningfulData: false, writerServices: ['web'] },
        signal: new AbortController().signal,
        async execute(request) {
            if (request.kind === 'sqliteStage') return { ...complete(), exitCode: fails ? 1 : 0 };
            return native.execute(request);
        },
    };
    if (fails) {
        await expect(owners.prepareDeploymentRestoreV1(input)).rejects.toMatchObject({ code: 'restore_failed',
            details: { steps: [{ id: 'safety', status: 'failed' }] } });
    } else {
        const receipt = await owners.prepareDeploymentRestoreV1(input);
        expect(receipt.steps?.every(step => DeploymentRestoreStepV1Schema.safeParse(step).success)).toBe(true);
        expect(receipt.steps).toEqual([{ id: 'safety', status: 'skipped' }]);
    }
});

async function prepare(native: ReturnType<typeof boundary>, overrides: Partial<DeploymentRestorePrepareInputV1> = {}) {
    return owners.prepareDeploymentRestoreV1({ operationId: 'prepare-1', source: manifest, sourceFormat: 'postgresCustom', destination, access, signal: new AbortController().signal,
        execute: native.execute, ...overrides });
}
async function confirm(native: ReturnType<typeof boundary>, receipt: DeploymentRestorePrepareReceiptV1, overrides: Partial<DeploymentRestoreConfirmInputV1> = {}) {
    return owners.confirmDeploymentRestoreV1({ prepare: receipt, source: manifest, sourceFormat: 'postgresCustom', destination, access, signal: new AbortController().signal,
        execute: native.execute,
        // Host port only: real cancellation forwarding is exercised by the CLI
        // composed test through createMachineNativeEffectAdmission, not emulated here.
        runProtectedStage: effect => effect(), ...overrides });
}

describe('exact PostgreSQL restore semantic owner', () => {
    it('prepares an admitted SQL upload without repository credentials or effects', async () => {
        const native = boundary();
        const source = { kind: 'upload', transferId: 'completed-requester-upload', sizeBytes: 48,
            sha256: '7'.repeat(64) } as const;
        // The finite-transfer owner lends this host-private capture. Reflect
        // crosses the currently unsupported runtime variant, rather than
        // fabricating a repository manifest or weakening production types.
        const receipt: unknown = await Reflect.apply(owners.prepareDeploymentRestoreV1, undefined, [{
            operationId: 'upload-prepare', source, sourceFormat: 'postgresSql', destination,
            signal: new AbortController().signal, execute: native.execute,
        }]);
        expect(receipt).toMatchObject({ kind: 'prepared', source, sourceFormat: 'postgresSql', destination });
        expect(native.effects).toEqual([]);
        expect(receipt).not.toHaveProperty('repository');
    });

    it('retains the previous-volume recovery action when native activation and rollback both fail', async () => {
        const volumeSource: DeploymentBackupManifestV1 = { ...manifest, kind: 'volume', producerChecksumSha256: undefined,
            snapshot: { ...manifest.snapshot, paths: ['/happier/source'],
                tags: ['happier', 'env:source', 'src:main', 'kind:volume'] } };
        const volumeDestination = { environmentId: 'target', revision: 2, service: 'web', adapter: 'volume-v1' as const,
            volume: 'content', currentVolume: 'old-content', stagingVolume: 'new-content', hasMeaningfulData: false,
            writerServices: ['web'], runningServices: ['web'] };
        const native = boundary({ source: volumeSource });
        const switches: string[] = [];
        const execute: DeploymentRestorePrepareInputV1['execute'] = async request => {
            if (request.kind === 'stageVolume') return complete();
            if (request.kind === 'switchVolume') {
                switches.push(request.physicalName);
                throw Object.assign(new Error('Engine activation unavailable'), { code: 'native_failed',
                    failureCause: { phase: request.physicalName === volumeDestination.stagingVolume
                        ? 'deployment.native.compose.native_compose_command_failed' : 'deployment.native.rollback.failed',
                        errorClass: 'Error', errorCode: 'native_compose_command_failed', httpStatus: null } });
            }
            return native.execute(request);
        };
        const capture = { source: volumeSource, sourceFormat: 'volume' as const, destination: volumeDestination, access,
            signal: new AbortController().signal, execute };
        const prepared = await owners.prepareDeploymentRestoreV1({ ...capture, operationId: 'volume-restore' });
        const result = await owners.confirmDeploymentRestoreV1({ ...capture, prepare: prepared, runProtectedStage: effect => effect() });
        expect(result).toMatchObject({ kind: 'recoveryRequired', verified: false, nextAction: 'restorePreviousVolume',
            destination: { currentVolume: 'old-content', stagingVolume: 'new-content' }, code: 'restore_failed',
            failureCause: { phase: 'deployment.native.compose.native_compose_command_failed',
                errorCode: 'native_compose_command_failed' } });
        expect(switches).toEqual(['new-content', 'old-content']);
    });

    it.each([false, true])('copies a produced capture using only destination native effects (import failure: %s)', async streamFails => {
        const backup = safetyBackup();
        const produced = await owners.runDeploymentBackupV1({ ...backup,
            restoreTargets: [{ environmentId: backup.environmentId, service: 'db', adapter: 'postgres-v1', database: 'app' }] });
        const capture = produced.restoreCaptures?.[0];
        if (!capture) throw new Error('Expected the original backup producer capture');
        const copyDestination = { ...destination, environmentId: 'copy-target', service: 'copy-db', writerServices: ['preview-web'] };
        const resolved = owners.resolveDeploymentRestoreCaptureV1({ environmentId: copyDestination.environmentId,
            restoreBackupId: capture.source.snapshot.snapshotId, capture, destination: copyDestination,
            copy: { source: { environmentId: capture.source.environmentId, ...capture.target }, destination: copyDestination } });
        expect(resolved.kind).toBe('resolved');
        if (resolved.kind !== 'resolved') throw new Error('Expected admitted copy mapping');
        const native = boundary({ source: capture.source, streamFails });
        // Only native IO is substituted. A source service command would fail this
        // boundary before it could stop writers or rename production databases.
        const execute: DeploymentRestorePrepareInputV1['execute'] = async request => {
            if (request.kind === 'service' || request.kind === 'integrity' || request.kind === 'health')
                expect(request.service).toBe(copyDestination.service);
            if (request.kind === 'restoreStream') expect(request.consumer.service).toBe(copyDestination.service);
            if (request.kind === 'writers') expect(request.services).toEqual(['preview-web']);
            return native.execute(request);
        };
        const prepared = await prepare(native, { ...resolved.capture, execute });
        const result = await confirm(native, prepared, { ...resolved.capture, execute });
        expect(result.kind).toBe(streamFails ? 'recoveryRequired' : 'restored');
        expect(result.source).toEqual(capture.source);
        expect(result.destination).toEqual(copyDestination);
        expect(native.writersRunning).toBe(true);
        expect(native.names).toEqual(streamFails ? ['app', 'restore_stage'] : ['app', 'restore_old']);
    });

    it('resolves and restores an encoded canonical source capture against its matching configuration', async () => {
        const selected = createDeploymentDumpBackupSourceV1('db');
        const source: DeploymentBackupManifestV1 = { ...manifest, sourceId: selected.sourceId,
            snapshot: { ...manifest.snapshot, tags: ['happier', 'env:source', 'kind:dump',
                `src-v1:${encodeURIComponent(selected.sourceId)}`] } };
        const currentDestination = { ...destination, environmentId: 'source' };
        const resolved = owners.resolveDeploymentRestoreCaptureV1({ environmentId: 'source', restoreBackupId: snapshotId,
            destination: currentDestination, capture: { source, sourceFormat: 'postgresCustom',
                target: { service: 'db', adapter: 'postgres-v1', database: 'app' },
                configuration: { ...safetyBackup().configuration, sources: [selected],
                    ownership: { environmentId: 'source', prefix: 'source' } },
                repository: { repository: access.repository } } });
        expect(resolved.kind).toBe('resolved');
        if (resolved.kind !== 'resolved') throw new Error('Expected the encoded source capture to remain restorable');
        const native = boundary({ source });
        const receipt = await prepare(native, resolved.capture);
        expect(await confirm(native, receipt, resolved.capture)).toMatchObject({ kind: 'restored', verified: true,
            source: { sourceId: selected.sourceId, snapshot: { snapshotId } } });
    });

    it('restores an exact retained scheduled manifest through the existing safety and confirmation lifecycle', async () => {
        const backup = safetyBackup();
        const captured = await owners.runDeploymentBackupV1({ ...backup,
            ...{ restoreTargets: [{ environmentId: 'source', service: 'db', adapter: 'postgres-v1' as const, database: 'app' }] } });
        const captures = captured.restoreCaptures;
        expect(captures).toEqual([{ source: captured.manifests[0], sourceFormat: 'postgresCustom',
            target: { service: 'db', adapter: 'postgres-v1', database: 'app' }, configuration: backup.configuration,
            repository: { repository: access.repository } }]);
        const capture = captures?.[0];
        if (!capture) throw new Error('Expected the original scheduled capture');
        const currentConfiguration = { ...backup.configuration, configRevision: 2 };
        const original = owners.resolveDeploymentRestoreCaptureV1({ environmentId: 'target',
            restoreBackupId: capture.source.snapshot.snapshotId, destination, capture });
        expect(original.kind).toBe('resolved');
        if (original.kind !== 'resolved') throw new Error('Expected the original scheduled capture to remain restorable');
        expect(original.capture).toMatchObject({ source: capture.source, configuration: { configRevision: 1 },
            destination: { service: 'db', database: 'app' }, repository: { repository: access.repository } });
        expect(currentConfiguration.configRevision).toBe(2);
        const capturedNative = boundary({ source: capture.source });
        const capturedReceipt = await prepare(capturedNative, original.capture);
        expect(await confirm(capturedNative, capturedReceipt, original.capture)).toMatchObject({ kind: 'restored', verified: true,
            source: { snapshot: { snapshotId: capture.source.snapshot.snapshotId } } });
        const currentDestination = { ...destination, environmentId: 'source' };
        const resolved = owners.resolveDeploymentRestoreCaptureV1({ environmentId: 'source', restoreBackupId: manifest.snapshot.snapshotId,
            destination: currentDestination, ...{ manifest, configuration: { ...currentConfiguration,
                ownership: { environmentId: 'source', prefix: 'source' } },
                repository: { repository: access.repository } } });
        expect(resolved.kind).toBe('resolved');
        if (resolved.kind !== 'resolved') throw new Error('Expected exact retained scheduled source');
        const native = boundary();
        const receipt = await prepare(native, resolved.capture);
        expect(await confirm(native, receipt, resolved.capture)).toMatchObject({ kind: 'restored', verified: true,
            source: { snapshot: { snapshotId } } });
    });

    it('pushes real restore step facts before native work settles and retains them in the final receipt', async () => {
        const native = boundary();
        const pushed: { id: string; status: string }[] = [];
        const onStep = (step: { id: string; status: string }) => { pushed.push(step); };
        const receipt = await prepare(native, { ...{ onStep } });
        const result = await confirm(native, receipt, { ...{ onStep }, execute: async request => {
            if (request.kind === 'restoreStream') expect(pushed.at(-1)).toEqual({ id: 'restore', status: 'running' });
            if (request.kind === 'writers') expect(pushed.at(-1)).toEqual({ id: request.operation === 'stop' ? 'stop' : 'start', status: 'running' });
            if (request.kind === 'health') expect(pushed.at(-1)).toEqual({ id: 'health', status: 'running' });
            return native.execute(request);
        } });
        expect(receipt).toMatchObject({ steps: [{ id: 'safety', status: 'skipped' }] });
        expect(result).toMatchObject({ kind: 'restored', steps: [
            { id: 'safety', status: 'skipped' }, { id: 'restore', status: 'completed' },
            { id: 'stop', status: 'completed' }, { id: 'start', status: 'completed' }, { id: 'health', status: 'completed' },
        ] });
        expect(pushed.filter(step => step.id === 'health')).toEqual([
            { id: 'health', status: 'running' }, { id: 'health', status: 'completed' },
        ]);
    });

    it('keeps completed safety evidence and the failed restore step without claiming later steps ran', async () => {
        const native = boundary({ streamFails: true });
        const target = { ...destination, hasMeaningfulData: true };
        const receipt = await prepare(native, { destination: target, safetyBackup: safetyBackup() });
        expect(await confirm(native, receipt, { destination: target })).toMatchObject({ kind: 'recoveryRequired', steps: [
            { id: 'safety', status: 'completed' }, { id: 'restore', status: 'failed' },
        ] });
    });

    it('verifies the exact repository source, stages and checks before activation, and verifies health before restored', async () => {
        const native = boundary();
        const receipt = await prepare(native);
        expect(receipt).toMatchObject({ operationId: 'prepare-1', source: { repositoryId, snapshot: { snapshotId } }, destination });
        expect(native.effects.every(effect => effect.startsWith('restic:'))).toBe(true);
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'restored', verified: true, source: { snapshot: { snapshotId } }, destination });
        const stage = native.effects.findIndex(effect => effect.startsWith('restoreStream:'));
        const activation = native.effects.findIndex(effect => effect.includes('ALTER DATABASE'));
        expect(stage).toBeGreaterThan(-1);
        expect(activation).toBeGreaterThan(stage);
        expect(native.effects.filter(effect => effect.startsWith('integrity:'))).toHaveLength(2);
        expect(native.effects.filter(effect => effect.includes('SELECT COALESCE(json_agg(datname)'))).toHaveLength(1);
        expect(native.names).toEqual(['app', 'restore_old']);
    });

    it('requires a real verified safety backup before prepare can replace meaningful data', async () => {
        const native = boundary();
        await expect(prepare(native, { destination: { ...destination, hasMeaningfulData: true } }))
            .rejects.toMatchObject({ code: 'backup_required', details: { steps: [{ id: 'safety', status: 'failed' }] } });
        expect(native.effects).toEqual([]);
    });

    it('carries the canonical backup producer exact recovery snapshot and never accepts failed safety capture', async () => {
        const native = boundary(); const target = { ...destination, hasMeaningfulData: true };
        const receipt = await prepare(native, { destination: target, safetyBackup: safetyBackup() });
        expect(receipt).toMatchObject({ safetyBackup: { kind: 'verified', manifests: [{ environmentId: 'target', snapshot: { snapshotId: 'e'.repeat(64) } }] } });
        expect(await confirm(native, receipt, { destination: target })).toMatchObject({ kind: 'restored', verified: true,
            safetyBackup: { manifests: [{ snapshot: { snapshotId: 'e'.repeat(64) } }] } });
        await expect(prepare(boundary(), { destination: target, safetyBackup: safetyBackup(1) })).rejects.toMatchObject({ code: 'backup_failed' });
    });

    it('retains the exact safety backup settlement when Stop arrives after its canonical final check', async () => {
        const native = boundary(); const controller = new AbortController();
        const target = { ...destination, hasMeaningfulData: true };
        let retained: DeploymentPreMigrationBackupV1 | undefined;
        const backup: DeploymentBackupRunInputV1 = { ...safetyBackup(), preMigrationBackup: {
            sourceFormat: 'postgresCustom', target: { service: target.service, adapter: target.adapter, database: target.database },
            async writeCapture(capture) {
                // Substitute receipt persistence, which follows the child's canonical final check.
                retained = capture;
                controller.abort();
            },
        } };
        await expect(prepare(native, { destination: target, safetyBackup: backup, signal: controller.signal })).resolves.toMatchObject({
            kind: 'prepared', destination: target, safetyBackup: { kind: 'verified', manifests: [{ environmentId: 'target',
                snapshot: { snapshotId: 'e'.repeat(64) }, producerChecksumSha256: checksum }] },
        });
        expect(retained?.source).toMatchObject({ environmentId: 'target', snapshot: { snapshotId: 'e'.repeat(64) } });
        expect(controller.signal.aborted).toBe(true);
        expect(native.names).toEqual(['app']);
        expect(native.effects.every(effect => effect.startsWith('restic:'))).toBe(true);
    });

    it('retains child recovery evidence when Stop precedes the safety backup settlement', async () => {
        const native = boundary(); const controller = new AbortController();
        const backup = safetyBackup(0, () => controller.abort());
        await expect(prepare(native, { destination: { ...destination, hasMeaningfulData: true }, safetyBackup: backup,
            signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled', details: {
            manifests: [{ environmentId: 'target', snapshot: { snapshotId: 'e'.repeat(64) } }],
        } });
        expect(native.names).toEqual(['app']);
        expect(native.effects.every(effect => effect.startsWith('restic:'))).toBe(true);
    });

    it('rejects a different source or destination before any confirm mutation', async () => {
        const native = boundary(); const receipt = await prepare(native); native.effects.length = 0;
        await expect(confirm(native, receipt, { source: { ...manifest, snapshot: { ...manifest.snapshot, snapshotId: 'e'.repeat(64) } } }))
            .rejects.toMatchObject({ code: 'stale_input' });
        await expect(confirm(native, receipt, { destination: { ...destination, revision: 3 } }))
            .rejects.toMatchObject({ code: 'stale_input' });
        expect(native.effects).toEqual([]);
    });

    it('accepts the same exact receipt after JSON transport changes object property order', async () => {
        const native = boundary(); const receipt = await prepare(native);
        const { snapshot, ...sourceFields } = receipt.source;
        const reordered = { ...receipt, source: { snapshot, ...sourceFields } };
        expect(await confirm(native, reordered)).toMatchObject({ kind: 'restored', verified: true });
    });

    it('refuses a source opened from a different repository before any destination effect', async () => {
        const native = boundary({ wrongRepository: true });
        await expect(prepare(native)).rejects.toMatchObject({ code: 'backup_integrity_failed' });
        expect(native.effects.every(effect => effect.startsWith('restic:'))).toBe(true);
    });

    it('never activates a failed import and preserves the original database', async () => {
        const native = boundary({ streamFails: true }); const receipt = await prepare(native);
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'recoveryRequired', verified: false, code: 'restore_failed',
            nativeFailure: { exitCode: 1, stderr: 'pg_restore: native import failed [REDACTED]', stderrTruncated: false } });
        expect(native.names).toContain('app');
        expect(native.effects.some(effect => effect.includes('ALTER DATABASE'))).toBe(false);
    });

    it('does not activate a staged database whose integrity check fails', async () => {
        const native = boundary({ integrityFails: true }); const receipt = await prepare(native);
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'recoveryRequired', verified: false });
        expect(native.effects.some(effect => effect.includes('ALTER DATABASE'))).toBe(false);
    });

    it('restores the incumbent name after a known half-swap or failed activated health', async () => {
        for (const options of [{ failSecondRename: true }, { healthFails: true }]) {
            const native = boundary(options); const receipt = await prepare(native);
            expect(await confirm(native, receipt)).toMatchObject({ kind: 'rolledBack', verified: false });
            expect(native.names).toEqual(['app', 'restore_stage']);
        }
    });

    it('observes names after unknown activation and never blindly replays it', async () => {
        const native = boundary({ unknownActivation: true }); const receipt = await prepare(native);
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'rolledBack', verified: false });
        expect(native.names).toEqual(['app', 'restore_stage']);
        const unknown = boundary({ unknownActivation: true, unknownObservation: true }); const other = await prepare(unknown);
        expect(await confirm(unknown, other)).toMatchObject({ kind: 'outcome_unknown', verified: false, nextAction: 'observeDatabaseNames' });
        expect(unknown.effects.filter(effect => effect.includes('ALTER DATABASE'))).toHaveLength(2);
    });

    it('local cancellation prevents mutation and unsupported adapters never claim native readiness', async () => {
        const native = boundary(); const receipt = await prepare(native); native.effects.length = 0;
        const abort = new AbortController(); abort.abort();
        expect(await confirm(native, receipt, { signal: abort.signal })).toMatchObject({ kind: 'recoveryRequired', verified: false, code: 'cancelled' });
        expect(native.effects).toEqual([]);
        // External malformed/unsupported adapter input is refused, not activated.
        await expect(prepare(native, { destination: { ...destination, adapter: 'mysql-v1' as 'postgres-v1' } })).rejects.toMatchObject({ code: 'unsupported_action' });
    });

    it('performs no native recovery after force-stop and repairs the half-swap at the next admission', async () => {
        const abort = new AbortController(); const native = boundary({ abortAfterFirstRename: abort, nativeSignal: abort.signal });
        const receipt = await prepare(native);
        expect(await confirm(native, receipt, { signal: abort.signal })).toMatchObject({ verified: false, code: 'cancelled' });
        expect(native.names).toEqual(['restore_old', 'restore_stage']);
        expect(native.callsAfterAbort).toBe(0);
        const nextAdmission = new AbortController(); native.setNativeSignal(nextAdmission.signal);
        native.effects.length = 0;
        expect(await confirm(native, receipt, { signal: nextAdmission.signal })).toMatchObject({ kind: 'rolledBack', verified: false });
        expect(native.names).toEqual(['app', 'restore_stage']);
        expect(native.writersRunning).toBe(true);
        expect(native.effects.some(effect => effect.includes('createdb') || effect.startsWith('restoreStream:'))).toBe(false);
        expect(native.effects.filter(effect => effect.includes('SELECT COALESCE(json_agg(datname)'))).toHaveLength(1);
    });

    it('repairs a crash half-swap at the next restore admission before attempting a new import', async () => {
        const native = boundary({ initialNames: ['restore_old', 'restore_stage'] }); const receipt = await prepare(native);
        native.effects.length = 0;
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'rolledBack', verified: false });
        expect(native.names).toEqual(['app', 'restore_stage']);
        expect(native.writersRunning).toBe(true);
        expect(native.effects.some(effect => effect.includes('createdb') || effect.startsWith('restoreStream:'))).toBe(false);
    });

    it('restarts writers on next admission after force-stop just before the first rename', async () => {
        const abort = new AbortController(); const native = boundary({ abortAfterWriterStop: abort, nativeSignal: abort.signal });
        const receipt = await prepare(native);
        expect(await confirm(native, receipt, { signal: abort.signal })).toMatchObject({ verified: false, code: 'cancelled' });
        expect(native.names).toEqual(['app', 'restore_stage']);
        expect(native.writersRunning).toBe(false);
        expect(native.callsAfterAbort).toBe(0);
        const nextAdmission = new AbortController(); native.setNativeSignal(nextAdmission.signal);
        native.effects.length = 0;
        expect(await confirm(native, receipt, { signal: nextAdmission.signal })).toMatchObject({ kind: 'recoveryRequired', nextAction: 'inspectStagingDatabase' });
        expect(native.names).toEqual(['app', 'restore_stage']);
        expect(native.writersRunning).toBe(true);
        expect(native.effects.some(effect => effect.includes('ALTER DATABASE') || effect.includes('createdb') || effect.startsWith('restoreStream:'))).toBe(false);
    });

    it('undoes a crash activation into a previously absent database at the next admission', async () => {
        const abort = new AbortController(); const native = boundary({ initialNames: [], abortAfterActivation: abort, nativeSignal: abort.signal });
        const empty = { ...destination, databaseExists: false };
        const receipt = await prepare(native, { destination: empty });
        expect(await confirm(native, receipt, { destination: empty, signal: abort.signal })).toMatchObject({ verified: false, code: 'cancelled' });
        expect(native.names).toEqual(['app']);
        expect(native.callsAfterAbort).toBe(0);
        const nextAdmission = new AbortController(); native.setNativeSignal(nextAdmission.signal);
        native.effects.length = 0;
        expect(await confirm(native, receipt, { destination: empty, signal: nextAdmission.signal })).toMatchObject({ kind: 'rolledBack', verified: false });
        expect(native.names).toEqual(['restore_stage']);
        expect(native.writersRunning).toBe(true);
        expect(native.effects.some(effect => effect.includes('createdb') || effect.startsWith('restoreStream:'))).toBe(false);
    });

    it('stops possibly resumed writers again before recovery after a lost start acknowledgement', async () => {
        const native = boundary({ unknownFirstWriterStart: true }); const receipt = await prepare(native);
        expect(await confirm(native, receipt)).toMatchObject({ kind: 'rolledBack', verified: false });
        expect(native.names).toEqual(['app', 'restore_stage']);
    });
});
