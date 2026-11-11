import { createHash } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { buildResticRequestV1, type DeploymentRestoreNativeRequestV1, type DeploymentRestoreNativeResultV1,
    type DeploymentRestoreSqliteDestinationV1, type DeploymentBackupRunInputV1, type ResticRequestV1 } from '@happier-dev/deployments';
import { executeAdmittedServiceCommand, admitServiceCommandStreamForHost } from '@/daemon/local/services/launch/nativeComposeLifecycle';
import type { AdmittedServiceExecContextV1 } from '@/daemon/local/services/launch/serviceCommand';
import { admitServiceCommandInputForHost } from '@/daemon/local/services/launch/serviceCommand';
import type { NativeSqliteOperation } from '@/daemon/local/services/launch/nativeSqliteCommand';
import type { OwnServerNativeRestoreInput, OwnServerNativeUploadRestoreInput } from './nativeRestore';

type Input = Pick<OwnServerNativeRestoreInput, 'project' | 'render' | 'context'>
    & Partial<Pick<OwnServerNativeRestoreInput, 'runtimeImage' | 'readAccess'>>
    & Readonly<{ upload?: OwnServerNativeUploadRestoreInput['upload'] }>;
type Target = Readonly<{ service: string; path: string }>;
type Stage = Awaited<ReturnType<Input['project']['openVolumeRestoreStage']>>;
type SqliteRequest = Extract<DeploymentRestoreNativeRequestV1, { kind: 'sqlite' }>;
type StageRequest = Extract<DeploymentRestoreNativeRequestV1, { kind: 'sqliteStage' }>;
const fail = (code: string): never => { throw new PluginError({ code, message: 'The native SQLite operation did not settle successfully' }); };
function checked(result: DeploymentRestoreNativeResultV1) {
    if (result.kind !== 'completed') return fail('outcome_unknown');
    if (result.exitCode !== 0 || result.producer && result.producer.exitCode !== 0) return fail('backup_integrity_failed');
    return result;
}

/** SQLite is an engine variation of the existing native restore owner. Source
 * files stay on the admitted Engine; all helper processes use P30 custody. */
