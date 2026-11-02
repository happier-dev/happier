import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk';
import type { DeploymentExecEnvAttachmentV1, DeploymentExecEnvPortV1 } from '@happier-dev/plugin-sdk/exec';
import type { ResticAccessV1 } from '@happier-dev/deployments';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { prepareEnvironmentSecretBindingsForLaunch } from './prepareEnvironmentSecretBindingsForLaunch';

import { createProviderRedactionLease, type ProviderRedactionLease } from '@/providers/spawn/redaction';
import { readCredentialRedactionValues } from '@/plugins/runtime/invocation/services/credentialRedactionValues';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { createAttachmentRuntimeCarrierForHost, type HostDeploymentRuntimeProjectionV1,
    type HostRuntimeDockerTuple, type HostRuntimeProjectedDockerInput } from './deploymentRuntimeCarrier';
export type { HostDeploymentRuntimeProjectionV1, HostRuntimeDockerTuple, HostRuntimeProjectedDockerInput } from './deploymentRuntimeCarrier';

export type DeploymentExecEnvironmentMaterialForHost = Readonly<{
    env: Readonly<Record<string, string>>;
    secretValues: readonly string[];
    refs: readonly Readonly<{ resourceId: string; resourceRevision: number }>[];
    recheck(): Promise<void>;
    dispose(): void;
}>;

type Attachment = Readonly<{
    consume(signal?: AbortSignal, delivery?: 'runtimeProjection'): Promise<Readonly<{
        env: Readonly<Record<string, string>>;
        redaction: ProviderRedactionLease;
        refs: DeploymentExecEnvironmentMaterialForHost['refs'];
        recheck(): Promise<void>;
        retireEnvironment(): void;
        dispose(): Promise<void>;
        projectRuntime(projection: HostDeploymentRuntimeProjectionV1, host: HostRuntimeDockerTuple,
            admit: Parameters<HostDeploymentRuntimeProjectionV1['prepare']>[0]['admitNormalization'],
            signal?: AbortSignal): Promise<HostRuntimeProjectedDockerInput>;
        retainRuntimeBytes(bytes: Uint8Array): void;
        retireRuntimeFiles(): Promise<void>;
    }>>;
}>;
const attachments = new WeakMap<DeploymentExecEnvAttachmentV1, Attachment>();

function refuse(): never {
    throw new PluginError({ code: 'unavailable', message: 'Deployment execution environment is unavailable',
        details: { reason: 'deployment_attachment_unavailable' } });
}

function backupAccess(input: Readonly<{ repository: string; s3?: ResticAccessV1['s3'] }>,
    material: Awaited<ReturnType<typeof prepareEnvironmentSecretBindingsForLaunch>>): ResticAccessV1 {
    const password = material.credentialFiles.find(file => file.hostPath === material.env.RESTIC_PASSWORD_FILE);
    if (!password) return refuse();
    return { repository: input.repository, ...(input.s3 ? { s3: input.s3 } : {}), passwordFilePath: password.containerPath,
        credentialFiles: material.credentialFiles,
        environmentVariableNames: Object.keys(material.env).filter((name): name is ResticAccessV1['environmentVariableNames'][number] =>
            name === 'AWS_ACCESS_KEY_ID' || name === 'AWS_SECRET_ACCESS_KEY' || name === 'AWS_SESSION_TOKEN') };
}

/** Capture native restic metadata from the same P42 preparation that owns its
 * password file. The admitted job lends this attachment to all finite children. */
