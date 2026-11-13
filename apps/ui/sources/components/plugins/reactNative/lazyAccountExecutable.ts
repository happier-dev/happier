import { PluginError, type PluginAccountApi, type PluginClientApi } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionHandler, PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
    derivePluginAccountContributionRegistrationRights,
    derivePluginClientContributionRegistrationRights,
    type PluginContributionRegistrationRight,
} from '@happier-dev/protocol/plugins/contributions/catalog';
import { createPluginRegistrationScope, type PluginRuntimeRegistration } from '@/sync/domains/plugins/registrationScope';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import type { PluginReactNativeExportLoaderResult } from './loader';
import type { PluginUiClientExecutableTarget } from './clientExecutableContributions';

type LazyExecutableInput = Readonly<{
    contributes: Readonly<Record<string, unknown>>;
    target: PluginUiClientExecutableTarget;
}>;

/** Families whose consumers prepare the registration before reading its runtime value. */
const DEFERRED_FAMILIES_BY_REALM = Object.freeze({
    account: new Set<string>(['actions', 'resources', 'connectedAccountDescriptors']),
    client: new Set<string>(['actions']),
});

function deriveLazyExecutableRights(input: LazyExecutableInput): readonly PluginContributionRegistrationRight[] {
    const { artifactId, exportName, platform } = input.target;
    return input.target.realm === 'account'
        ? derivePluginAccountContributionRegistrationRights(input.contributes, { artifactId, exportName })
        : derivePluginClientContributionRegistrationRights(input.contributes, { artifactId, exportName, platform });
}

/**
 * A target loads on first use when every registration it owns is prepared by
 * its consumer before use. Families read synchronously (drag/drop, work items,
 * Voice) keep eager activation.
 */
export function canActivatePluginUiExecutableLazily(input: LazyExecutableInput): boolean {
    const deferred = DEFERRED_FAMILIES_BY_REALM[input.target.realm ?? 'client'];
    const rights = deriveLazyExecutableRights(input);
    return rights.length > 0 && rights.every(right => deferred.has(right.family));
}

/** Declarations stay available while their callbacks load on first use. */
export function createLazyPluginUiExecutable(input: Readonly<{
    pluginId: string;
    contributes: Readonly<Record<string, unknown>>;
    target: PluginUiClientExecutableTarget;
    isCurrent(): boolean;
    load(): Promise<PluginReactNativeExportLoaderResult>;
}>) {
    const target = input.target.realm === 'account'
        ? { realm: 'account' as const, artifactId: input.target.artifactId, exportName: input.target.exportName }
        : { realm: 'client' as const, artifactId: input.target.artifactId, exportName: input.target.exportName,
            platform: input.target.platform };
    const rights = deriveLazyExecutableRights(input);
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
            const capture = target.realm === 'account'
                ? createPluginRegistrationScope({ pluginId: input.pluginId, target, rights })
                : createPluginRegistrationScope({ pluginId: input.pluginId, target, rights });
            scope = capture;
            try {
                const result: unknown = await Reflect.apply(loaded.exported, undefined, [capture.api]);
                if (result !== undefined && typeof result !== 'function') throw new TypeError('invalid_activation_cleanup');
                cleanup = result as (() => void | Promise<void>) | undefined;
                assertCurrent();
                return capture.commit();
            } catch (error) {
                await releaseRuntime();
                if (retired || !input.isCurrent()) throw Object.assign(new Error('plugin_action_generation_retired'), { code: 'plugin_action_generation_retired' });
                const remedy = 'This integration is not ready on this Home. Retry.';
                throw new PluginError({ code: 'activation_failed', message: remedy,
                    details: { requiredFact: 'pluginAccountActivation', remedy },
                    failureCause: projectActionFailureCauseV1(error, 'plugin.account.activate') });
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
        activate(api: PluginAccountApi | PluginClientApi) {
            for (const right of rights) {
                if (right.family === 'actions') {
                    const handler: PluginAccountActionHandler = async (value, context) => {
                        throwIfAborted(context.signal);
                        const selected = await registration('actions', right.localId);
                        throwIfAborted(context.signal);
                        // The realm dispatcher supplies the context its loaded handler was registered for.
                        return (selected.value as unknown as PluginAccountActionHandler)(value, context);
                    };
                    if ('resources' in api) api.actions.register(right.localId, handler);
                    else api.actions.register(right.localId, handler as unknown as PluginClientActionHandler);
                } else if (right.family === 'resources' && 'resources' in api) {
                    api.resources.registerDynamicResource(right.localId, {
                        read: async options => (await resource(right.localId, options.signal)).read(options),
                        observe: async (invalidate, options) => (await resource(right.localId, options.signal)).observe(invalidate, options),
                    });
                } else if (right.family === 'connectedAccountDescriptors' && 'connectedAccounts' in api) {
                    // Consumers prepare this existing registration before reading its
                    // actual mode set; unopened services acquire no executable bytes.
                    api.connectedAccounts.register(right.localId, { authentication: { modes: {} } });
                }
            }
            return dispose;
        },
    };
}