export function createNativeSqliteRestore(input: Input, admitRestic: (request: ResticRequestV1) => Promise<AdmittedServiceExecContextV1>) {
    const { project, render, context } = input;
    const signal = context.operation.signal;
    let runtime: ReturnType<Input['project']['prepareSqliteRuntime']> | undefined;
    let restic: ReturnType<Input['project']['prepareResticRuntime']> | undefined;
    const stages = new Map<string, Promise<Stage>>();
    const resticImage = () => input.runtimeImage ? Promise.resolve(input.runtimeImage) : restic ??= project.prepareResticRuntime({ render, context });
    const common = () => ({ render, context, signal });
    const stage = (destination: Pick<DeploymentRestoreSqliteDestinationV1, 'stagingVolume'>, operationId: string, mode: 'fresh' | 'existing') => {
        let captured = stages.get(destination.stagingVolume);
        if (!captured) {
            captured = project.openVolumeRestoreStage({ ...common(), physicalName: destination.stagingVolume, operationId, mode });
            stages.set(destination.stagingVolume, captured);
        }
        return captured;
    };
    const sqlite = async (target: Target, operation: NativeSqliteOperation, targetStage?: Stage) => {
        const helper = await (runtime ??= project.prepareSqliteRuntime({ render, context }));
        const request = { ...common(), runtimeImage: helper.image, sqlite: { ...target, operation, reference: helper.reference } };
        return executeAdmittedServiceCommand(await (targetStage ? targetStage.admit(request) : project.admitResticCommand(request)));
    };
    const integrity = async (target: Target, database: 'live' | 'restore', targetStage?: Stage) => {
        const result = checked(await sqlite(target, { kind: 'integrity', database }, targetStage));
        if (result.stdoutTruncated || result.stdout.trim() !== 'ok') return fail('backup_integrity_failed');
        return result;
    };
    return {
        async observe(target: Target, facts: Readonly<{ operationId: string; environmentId: string; revision: number;
            writerServices: readonly string[] }>): Promise<DeploymentRestoreSqliteDestinationV1> {
            const exists = await executeAdmittedServiceCommand(await project.admitResticCommand({ ...common(),
                runtimeImage: await resticImage(), file: { mode: 'exists', ...target } }));
            if (exists.kind !== 'completed') return fail('outcome_unknown');
            if (exists.exitCode !== 0 && exists.exitCode !== 1) return fail('restore_failed');
            if (exists.exitCode === 0) await integrity(target, 'live');
            return { adapter: 'sqlite-v1', ...target, environmentId: facts.environmentId, revision: facts.revision,
                stagingVolume: `happier_${createHash('sha256').update(facts.operationId).digest('hex')}_sqlite`,
                hasMeaningfulData: exists.exitCode === 0, writerServices: facts.writerServices };
        },
        async stageSource(request: StageRequest) {
            const targetStage = await stage(request.destination, request.operationId, 'fresh');
            const consumer = await targetStage.admit({ ...common(), runtimeImage: await resticImage(), file: { mode: 'write', name: 'restore' } });
            const source = request.source;
            let result;
            if (source.kind === 'upload') {
                if (!input.upload || input.upload.transferId !== source.transferId
                    || input.upload.sizeBytes !== source.sizeBytes || input.upload.sha256 !== source.sha256) return fail('stale_input');
                result = await executeAdmittedServiceCommand(admitServiceCommandInputForHost({ command: consumer,
                    source: { kind: 'native', sizeBytes: input.upload.sizeBytes, manifestHash: `sha256:${input.upload.sha256}`,
                        readChunk: input.upload.readChunk } }));
            } else {
                if (!input.readAccess) return fail('backup_required');
                result = await executeAdmittedServiceCommand(admitServiceCommandStreamForHost({ consumer,
                    producer: await admitRestic(buildResticRequestV1({ environmentId: source.environmentId, access: input.readAccess(),
                        command: { kind: 'dump', snapshotId: source.snapshot.snapshotId, path: source.snapshot.paths[0]! } })) }));
            }
            checked(result);
            return integrity(request.destination, 'restore', targetStage);
        },
        async execute(request: SqliteRequest) {
            const targetStage = await stage(request.destination, request.operationId, 'existing');
            if (request.operation === 'admitStage') return { kind: 'completed' as const, exitCode: 0, stdout: '', stdoutTruncated: false };
            if (request.operation === 'snapshotRecovery') return sqlite(request.destination, { kind: 'snapshot', destination: 'previous' }, targetStage);
            if (request.operation === 'activate' && request.destination.hasMeaningfulData) {
                const size = checked(await sqlite(request.destination, { kind: 'pageSize' }));
                if (size.stdoutTruncated || !/^\d+\s*$/u.test(size.stdout)) return fail('outcome_unknown');
                checked(await sqlite(request.destination, { kind: 'normalize', pageSize: Number(size.stdout.trim()) }, targetStage));
                await integrity(request.destination, 'restore', targetStage);
            }
            checked(await sqlite(request.destination, { kind: 'activate', source: request.operation === 'recover' ? 'previous' : 'restore' }, targetStage));
            return integrity(request.destination, 'live');
        },
        async backup(request: Parameters<DeploymentBackupRunInputV1['execute']>[0], target: Target) {
            const operationId = context.operation.operationId;
            const physicalName = `happier_${createHash('sha256').update(operationId + target.service).digest('hex')}_backup`;
            const owned = await project.openVolumeRestoreStage({ ...common(), operationId, physicalName, mode: 'fresh' });
            try {
                checked(await sqlite(target, { kind: 'snapshot', destination: 'backup' }, owned));
                return await executeAdmittedServiceCommand(admitServiceCommandStreamForHost({
                    producer: await owned.admit({ ...common(), runtimeImage: await resticImage(), file: { mode: 'read', name: 'backup' } }),
                    consumer: await admitRestic(request) }));
            } finally { await project.settleNative(); await owned.dispose(); }
        },
    };
}
