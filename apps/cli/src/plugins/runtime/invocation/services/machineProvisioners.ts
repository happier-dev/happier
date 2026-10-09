import { PluginError } from '@happier-dev/plugin-sdk';
import type { MachineProvisionersService, MachineProvisionerBootstrapCredentialLeaseV1 } from '@happier-dev/plugin-sdk';
import type { PluginInvocationServicesSeed } from './types';
import type { ManagedServiceCredentialFileOwner, ManagedServiceCredentialFileCleanup } from './managedServicesAdapter';
import { sshPublicKey } from '@/machines/managed/bootstrapSshPublicKey';
import { isMachineProvisionerBootstrapCredentialRoleV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

/** Binds only the original admitted operation's implicit retained credential. */
export function createMachineProvisionersInvocationService(params: Readonly<{
    seed: PluginInvocationServicesSeed;
    credentialFiles?: ManagedServiceCredentialFileOwner;
    registerRawForRedaction?(value: string): void;
}>): MachineProvisionersService | null {
    const { seed } = params;
    const binding = seed.managedBootstrapCredential;
    if (!binding || !seed.retainCleanup || seed.signal.aborted || !seed.isOccurrenceCurrent()
        || !isMachineProvisionerBootstrapCredentialRoleV1(binding.role)) return null;
    const unavailable = () => new PluginError({ code: 'plugin_service_unavailable', message: 'The admitted bootstrap credential is unavailable' });
    const assertCurrent = async () => {
        if (seed.signal.aborted || !seed.isOccurrenceCurrent() || !await binding.isCurrent()
            || seed.signal.aborted || !seed.isOccurrenceCurrent()) throw unavailable();
    };
    return Object.freeze({
        withBootstrapCredentialFile<TResult>(request: Readonly<{ relativePath: string }>,
            effect: (lease: Extract<MachineProvisionerBootstrapCredentialLeaseV1, { kind: 'file' }>) => Promise<TResult>): Promise<TResult> {
            let operation: Promise<TResult> | null = null;
            let fileCleanup: ManagedServiceCredentialFileCleanup | null = null;
            // Retain synchronously even if a handler forgets to await the
            // callback. Invocation settlement must join the native reader.
            try { seed.retainCleanup!({ async dispose() {
                await operation?.catch(() => undefined);
                await fileCleanup?.dispose();
            } }); }
            catch (error) { return Promise.reject(error); }
            operation = (async () => {
                const owner = params.credentialFiles;
                if (!owner?.withMaterializedFiles || !request.relativePath) throw unavailable();
                const material: { bytes: Uint8Array | null } = { bytes: null };
                try {
                    await assertCurrent();
                    return await owner.withMaterializedFiles({
                        scope: { pluginId: seed.plugin.id },
                        files: async () => {
                            await assertCurrent();
                            const bytes = material.bytes = await binding.readBootstrapCredential();
                            await assertCurrent();
                            const value = new TextDecoder().decode(bytes);
                            params.registerRawForRedaction?.(value);
                            return { bootstrap: bytes, public: new TextEncoder().encode(sshPublicKey(value)) };
                        },
                        relativePathsByFileId: { bootstrap: request.relativePath, public: request.relativePath + '.pub' },
                        signal: seed.signal, deferCleanupFailure: binding.role === 'acquire',
                        retainCleanup(cleanup) { fileCleanup = cleanup; },
                    }, async lease => {
                        await assertCurrent();
                        return await effect(Object.freeze({ kind: 'file', path: lease.pathsByFileId.bootstrap!,
                            dispose: async () => { await lease.dispose(); } }));
                    });
                } finally { material.bytes?.fill(0); }
            })();
            return operation;
        },
        materializeBootstrapCredential(request: Parameters<MachineProvisionersService['materializeBootstrapCredential']>[0]): Promise<MachineProvisionerBootstrapCredentialLeaseV1> {
            let bytes: Uint8Array | null = null;
            let fileCleanup: ManagedServiceCredentialFileCleanup | null = null;
            let materialization: Promise<MachineProvisionerBootstrapCredentialLeaseV1> | null = null;
            let disposal: Promise<void> | null = null;
            const clean = (): Promise<void> => {
                bytes?.fill(0);
                return disposal ??= Promise.resolve().then(async () => { await fileCleanup?.dispose(); });
            };
            const dispose = async (): Promise<void> => {
                // A handler may leave this materialization unawaited. Its
                // cleanup must not remove a directory that an in-flight write
                // can recreate, or zero bytes that that write still owns.
                await materialization?.catch(() => undefined);
                await clean();
            };
            try {
                // Retain the one lease before any asynchronous acquisition.
                seed.retainCleanup!({ dispose });
            } catch (error) {
                return Promise.reject(error);
            }
            materialization = (async (): Promise<MachineProvisionerBootstrapCredentialLeaseV1> => {
                try {
                    if (request.kind !== 'bytes' && request.kind !== 'file') throw unavailable();
                    if (request.kind === 'file' && !params.credentialFiles) throw unavailable();
                    await assertCurrent();
                    bytes = await binding.readBootstrapCredential();
                    await assertCurrent();
                    if (bytes.byteLength === 0) throw unavailable();
                    params.registerRawForRedaction?.(new TextDecoder().decode(bytes));
                    if (request.kind === 'bytes') return Object.freeze({ kind: 'bytes', bytes, dispose });
                    const fileLease = await params.credentialFiles!.materialize({
                        scope: { occurrenceId: seed.occurrenceId, pluginId: seed.plugin.id,
                            contributionQualifiedId: seed.contribution.qualifiedId, operationId: seed.correlationId,
                            ...(seed.session ? { sessionId: seed.session.id } : {}),
                        },
                        files: { bootstrap: bytes },
                        retainCleanup: cleanup => { fileCleanup = cleanup; },
                    });
                    bytes.fill(0);
                    await assertCurrent();
                    const path = fileLease.pathsByFileId.bootstrap;
                    if (!path) throw unavailable();
                    return Object.freeze({ kind: 'file', path, dispose });
                } catch (error) {
                    // This is the acquisition itself; waiting for its own
                    // materialization promise here would deadlock cleanup.
                    await clean();
                    throw error;
                }
            })();
            return materialization;
        },
    });
}
