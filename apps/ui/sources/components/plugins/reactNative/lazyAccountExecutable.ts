import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { derivePluginAccountContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { createPluginRegistrationScope, type PluginRuntimeRegistration } from '@/sync/domains/plugins/registrationScope';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import type { PluginReactNativeExportLoaderResult } from './loader';
import type { PluginUiClientExecutableTarget } from './clientExecutableContributions';

/** Account declarations stay available while their callbacks load on first use. */
export function createLazyAccountExecutable(input: Readonly<{
    pluginId: string;
    contributes: Readonly<Record<string, unknown>>;
    target: PluginUiClientExecutableTarget;
    isCurrent(): boolean;
    load(): Promise<PluginReactNativeExportLoaderResult>;
}>) {
    const target = { realm: 'account' as const, artifactId: input.target.artifactId, exportName: input.target.exportName };
    const rights = derivePluginAccountContributionRegistrationRights(input.contributes, target);
    let pending: Promise<readonly PluginRuntimeRegistration[]> | undefined;
    let retired = false;
    let scope: Pick<ReturnType<typeof createPluginRegistrationScope>, 'dispose'> | undefined;
    let cleanup: (() => void | Promise<void>) | undefined;
    const assertCurrent = () => {
        if (retired || !input.isCurrent()) throw Object.assign(new Error('client_executable_activation_retired'), { code: 'plugin_action_generation_retired' });
    };
    const releaseRuntime = async () => {
        await scope?.dispose();
        const ownedCleanup = cleanup;
        cleanup = undefined;
        await ownedCleanup?.();
    };
    const dispose = async () => {
        retired = true;
        await releaseRuntime();
    };
    const prepare = () => {
        assertCurrent();
        pending ??= (async () => {
            const loaded = await input.load();
            if (!loaded.ok) throw Object.assign(new Error(loaded.code), loaded);
            assertCurrent();
            const capture = createPluginRegistrationScope({ pluginId: input.pluginId, target, rights });
            scope = capture;
            try {
                const result: unknown = await Reflect.apply(loaded.exported, undefined, [capture.api]);
                if (result !== undefined && typeof result !== 'function') throw new TypeError('invalid_activation_cleanup');
                cleanup = result as (() => void | Promise<void>) | undefined;
                assertCurrent();
                return capture.commit();
            } catch {
                await releaseRuntime();
                if (retired || !input.isCurrent()) throw Object.assign(new Error('plugin_action_generation_retired'), { code: 'plugin_action_generation_retired' });
                throw Object.assign(new Error('activation_failed'), { code: 'activation_failed' });
            }
        })().catch(error => {
            pending = undefined;
            throw error;
        });
        return pending;
    };
    const registration = async (family: 'actions' | 'resources' | 'connectedAccountDescriptors', localId: string) => {
        const registrations = await prepare();
        assertCurrent();
        const selected = registrations.find(value => value.family === family && value.localId === localId);
        if (!selected) throw new Error('client_executable_registration_right_missing');
        return selected;
    };
    const resource = async (id: string, signal: AbortSignal) => {
        throwIfAborted(signal);
        const selected = await registration('resources', id);
        throwIfAborted(signal);
        const runtime = selected.value as PluginDynamicResourceRuntime;
        if (runtime.createProducer) throw Object.assign(new Error('Context producers require daemon Resource placement'), { code: 'plugin_resource_producer_placement_unavailable' });
        return runtime;
    };
    return {
        prepareRegistration: async (selected: PluginRuntimeRegistration): Promise<PluginRuntimeRegistration> => {
            if (selected.family !== 'actions' && selected.family !== 'resources' && selected.family !== 'connectedAccountDescriptors') return selected;
            return registration(selected.family, selected.localId);
        },
        activate(api: PluginAccountApi) {
            for (const right of rights) {
                if (right.family === 'actions') {
                    api.actions.register(right.localId, async (value, context) => {
                        throwIfAborted(context.signal);
                        const selected = await registration('actions', right.localId);
                        throwIfAborted(context.signal);
                        return (selected.value as unknown as PluginAccountActionHandler)(value, context);
                    });
                } else if (right.family === 'resources') {
                    api.resources.registerDynamicResource(right.localId, {
                        read: async options => (await resource(right.localId, options.signal)).read(options),
                        observe: async (invalidate, options) => (await resource(right.localId, options.signal)).observe(invalidate, options),
                    });
                } else if (right.family === 'connectedAccountDescriptors') {
                    // Consumers prepare this existing registration before reading its
                    // actual mode set; unopened services acquire no executable bytes.
                    api.connectedAccounts.register(right.localId, { authentication: { modes: {} } });
                }
            }
            return dispose;
        },
    };
}
