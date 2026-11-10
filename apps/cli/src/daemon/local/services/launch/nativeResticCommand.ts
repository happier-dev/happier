import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isIP } from 'node:net';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentExecEnvAttachmentV1, DeploymentExecEnvPortV1, ExecService } from '@happier-dev/plugin-sdk/exec';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk/services';
import type { DeploymentImageV1 } from '@happier-dev/deployment-protocol';
import type { StoragePathCapacityV1 } from '@happier-dev/protocol/storage/storageV1';
import { RESTIC_RUNTIME_V1, RESTIC_VOLUME_SOURCE_PATH_V1, RESTIC_VOLUME_STAGE_PATH_V1, type ResticRequestV1, type ResticAccessV1, type DeploymentBackupNativeResultV1 } from '@happier-dev/deployments';
import { authorizePluginExecLaunchForHost, type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { admitNativeServiceCommandForHost, executeAdmittedServiceCommand, type AdmittedServiceExecContextV1 } from './serviceCommand';
import { machineNativeEffectAdmission, type MachineNativeEffectContext, type MachineNativeEffectOperation } from './machineNativeEffectAdmission';
import { createNativeComposeImageIdentity, normalizeNativeComposePlatform } from './nativeComposeImageIdentity';
import { readNativeComposeEngine } from './nativeComposeEngine';
import type { NativeComposeProjectRender } from './nativeComposeLifecycle';
import { refuseNativeResticHostNetwork } from './nativeResticFailure';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

export type NativeResticCommandInput = Readonly<{
    render: Pick<NativeComposeProjectRender, 'engine' | 'platform' | 'projectName'>; context: MachineNativeEffectContext;
    runtimeImage: DeploymentImageV1;
    /** Absent for repository metadata/dump; volume names are native model keys. */
    selector?: Readonly<{ kind: 'volume'; sourceId: string; service: string; volume: string; consistency: 'stopDuringCopy' }>;
    signal?: AbortSignal;
}> & (Readonly<{ request: ResticRequestV1; destinationAttachment: DeploymentExecEnvAttachmentV1; archive?: never }>
    | Readonly<{ archive: Readonly<{ mode: 'list' | 'extract' }>; request?: never; destinationAttachment?: never }>);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = (): never => { throw new PluginError({ code: 'service_admission_unavailable',
    message: 'The admitted native restic operation is unavailable' }); };
// Docker --mount is CSV, not shell syntax. Quote the whole field, never a path fragment.
const csv = (value: string) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** Third operation arm of the existing native owner; no public Docker argv or runner. */
export async function admitNativeResticCommand(input: NativeResticCommandInput, owner: Readonly<{
    source: Pick<DeploymentSourceMaterializationV1, 'rootPath' | 'environmentInstanceId'>; exec: ExecService; io: ProjectNativeToolchainIo;
    model: Record<string, unknown>; identity: ReturnType<typeof createNativeComposeImageIdentity>;
    assertCurrent(): Promise<void>;
    containerIds(): readonly string[];
    /** P41 created and proved this fresh, unreferenced operation volume. */
    targetVolume?: string;
    run(args: readonly string[]): Promise<Readonly<{ stdout: string }>>;
}>): Promise<AdmittedServiceExecContextV1> {
    return machineNativeEffectAdmission.runStage(input.context, async () => {
        const signal = input.signal ?? input.context.operation.signal;
        signal?.throwIfAborted();
        await owner.assertCurrent();
        const { runtimeImage, request, selector } = input;
        const index = RESTIC_RUNTIME_V1.image.split('@')[1];
        const platform = normalizeNativeComposePlatform(input.render.platform);
        if (request && (request.runtime.image !== RESTIC_RUNTIME_V1.image || request.runtime.version !== RESTIC_RUNTIME_V1.version
            || request.runtime.repositoryVersion !== RESTIC_RUNTIME_V1.repositoryVersion)
            || runtimeImage.indexDigest !== index && runtimeImage.manifestDigest !== index
            || normalizeNativeComposePlatform(runtimeImage.platform) !== platform
            || !runtimeImage.registryReference) return refuse();
        // P45's request builder owns the fixed --repo pair. Loopback remote
        // endpoints need the selected Engine host's network namespace.
        const argv = request?.argv ?? (input.archive?.mode === 'list' ? ['-tf', '-'] : ['-xf', '-', '-C', RESTIC_VOLUME_STAGE_PATH_V1]);
        if (input.archive?.mode === 'extract' && !owner.targetVolume) return refuse();
        const repository = request?.argv[1];
        const endpoint = repository && /^s3:https?:\/\//u.test(repository) ? repository.slice(3)
            : repository?.startsWith('sftp://') ? repository : undefined;
        const hostname = endpoint ? new URL(endpoint).hostname.replace(/^\[|\]$/gu, '') : undefined;
        const hostNetwork = hostname === 'localhost' || hostname === 'localhost.' || hostname === '::1'
            || hostname !== undefined && isIP(hostname) === 4 && hostname.startsWith('127.');
        // Desktop host networking is opt-in and not represented by Engine facts.
        // Do not silently assume it, or route private endpoints through a rewrite.
        if (hostNetwork && (input.render.engine.kind !== 'native' || !platform.startsWith('linux/'))) {
            return refuseNativeResticHostNetwork();
        }
        const mounts: string[] = [];
        const repositoryPath = request?.repositoryMount ? await realpath(request.repositoryMount.hostPath) : undefined;
        if (repositoryPath) {
            if (!(await stat(repositoryPath)).isDirectory()) return refuse();
            await access(repositoryPath, constants.R_OK | constants.W_OK);
            mounts.push('--mount', ['type=bind', `source=${repositoryPath}`,
                `target=${request!.repositoryMount!.containerPath}`].map(csv).join(','));
        }
        if (owner.targetVolume) mounts.push('--mount', ['type=volume', `source=${owner.targetVolume}`,
            `target=${RESTIC_VOLUME_STAGE_PATH_V1}`, 'volume-nocopy'].map(csv).join(','));
        if (selector) {
            const definition = record(owner.model.services) ? owner.model.services[selector.service] : undefined;
            const mount = record(definition) && Array.isArray(definition.volumes) ? definition.volumes.find(
                value => record(value) && value.type === 'volume' && value.source === selector.volume) : undefined;
            const volume = record(owner.model.volumes) ? owner.model.volumes[selector.volume] : undefined;
            if (!record(mount) || typeof mount.target !== 'string' || !record(volume) || typeof volume.name !== 'string'
                || selector.consistency !== 'stopDuringCopy') return refuse();
            const ids = owner.containerIds();
            if (!ids.length) return refuse();
            const rows: unknown = JSON.parse((await owner.run(['inspect', '--type', 'container', ...ids])).stdout);
            if (!Array.isArray(rows) || rows.length !== ids.length) return refuse();
            const witnessed = rows.map((row: unknown) => {
                if (!record(row) || !ids.includes(String(row.Id)) || !record(row.Config) || !record(row.Config.Labels)
                    || row.Config.Labels['com.docker.compose.project'] !== input.render.projectName) return refuse();
                const mounts: readonly unknown[] = Array.isArray(row.Mounts) ? row.Mounts : [];
                return { service: row.Config.Labels['com.docker.compose.service'],
                    status: record(row.State) ? row.State.Status : undefined, mounts };
            });
            const mounted = witnessed.filter(row => row.mounts.some(
                value => record(value) && value.Type === 'volume' && value.Name === volume.name));
            if (!mounted.some(row => row.service === selector.service)
                || mounted.some(row => row.status !== 'exited' && row.status !== 'dead' && row.mounts.some(
                    value => record(value) && value.Type === 'volume' && value.Name === volume.name && value.RW !== false))) return refuse();
            if (repositoryPath) {
                // The bind may expose an existing base so restic init can create
                // the repository. Recursion concerns the final repository only.
                const repositoryHostPath = request?.repositoryMount?.repositoryHostPath;
                const repositorySourcePath = repositoryHostPath !== undefined ? await realpath(repositoryHostPath) : repositoryPath;
                for (const row of mounted) for (const value of row.mounts) {
                    if (!record(value) || value.Type !== 'volume' || value.Name !== volume.name) continue;
                    if (typeof value.Source !== 'string' || canonicalAbsolutePathsEqual(repositorySourcePath, value.Source)
                        || isCanonicalAbsolutePathInsideRoot(value.Source, repositorySourcePath)
                        || isCanonicalAbsolutePathInsideRoot(repositorySourcePath, value.Source)) return refuse();
                }
            }
            mounts.push('--mount', ['type=volume', `source=${volume.name}`, `target=${RESTIC_VOLUME_SOURCE_PATH_V1}`, 'readonly', 'volume-nocopy'].map(csv).join(','));
        }
        for (const file of request?.credentialFiles ?? []) {
            if (file.readOnly !== true) return refuse();
            const path = await realpath(file.hostPath);
            await access(path, constants.R_OK);
            mounts.push('--mount', ['type=bind', `source=${path}`, `target=${file.containerPath}`, 'readonly'].map(csv).join(','));
        }
        if (request && !request.credentialFiles.some(file => file.containerPath === request.passwordFilePath)) return refuse();
        await owner.identity.prove(runtimeImage.registryReference, runtimeImage);
        const name = `happier-op-${createHash('sha256').update(JSON.stringify([
            owner.source.environmentInstanceId, input.context.operation.operationId, argv])).digest('hex')}`;
        const createArgs = ['create', '--interactive', '--pull', 'never', '--name', name,
            '--label', `happier.operation=${name}`, ...(hostNetwork ? ['--network', 'host'] : []),
            ...(input.archive ? ['--read-only', '--network', 'none', '--entrypoint', '/bin/tar'] : []), ...mounts,
            ...(request ? ['--env', `RESTIC_PASSWORD_FILE=${request.passwordFilePath}`,
                ...request.environmentVariableNames.flatMap(value => ['--env', value])] : []), runtimeImage.registryReference, ...argv];
        const tool = await owner.exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose',
            cwd: owner.source.rootPath, ...(signal ? { signal } : {}) });
        let createLaunch: HostAuthorizedPluginExecLaunch | undefined;
        let startLaunch: HostAuthorizedPluginExecLaunch | undefined;
        let nativeId: string | undefined;
        let constructorDispatched = false;
        let construction: Promise<string> | undefined;
        let releasing: Promise<void> | undefined;
        let released = false;
        const native = (args: readonly string[], signal?: AbortSignal) => {
            const launch = createLaunch ?? refuse();
            const prefix = launch.nativeExecutablePrefix ?? launch.args.slice(0, launch.args.length - createArgs.length);
            return owner.io.run({ command: launch.command, args: [...prefix, ...args], cwd: launch.cwd!,
                env: launch.env, ...(signal ? { signal } : {}) });
        };
        const construct = () => construction ??= (async () => {
            signal?.throwIfAborted();
            createLaunch = await authorizePluginExecLaunchForHost(owner.exec, { executable: tool.executable, args: createArgs,
                cwd: owner.source.rootPath, deploymentEnv: input.destinationAttachment }, { agentIsolation: null, signal });
            await createLaunch.recheckInputs?.();
            signal?.throwIfAborted();
            constructorDispatched = true;
            // O-DEPLOY R2-F1: cancellation joins this finite constructor. Killing
            // its client before the Engine returns an id cannot prove absence.
            const result = await owner.io.run({ command: createLaunch.command, args: createLaunch.args,
                cwd: createLaunch.cwd!, env: createLaunch.env, ...(createLaunch.stdin ? { stdin: createLaunch.stdin } : {}) });
            if (result.exitCode !== 0 || !/^[a-f0-9]{64}$/u.test(result.stdout.trim())) return refuse();
            nativeId = result.stdout.trim();
            return nativeId;
        })();
        const read = async (signal?: AbortSignal) => {
            if (!nativeId) return refuse(); // Never infer absence from an outstanding/unknown constructor.
            const listed = await native(['ps', '--all', '--no-trunc', '--filter', `id=${nativeId}`, '--format', '{{.ID}}'], signal);
            if (listed.exitCode !== 0) return refuse();
            const ids = listed.stdout.trim().split('\n').filter(Boolean);
            if (!ids.length) return [];
            if (ids.length !== 1 || ids[0] !== nativeId) return refuse();
            const inspected = await native(['inspect', '--type', 'container', ...ids], signal);
            if (inspected.exitCode !== 0) return refuse();
            const rows: unknown = JSON.parse(inspected.stdout);
            if (!Array.isArray(rows) || rows.length !== ids.length || rows.some(row => !record(row)
                || !ids.includes(String(row.Id)) || row.Name !== `/${name}` || !record(row.State))) return refuse();
            return rows as (Record<string, unknown> & { Id: string; State: Record<string, unknown> })[];
        };
        const remove = async () => {
            const rows = await read();
            if (rows.some(row => !['created', 'exited', 'dead'].includes(String(row.State.Status)))) return refuse();
            if (rows.length && (await native(['container', 'rm', nativeId!])).exitCode !== 0) return refuse();
        };
        const stopNative = async () => {
            if (!construction) return;
            await construction;
            const rows = await read();
            if (rows.some(row => !['created', 'exited', 'dead'].includes(String(row.State.Status)))
                && (await native(['container', 'stop', nativeId!])).exitCode !== 0) return refuse();
            await remove();
        };
        const release = (): Promise<void> => {
            if (released) return Promise.resolve();
            if (releasing) return releasing;
            const work = (async () => {
                if (construction) { await construction; await remove(); }
                try { await startLaunch?.release(); } finally { await createLaunch?.release(); }
                released = true;
            })();
            releasing = work;
            // A fresh native reconciliation may join cleanup after a failed
            // removal; this is not a retry loop or replay of create/start.
            void work.catch(() => { if (releasing === work) releasing = undefined; });
            return work;
        };
        const observeNativeSettlement = async (signal?: AbortSignal) => {
            if (!construction) return true;
            if (!nativeId) return false;
            try { return (await read(signal)).every(row => ['created', 'exited', 'dead'].includes(String(row.State.Status))); }
            catch { return false; }
        };
        return admitNativeServiceCommandForHost({ context: input.context, ...(signal ? { signal } : {}),
            // P45's builder places --json after its fixed --repo pair for
            // metadata; dump alone deliberately selects raw stdout instead.
            ...(input.archive || request?.argv[2] !== '--json' ? { rawStdout: true } : {}),
            assertCurrent: owner.assertCurrent, stopNative, observeNativeSettlement,
            async launch() {
                try {
                    const id = await construct();
                    signal?.throwIfAborted();
                    startLaunch = await authorizePluginExecLaunchForHost(owner.exec, { executable: tool.executable,
                        args: ['start', '--attach', '--interactive', id], cwd: owner.source.rootPath }, { agentIsolation: null, signal });
                    const created = createLaunch!;
                    if (startLaunch.secretRedactionLease) created.secretRedactionLease?.add(startLaunch.secretRedactionLease.values());
                    return { ...startLaunch, ...(request?.stdin ? { stdin: request.stdin } : {}), secretRedactionLease: created.secretRedactionLease,
                        async recheckInputs() { await startLaunch!.recheckInputs?.(); await created.recheckInputs?.(); }, release };
                } catch (error) {
                    if (nativeId) {
                        try { await stopNative(); await release(); }
                        catch { machineNativeEffectAdmission.markUnsettled(input.context, { releaseAfterNativeSettlement: release, observeNativeSettlement }); }
                    } else if (constructorDispatched) {
                        // A failed constructor ACK has no settled id. Retain the
                        // original custody, never a successful absent-name probe.
                        machineNativeEffectAdmission.markUnsettled(input.context, { releaseAfterNativeSettlement: release, observeNativeSettlement });
                    } else {
                        await createLaunch?.release();
                        // The backup job owns the retained preparation. A failed
                        // command retires only its own P42 child loan.
                    }
                    throw error;
                }
            },
        });
    });
}

