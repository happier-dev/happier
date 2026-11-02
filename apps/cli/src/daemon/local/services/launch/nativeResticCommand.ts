import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentExecEnvAttachmentV1, ExecService } from '@happier-dev/plugin-sdk/exec';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk/services';
import type { DeploymentImageV1 } from '@happier-dev/deployment-protocol';
import { RESTIC_RUNTIME_V1, type ResticRequestV1 } from '@happier-dev/deployments';
import { authorizePluginExecLaunchForHost, type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import { admitNativeServiceCommandForHost, type AdmittedServiceExecContextV1 } from './serviceCommand';
import { machineNativeEffectAdmission, type MachineNativeEffectContext } from './machineNativeEffectAdmission';
import { normalizeNativeComposePlatform } from './nativeComposeImageIdentity';
import type { createNativeComposeImageIdentity } from './nativeComposeImageIdentity';
import type { NativeComposeProjectRender } from './nativeComposeLifecycle';

export type NativeResticCommandInput = Readonly<{
    render: NativeComposeProjectRender; context: MachineNativeEffectContext;
    runtimeImage: DeploymentImageV1; request: ResticRequestV1;
    destinationAttachment: DeploymentExecEnvAttachmentV1;
    /** Absent for repository metadata/dump; volume names are native model keys. */
    selector?: Readonly<{ kind: 'volume'; sourceId: string; service: string; volume: string; consistency: 'stopDuringCopy' }>;
    signal?: AbortSignal;
}>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = (): never => { throw new PluginError({ code: 'service_admission_unavailable',
    message: 'The admitted native restic operation is unavailable' }); };
// Docker --mount is CSV, not shell syntax. Quote the whole field, never a path fragment.
const csv = (value: string) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** Third operation arm of the existing native owner; no public Docker argv or runner. */
export async function admitNativeResticCommand(input: NativeResticCommandInput, owner: Readonly<{
    source: DeploymentSourceMaterializationV1; exec: ExecService; io: ProjectNativeToolchainIo;
    model: Record<string, unknown>; identity: ReturnType<typeof createNativeComposeImageIdentity>;
    assertCurrent(): Promise<void>;
    containerIds(): readonly string[];
    run(args: readonly string[]): Promise<Readonly<{ stdout: string }>>;
}>): Promise<AdmittedServiceExecContextV1> {
    return machineNativeEffectAdmission.runStage(input.context, async () => {
        const signal = input.signal ?? input.context.operation.signal;
        signal?.throwIfAborted();
        await owner.assertCurrent();
        const { runtimeImage, request, selector } = input;
        const index = RESTIC_RUNTIME_V1.image.split('@')[1];
        if (request.runtime.image !== RESTIC_RUNTIME_V1.image || request.runtime.version !== RESTIC_RUNTIME_V1.version
            || request.runtime.repositoryVersion !== RESTIC_RUNTIME_V1.repositoryVersion
            || runtimeImage.indexDigest !== index && runtimeImage.manifestDigest !== index
            || normalizeNativeComposePlatform(runtimeImage.platform) !== normalizeNativeComposePlatform(input.render.platform)
            || !runtimeImage.registryReference) return refuse();
        const mounts: string[] = [];
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
                || mounted.some(row => row.status !== 'exited' && row.status !== 'dead')) return refuse();
            mounts.push('--mount', ['type=volume', `source=${volume.name}`, `target=${mount.target}`, 'readonly', 'volume-nocopy'].map(csv).join(','));
        }
        for (const file of request.credentialFiles) {
            if (file.readOnly !== true) return refuse();
            const path = await realpath(file.hostPath);
            await access(path, constants.R_OK);
            mounts.push('--mount', ['type=bind', `source=${path}`, `target=${file.containerPath}`, 'readonly'].map(csv).join(','));
        }
        if (!request.credentialFiles.some(file => file.containerPath === request.passwordFilePath)) return refuse();
        await owner.identity.prove(runtimeImage.registryReference, runtimeImage);
        const name = `happier-op-${createHash('sha256').update(JSON.stringify([
            owner.source.environmentInstanceId, input.context.operation.operationId, request.argv])).digest('hex')}`;
        const createArgs = ['create', '--interactive', '--pull', 'never', '--name', name,
            '--label', `happier.operation=${name}`, ...mounts, '--env', `RESTIC_PASSWORD_FILE=${request.passwordFilePath}`,
            ...request.environmentVariableNames.flatMap(value => ['--env', value]), runtimeImage.registryReference, ...request.argv];
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
                cwd: owner.source.rootPath, deploymentEnv: input.destinationAttachment }, signal ? { signal } : undefined);
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
            ...(request.argv[2] !== '--json' ? { rawStdout: true } : {}),
            assertCurrent: owner.assertCurrent, stopNative, observeNativeSettlement,
            async launch() {
                try {
                    const id = await construct();
                    signal?.throwIfAborted();
                    startLaunch = await authorizePluginExecLaunchForHost(owner.exec, { executable: tool.executable,
                        args: ['start', '--attach', '--interactive', id], cwd: owner.source.rootPath }, signal ? { signal } : undefined);
                    const created = createLaunch!;
                    if (startLaunch.secretRedactionLease) created.secretRedactionLease?.add(startLaunch.secretRedactionLease.values());
                    return { ...startLaunch, secretRedactionLease: created.secretRedactionLease,
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
