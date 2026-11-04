import { PluginError } from '@happier-dev/plugin-sdk';
import type { MachineProvisionersService, MachineProvisionerBootstrapCredentialLeaseV1 } from '@happier-dev/plugin-sdk';
import type { PluginInvocationServicesSeed } from './types';
import type { ManagedServiceCredentialFileOwner, ManagedServiceCredentialFileCleanup } from './managedServicesAdapter';
import { sshPublicKey } from '@/machines/managed/bootstrapSshPublicKey';
import { createManagedBootstrapCredentialByteService } from '@happier-dev/cli-common/machines/managed';

/** Binds only the original admitted operation's implicit retained credential. */
export function createMachineProvisionersInvocationService(params: Readonly<{
    seed: PluginInvocationServicesSeed;
    credentialFiles?: ManagedServiceCredentialFileOwner;
    registerRawForRedaction?(value: string): void;
}>): MachineProvisionersService | null {
    const { seed } = params;
    const binding = seed.managedBootstrapCredential;
    const native = seed.managedNativeCredentials;
    const retainCleanup = seed.retainCleanup;
    if (!retainCleanup || seed.signal.aborted || !seed.isOccurrenceCurrent()
        || !binding && !native) return null;
    const unavailable = () => new PluginError({ code: 'plugin_service_unavailable', message: 'The admitted bootstrap credential is unavailable' });
    const byteService = createManagedBootstrapCredentialByteService({ binding, signal: seed.signal,
        isCurrent: seed.isOccurrenceCurrent, retainCleanup, unavailable,
        registerRawForRedaction: params.registerRawForRedaction });
    const { assertActive } = byteService;
    const materializeCredential = (request: Readonly<{ kind: 'bytes' | 'file' }>):
        Promise<MachineProvisionerBootstrapCredentialLeaseV1> => {
        if (request.kind === 'bytes') return byteService.materializeBootstrapCredential();
        let byteLease: Awaited<ReturnType<typeof byteService.materializeBootstrapCredential>> | null = null;
        let fileCleanup: ManagedServiceCredentialFileCleanup | null = null;
        let materialization: Promise<MachineProvisionerBootstrapCredentialLeaseV1> | null = null;
        let disposal: Promise<void> | null = null;
        const clean = (): Promise<void> => {
            return disposal ??= Promise.resolve().then(async () => {
                await byteLease?.dispose();
                await fileCleanup?.dispose();
            });
        };
        const dispose = async (): Promise<void> => {
            // Join an acquisition the handler did not await before zeroing its bytes or removing files.
            await materialization?.catch(() => undefined);
            await clean();
        };
        try { retainCleanup({ dispose }); }
        catch (error) { return Promise.reject(error); }
        materialization = (async (): Promise<MachineProvisionerBootstrapCredentialLeaseV1> => {
            try {
                if (request.kind !== 'file' || !params.credentialFiles) throw unavailable();
                byteLease = await byteService.materializeBootstrapCredential();
                const fileLease = await params.credentialFiles!.materialize({
                    scope: { occurrenceId: seed.occurrenceId, pluginId: seed.plugin.id,
                        contributionQualifiedId: seed.contribution.qualifiedId, operationId: seed.correlationId,
                        ...(seed.session ? { sessionId: seed.session.id } : {}),
                    },
                    files: { bootstrap: byteLease.bytes },
                    retainCleanup: cleanup => { fileCleanup = cleanup; },
                });
                await byteLease.dispose();
                assertActive();
                const path = fileLease.pathsByFileId.bootstrap;
                if (!path) throw unavailable();
                return Object.freeze({ kind: 'file', path, dispose });
            } catch (error) {
                // This acquisition cannot await its own materialization during cleanup.
                await clean();
                throw error;
            }
        })();
        return materialization;
    };
    return Object.freeze({
        async materializeNativeCredentialHeaders(request: Parameters<MachineProvisionersService['materializeNativeCredentialHeaders']>[0]):
            ReturnType<MachineProvisionersService['materializeNativeCredentialHeaders']> {
            const refused = { ok: false as const, code: 'native_credential_binding_unavailable' as const };
            try {
                if (!native || request === null || typeof request !== 'object'
                    || !Object.hasOwn(request, 'bindingKey') || Object.keys(request).length !== 1) return refused;
                const bindingKey = request.bindingKey;
                if (typeof bindingKey !== 'string') return refused;
                const selected = native.bindings.get(bindingKey);
                if (!selected) return refused;
                assertActive();
                const material = await selected.readRenderedHeaders();
                assertActive();
                if (!material.ok) return refused;
                for (const value of Object.values(material.headers)) params.registerRawForRedaction?.(value);
                return { ok: true as const, headers: Object.freeze({ ...material.headers }) };
            } catch { return refused; }
        },
        withBootstrapCredentialFile<TResult>(request: Readonly<{ relativePath: string }>,
            effect: (lease: Extract<MachineProvisionerBootstrapCredentialLeaseV1, { kind: 'file' }>) => Promise<TResult>): Promise<TResult> {
            let operation: Promise<TResult> | null = null;
            let fileCleanup: ManagedServiceCredentialFileCleanup | null = null;
            // Retain synchronously even if a handler forgets to await the
            // callback. Invocation settlement must join the native reader.
            try { retainCleanup({ async dispose() {
                await operation?.catch(() => undefined);
                await fileCleanup?.dispose();
            } }); }
            catch (error) { return Promise.reject(error); }
            operation = (async () => {
                const owner = params.credentialFiles;
                if (!owner?.withMaterializedFiles || !request.relativePath) throw unavailable();
                const material: { lease: Awaited<ReturnType<typeof byteService.materializeBootstrapCredential>> | null } = { lease: null };
                try {
                    assertActive();
                    return await owner.withMaterializedFiles({
                        scope: { pluginId: seed.plugin.id },
                        files: async () => {
                            // The file owner calls this only after lock admission.
                            // This is the actual acquisition, including queued readers.
                            const byteLease = material.lease = await byteService.materializeBootstrapCredential();
                            const { bytes } = byteLease;
                            const value = new TextDecoder().decode(bytes);
                            return { bootstrap: bytes, public: new TextEncoder().encode(sshPublicKey(value)) };
                        },
                        relativePathsByFileId: { bootstrap: request.relativePath, public: request.relativePath + '.pub' },
                        signal: seed.signal, deferCleanupFailure: binding?.role === 'acquire',
                        retainCleanup(cleanup) { fileCleanup = cleanup; },
                    }, async lease => {
                        assertActive();
                        return await effect(Object.freeze({ kind: 'file', path: lease.pathsByFileId.bootstrap!,
                            dispose: async () => { await lease.dispose(); } }));
                    });
                } finally { await material.lease?.dispose(); }
            })();
            return operation;
        },
        materializeBootstrapCredential(request: Parameters<MachineProvisionersService['materializeBootstrapCredential']>[0]): Promise<MachineProvisionerBootstrapCredentialLeaseV1> {
            return materializeCredential(request);
        },
    });
}
