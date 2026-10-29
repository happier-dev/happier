import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { ProcessOwnerRef } from '@/processes/ownerTag';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { logger } from '@/ui/logger';
import type { LanguageServerDefinition } from './languageServerDefinitions';

export type OpenLanguageServerProtocolInput = Readonly<{
    definition: Pick<LanguageServerDefinition, 'id' | 'pluginId' | 'executable' | 'args'>;
    rootPath: string;
    processOwner: ProcessOwnerRef;
    signal: AbortSignal;
    onRetired?: () => void;
}>;

export class LanguageServerProtocolUnavailableError extends PluginError {
    readonly reason = 'server_missing' as const;
    readonly installable?: Extract<ManagedExecutableRef, { kind: 'managedDependency' }>;

    constructor(executable: ManagedExecutableRef, cause?: unknown) {
        super({ code: 'server_missing', message: 'The declared language server executable is unavailable' }, { cause });
        if (executable.kind === 'managedDependency') this.installable = executable;
    }
}

export type LanguageServerManagedExec = Readonly<{ service: ExecService; signal: AbortSignal; release(): Promise<void> }>;
export type AcquireLanguageServerManagedExec = (
    input: OpenLanguageServerProtocolInput,
) => Promise<LanguageServerManagedExec>;

export type ReadLanguageServerInitializationOptions = (
    definition: Pick<LanguageServerDefinition, 'pluginId' | 'initializationOptions' | 'initializationOptionsSetting'>,
    signal: AbortSignal,
) => Promise<JsonValue | undefined>;

/** Read the plugin's declared setting at explicit startup; there is no watcher or query-time settings read. */
export function createLanguageServerInitializationOptionsReader(options: Readonly<{
    acquireRuntimeRegistry(): Promise<PluginRuntimeRegistryLease>;
}>): ReadLanguageServerInitializationOptions {
    return async (definition, signal) => {
        const binding = definition.initializationOptionsSetting;
        if (!binding) return definition.initializationOptions;
        signal.throwIfAborted();
        const lease = await options.acquireRuntimeRegistry();
        try {
            const settings = lease.registry.createPluginSettingsService?.({
                pluginId: definition.pluginId, scope: { kind: binding.scope }, signal,
            });
            if (!settings) throw new PluginError({ code: 'language_server_settings_unavailable', message: 'Language server settings are unavailable' });
            const value = await settings.get(binding.field, { signal });
            if (value === null) throw new PluginError({ code: 'language_server_settings_unavailable', message: 'Language server initialization options are unavailable' });
            signal.throwIfAborted();
            return value;
        } finally { await lease.release(); }
    };
}

export const readLanguageServerInitializationOptions = createLanguageServerInitializationOptionsReader({
    acquireRuntimeRegistry: () => pluginReloadController.acquireRuntimeRegistry(),
});

/** One occurrence fence and lease owner for protocol sessions and finite checks. */
export function createLanguageServerManagedExecAcquirer(options: Readonly<{
    acquireRuntimeRegistry(): Promise<PluginRuntimeRegistryLease>;
}>): AcquireLanguageServerManagedExec {
    return async input => {
        input.signal.throwIfAborted();
        const lease = await options.acquireRuntimeRegistry();
        let unsubscribeRetirement: (() => void) | undefined;
        try {
            const registry = lease.registry;
            const occurrenceId = registry.readPluginOccurrenceId?.(input.definition.pluginId);
            const retirement = new AbortController();
            const retire = () => {
                if (retirement.signal.aborted) return;
                retirement.abort(new PluginError({ code: 'plugin_generation_stale', message: 'Language-server plugin occurrence retired' }));
                input.onRetired?.();
            };
            const unsubscribeFence = registry.subscribePluginOccurrenceFence?.((pluginId, fencedOccurrenceId) => {
                if (pluginId === input.definition.pluginId && fencedOccurrenceId === occurrenceId) retire();
            });
            registry.retirementSignal?.addEventListener('abort', retire, { once: true });
            unsubscribeRetirement = () => {
                unsubscribeFence?.();
                registry.retirementSignal?.removeEventListener('abort', retire);
            };
            if (registry.retirementSignal?.aborted) retire();
            const signal = AbortSignal.any([input.signal, retirement.signal]);
            const service = createStablePluginExecService({
                processOwner: input.processOwner,
                allowedExecutables: [input.definition.executable],
                signal,
                isOccurrenceCurrent: () => Boolean(occurrenceId
                    && registry.isPluginOccurrenceCurrent?.(input.definition.pluginId, occurrenceId)),
                async resolveExecutable(executable) {
                    if (!registry.resolveReadyManagedExecutable) throw new LanguageServerProtocolUnavailableError(executable);
                    try {
                        return await registry.resolveReadyManagedExecutable(executable, input.definition.pluginId);
                    } catch (error) {
                        signal.throwIfAborted();
                        throw new LanguageServerProtocolUnavailableError(executable, error);
                    }
                },
                // Launch cwd is the host-authorized absolute workspace path, so no plugin
                // filesystem path is consumed by this service.
                resolvePath: async () => input.rootPath,
            });
            let released = false;
            return { service, signal, async release() {
                if (released) return;
                released = true;
                unsubscribeRetirement?.();
                await lease.release();
            } };
        } catch (error) {
            unsubscribeRetirement?.();
            await lease.release();
            throw error;
        }
    };
}

export function createLanguageServerProtocolOpener(options: Readonly<{
    acquireRuntimeRegistry(): Promise<PluginRuntimeRegistryLease>;
}>): (input: OpenLanguageServerProtocolInput) => Promise<PluginProtocolClientHandle<'jsonRpc'>> {
    const acquireExec = createLanguageServerManagedExecAcquirer(options);
    return async input => {
        const managed = await acquireExec(input);
        try {
            const handle = await managed.service.clients.spawn({
                kind: 'jsonRpc', framing: 'contentLength',
                cancellationMethod: '$/cancelRequest',
                launch: { executable: input.definition.executable, args: input.definition.args, cwd: input.rootPath },
            });
            const stderr = handle.process.onOutput(output => {
                if (output.stream === 'stderr') logger.infoFile('[LanguageServer] stderr', {
                    serverId: input.definition.id, text: Buffer.from(output.data).toString('utf8'),
                });
            });
            // Preserve the canonical handle identity for its host-private disposal hook.
            void handle.wait().finally(async () => {
                stderr.dispose();
                await managed.release();
            }).catch(error => logger.infoFile('[LanguageServer] Runtime lease cleanup failed', error));
            return handle;
        } catch (error) {
            await managed.release();
            throw error;
        }
    };
}

export const openLanguageServerProtocol = createLanguageServerProtocolOpener({
    acquireRuntimeRegistry: () => pluginReloadController.acquireRuntimeRegistry(),
});