export function createDeploymentBackupEnvironmentForHost(input: Readonly<{
    repository: string;
    s3?: ResticAccessV1['s3'];
    signal: AbortSignal;
    isCurrent(): boolean;
    preparation: Omit<Parameters<typeof prepareEnvironmentSecretBindingsForLaunch>[0],
        'phase' | 'use' | 'registryUses' | 'backupDestinationUses'> & Readonly<{
            backupDestinationUses: NonNullable<Parameters<typeof prepareEnvironmentSecretBindingsForLaunch>[0]['backupDestinationUses']>;
        }>;
}>): Readonly<{ execEnv: DeploymentExecEnvPortV1; readAccess(): ResticAccessV1 }> {
    let access: ResticAccessV1 | undefined;
    const execEnv = createDeploymentExecEnvPortForHost({ signal: input.signal, isCurrent: input.isCurrent,
        backupDestination: { configKey: 'destination' }, async prepare() {
            const material = await prepareEnvironmentSecretBindingsForLaunch(input.preparation);
            try {
                access = backupAccess(input, material);
                return material;
            } catch (error) { material.dispose(); throw error; }
        } });
    return { execEnv, readAccess: () => access ?? refuse() };
}

/** Resolve a database binding and destination credentials in ONE P42 acquisition.
 * Only the host receives the nonsecret database name; native restic borrows the
 * same retained attachment, without an application environment or another grant read. */
export async function prepareDeploymentBackupEnvironmentForHost(input: Parameters<typeof createDeploymentBackupEnvironmentForHost>[0] & Readonly<{
    databaseBinding: Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }>;
}>): Promise<Readonly<{ database: string; execEnv: DeploymentExecEnvPortV1; readAccess(): ResticAccessV1; dispose(): Promise<void> }>> {
    const databaseBinding = input.databaseBinding;
    if (!databaseBinding || databaseBinding.purpose !== 'variable' || databaseBinding.phase !== 'runtime'
        || databaseBinding.source.kind === 'secret') throw new PluginError({ code: 'secret_missing',
        message: 'A nonsecret runtime database binding is required' });
    input.signal.throwIfAborted();
    const material = await prepareEnvironmentSecretBindingsForLaunch({ ...input.preparation, backupDatabaseBinding: databaseBinding });
    let current = true;
    let attachment: DeploymentExecEnvAttachmentV1 | undefined;
    try {
        const database = material.backupDatabase;
        if (!database) throw new PluginError({ code: 'secret_missing', message: 'The database binding is unavailable' });
        const access = backupAccess(input, material);
        const execEnv = createDeploymentExecEnvPortForHost({ signal: input.signal, isCurrent: () => current && input.isCurrent(),
            backupDestination: { configKey: 'destination' }, async prepare() { return material; } });
        // Transfer the eager database/credential acquisition to the canonical
        // attachment owner before returning. It defers retirement for native loans.
        attachment = await execEnv.prepare({ backupDestination: { configKey: 'destination' } });
        return { database, execEnv, readAccess: () => current && !input.signal.aborted ? access : refuse(),
            async dispose() { current = false; attachment!.dispose(); } };
    } catch (error) { material.dispose(); throw error; }
}