export type NativeBackupRepositoryForHostInput = Readonly<{
    cwd: string;
    directory: string;
    environmentInstanceId: string;
    projectName: string;
    operation: MachineNativeEffectOperation & Readonly<{ signal: AbortSignal }>;
    runtime: Readonly<{ exec: ExecService; nativeIo: ProjectNativeToolchainIo; settleNative(): Promise<void> }>;
    prepareDestination(signal: AbortSignal): Promise<Readonly<{
        execEnv: DeploymentExecEnvPortV1;
        readAccess(): ResticAccessV1;
        release?(): void | Promise<void>;
        capacity?: StoragePathCapacityV1;
    }>>;
}>;

/** Repository setup needs its admitted Environment/Engine, not a deployed Compose
 * generation. The pinned image, process supervision and P42 loans remain owned
 * by the same native restic command used for deployed backups and restores. */
export async function withNativeBackupRepositoryForHost<T>(input: NativeBackupRepositoryForHostInput,
    effect: (native: Readonly<{ access: ResticAccessV1; signal: AbortSignal; capacity?: StoragePathCapacityV1;
        execute(request: ResticRequestV1): Promise<DeploymentBackupNativeResultV1> }>) => Promise<T>): Promise<T> {
    const { exec, nativeIo } = input.runtime;
    const tool = await exec.systemTools.resolve({ toolId: 'docker', purpose: 'deployment-native-compose',
        cwd: input.cwd, signal: input.operation.signal });
    const run = async (args: readonly string[], signal = input.operation.signal) => {
        const launch = await authorizePluginExecLaunchForHost(exec,
            { executable: tool.executable, args, cwd: input.cwd }, { agentIsolation: null, signal });
        try {
            return await nativeIo.run({ command: launch.command, args: launch.args, cwd: launch.cwd!,
                env: launch.env, ...(launch.stdin ? { stdin: launch.stdin } : {}), signal });
        } finally { await launch.release(); }
    };
    const engine = await readNativeComposeEngine({ io: { run: request => run(request.args, request.signal) },
        command: 'docker', prefix: [], cwd: input.cwd, env: {}, signal: input.operation.signal });
    const platform = normalizeNativeComposePlatform((await run(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'])).stdout.trim());
    const identity = createNativeComposeImageIdentity({ run, directory: async () => input.directory });
    return machineNativeEffectAdmission.run({ operation: input.operation,
        keys: [{ kind: 'composeProject', dockerEndpoint: engine.id, projectName: input.projectName }],
        settleNative: input.runtime.settleNative }, async context => {
        const signal = context.operation.signal!;
        const runtimeImage = await machineNativeEffectAdmission.runStage(context, async () => {
            const [image] = await identity.resolveVariants({ service: 'restic', reference: RESTIC_RUNTIME_V1.image,
                platforms: [platform] }, { signal });
            if (!image?.registryReference) return refuse();
            await identity.acquire(image, { references: [image.registryReference], purpose: 'operationRuntime',
                authority: { context }, pull: async (_registry, reference) => {
                    const result = await run(['pull', '--platform', image.platform, reference], signal);
                    if (result.exitCode !== 0) return refuse();
                } });
            return image;
        });
        const destination = await input.prepareDestination(signal);
        let attachment: DeploymentExecEnvAttachmentV1 | undefined;
        try {
            attachment = await destination.execEnv.prepare({ backupDestination: { configKey: 'destination' } }, { signal });
            const destinationAttachment = attachment;
            return await effect({ access: destination.readAccess(), signal, ...(destination.capacity ? { capacity: destination.capacity } : {}),
                execute: request => machineNativeEffectAdmission.runStage(context, async () =>
                    executeAdmittedServiceCommand(await admitNativeResticCommand({
                        render: { engine, platform, projectName: input.projectName }, context, runtimeImage,
                        request, destinationAttachment, signal }, {
                        source: { rootPath: input.cwd, environmentInstanceId: input.environmentInstanceId },
                        exec, io: nativeIo, model: {}, identity, containerIds: () => [], run,
                        async assertCurrent() { signal.throwIfAborted(); },
                    }))),
            });
        } finally {
            try { await input.runtime.settleNative(); }
            finally { try { attachment?.dispose(); } finally { await destination.release?.(); } }
        }
    });
}