/** Host composition supplies admission/materialization; plugins receive only prepare/dispose. */
export function createDeploymentExecEnvPortForHost(input: Readonly<{
    signal: AbortSignal;
    isCurrent(): boolean;
}> & (Readonly<{
    source: DeploymentSourceMaterializationV1;
    phase: 'build' | 'runtime';
    prepare(input: Readonly<{ phase: 'build' | 'runtime'; signal: AbortSignal }>): Promise<DeploymentExecEnvironmentMaterialForHost>;
}> | Readonly<{
    /** Produced by environmentSecretBindingIdentityV1 from the host-admitted current row. */
    bindingIdentity: string;
    prepare(input: Readonly<{ bindingIdentity: string; signal: AbortSignal }>): Promise<DeploymentExecEnvironmentMaterialForHost>;
}> | Readonly<{
    /** Current host-admitted destination; its roles stay inside preparation custody. */
    backupDestination: Readonly<{ configKey: 'destination' }>;
    prepare(input: Readonly<{ configKey: 'destination'; signal: AbortSignal }>): Promise<DeploymentExecEnvironmentMaterialForHost>;
}>)): DeploymentExecEnvPortV1 {
    const sourceInput = 'source' in input ? input : undefined;
    const operationalInput = 'bindingIdentity' in input ? input : undefined;
    const backupInput = 'backupDestination' in input ? input : undefined;
    const backupConfigKey = backupInput?.backupDestination.configKey;
    let backupAttachment: Promise<DeploymentExecEnvAttachmentV1> | undefined;
    return Object.freeze<DeploymentExecEnvPortV1>({
        async prepare(request, options) {
            const signal = options?.signal ? AbortSignal.any([input.signal, options.signal]) : input.signal;
            const assertCurrent = async () => {
                if (signal.aborted || !input.isCurrent()) refuse();
                if (sourceInput) {
                    if (Object.keys(request).some(key => key !== 'source' && key !== 'phase')
                        || request.source !== sourceInput.source || request.phase !== sourceInput.phase) refuse();
                    await sourceInput.source.assertCurrent();
                } else if (backupInput) {
                    if (Object.keys(request).some(key => key !== 'backupDestination') || !request.backupDestination
                        || Object.keys(request.backupDestination).some(key => key !== 'configKey')
                        || backupConfigKey !== 'destination' || request.backupDestination.configKey !== backupConfigKey) refuse();
                } else if (!operationalInput || Object.keys(request).some(key => key !== 'bindingIdentity')
                    || request.bindingIdentity !== operationalInput.bindingIdentity) refuse();
                if (signal.aborted || !input.isCurrent()) refuse();
            };
            await assertCurrent();
            // A finite backup job lends one retained group to all its children.
            if (backupAttachment) return backupAttachment;
            const prepareAttachment = async () => {
                let material: DeploymentExecEnvironmentMaterialForHost | undefined = sourceInput ? await sourceInput.prepare({ phase: sourceInput.phase, signal })
                    : backupInput ? await backupInput.prepare({ configKey: backupConfigKey!, signal })
                        : await operationalInput!.prepare({ bindingIdentity: operationalInput!.bindingIdentity, signal });
                const refs = Object.freeze(material.refs.map(ref => Object.freeze({ ...ref })));
                let disposed = false;
                let retired = false;
                let consumed = false;
                let activeBackupLoans = 0;
                let redaction: ProviderRedactionLease | undefined;
                let runtimeCarrier: ReturnType<typeof createAttachmentRuntimeCarrierForHost> | undefined;
                let disposingConsumed: Promise<void> | undefined;
                const env: Record<string, string> = Object.create(null);
                const retireEnvironment = () => {
                    if (retired) return;
                    retired = true;
                    const current = material;
                    material = undefined;
                    for (const key of Object.keys(env)) delete env[key];
                    current?.dispose();
                };
                const dispose = () => {
                    disposed = true;
                    signal.removeEventListener('abort', onAbort);
                    // A closed job refuses more work immediately. Its existing
                    // native command still owns finite settlement before files go.
                    if (activeBackupLoans) return;
                    try { retireEnvironment(); } finally { redaction?.close(); }
                };
                const onAbort = () => { if (backupInput || !consumed) dispose(); };
                // Before consume, no carrier/resources exist and public dispose
                // remains synchronous. Consumed finalizers await all private IO.
                const disposeConsumed = (): Promise<void> => {
                    if (disposingConsumed) return disposingConsumed;
                    if (disposed) return Promise.resolve();
                    disposed = true;
                    signal.removeEventListener('abort', onAbort);
                    disposingConsumed = (async () => {
                        try { if (runtimeCarrier) await runtimeCarrier.dispose(); }
                        finally {
                            runtimeCarrier = undefined;
                            try { retireEnvironment(); } finally { redaction?.close(); }
                        }
                    })();
                    return disposingConsumed;
                };
                try {
                    await assertCurrent();
                    const current = material ?? refuse();
                    const validation = validateEnvVarRecordStrict(current.env);
                    if (!validation.ok) refuse();
                    Object.assign(env, current.env);
                    redaction = createProviderRedactionLease({ values: current.secretValues.flatMap(rawCredential =>
                        readCredentialRedactionValues({ rawCredential })) });
                    // Phase and operational handles transfer custody once. A backup
                    // job lends command custody until its owner disposes the handle.
                    const handle = Object.freeze({ dispose() { if (backupInput || !consumed) dispose(); } }) as DeploymentExecEnvAttachmentV1;
                    attachments.set(handle, {
                        async consume(launchSignal, delivery) {
                            if (!backupInput) attachments.delete(handle);
                            if (consumed || disposed || launchSignal?.aborted) refuse();
                            if (!backupInput) {
                                consumed = true;
                                signal.removeEventListener('abort', onAbort);
                            }
                            const loanEnvironment: Record<string, string> = backupInput ? Object.assign(Object.create(null), env) : env;
                            const loanRedaction = backupInput
                                ? createProviderRedactionLease({ values: redaction!.values() }) : redaction!;
                            let loanRetired = false;
                            let loanDisposed = false;
                            if (backupInput) activeBackupLoans++;
                            const retireLoan = () => {
                                loanRetired = true;
                                if (backupInput) for (const key of Object.keys(loanEnvironment)) delete loanEnvironment[key];
                                else retireEnvironment();
                            };
                            const disposeLoan = async () => {
                                if (!backupInput) return disposeConsumed();
                                if (loanDisposed) return;
                                loanDisposed = true;
                                try { retireLoan(); } finally {
                                    loanRedaction.close();
                                    activeBackupLoans--;
                                    if (disposed) dispose();
                                }
                            };
                            const recheck = async () => {
                                if (disposed || retired || loanRetired || loanDisposed || launchSignal?.aborted) refuse();
                                await assertCurrent();
                                await (material ?? refuse()).recheck();
                                await assertCurrent();
                            };
                            try {
                                // Consumption transfers already-materialized custody.
                                // Exec rechecks full material after resolving the
                                // launch and again at its actual effect boundary.
                                await assertCurrent();
                                if (disposed || retired || launchSignal?.aborted) refuse();
                                // Node's process-env validation echoes a NUL-bearing
                                // value in its error cause. The private native-file
                                // projection never sends these bytes as OS env.
                                if (delivery !== 'runtimeProjection' && Object.values(loanEnvironment).some(value => value.includes('\0'))) refuse();
                                return { env: loanEnvironment, redaction: loanRedaction, refs, recheck,
                                    retireEnvironment: retireLoan, dispose: disposeLoan,
                                    async projectRuntime(projection, host, admit, signal) {
                                        if (sourceInput?.phase !== 'runtime' || projection.source !== sourceInput.source) refuse();
                                        await recheck();
                                        runtimeCarrier ??= createAttachmentRuntimeCarrierForHost({ source: sourceInput.source,
                                            environment: env, redaction: redaction!, assertCurrent: recheck });
                                        return await runtimeCarrier.project(projection, host, admit, signal);
                                    },
                                    retainRuntimeBytes(bytes) {
                                        if (!runtimeCarrier || disposed || retired) { bytes.fill(0); refuse(); }
                                        runtimeCarrier.retainBytes(bytes);
                                    },
                                    async retireRuntimeFiles() { await runtimeCarrier?.retireFiles(); } };
                            } catch (error) { await disposeLoan(); throw error; }
                        },
                    });
                    signal.addEventListener('abort', onAbort, { once: true });
                    return handle;
                } catch (error) { dispose(); throw error; }
            };
            const preparing = prepareAttachment();
            if (backupInput) backupAttachment = preparing;
            return preparing;
        },
    });
}

/** Canonical Exec is the only reader of this private attachment. */
export async function consumeDeploymentExecEnvForHost(
    handle: DeploymentExecEnvAttachmentV1,
    signal?: AbortSignal,
    delivery?: 'runtimeProjection',
): ReturnType<Attachment['consume']> {
    const attachment = attachments.get(handle);
    if (!attachment) refuse();
    return await attachment.consume(signal, delivery);
}
