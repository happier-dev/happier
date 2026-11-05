import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation } from '@/api/client/qualifiedConnectedAccountApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createRequesterConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { PluginReloadController, PluginRuntimeRegistryLease } from './reload/controller';
import { pluginReloadController } from './reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

type RegistryInput = NonNullable<Parameters<typeof resolveExecutablePluginRuntimeRegistry>[0]>;
export type AccountExecutionRuntimeInput = Readonly<{
    accountExecution: NonNullable<RegistryInput['accountExecution']>;
    happyHomeDir?: string;
    signal?: AbortSignal;
    needsAccountPurposes?: boolean;
    resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined | Promise<CliServerFeaturesSnapshot | undefined>;
}>;

/** Compose the existing Account services from an already admitted identity. */
export async function resolveAccountExecutionRuntime(input: AccountExecutionRuntimeInput) {
    const authority = input.accountExecution;
    return await runWithServerHttpBaseUrl(authority.serverUrl, async () => {
        const operationContext = authority.savedSecretOperationContext;
        const accountId = readAccountIdFromToken(authority.credentials.token);
        let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>;
        const borrowAccountRegistry = (): PluginRuntimeRegistryLease => ({
            registry, source: 'ephemeral', durableRevision: -1, release: async () => {},
        });
        // Purpose services borrow their containing Account registry. The daemon
        // publication owner is not an execution authority for this Account host.
        const accountRegistryAccess: Pick<PluginReloadController,
            'acquireRuntimeRegistry' | 'tryAcquireRuntimeRegistry' | 'isRuntimeRegistryCurrent' | 'subscribe'> = {
            acquireRuntimeRegistry: async () => borrowAccountRegistry(),
            tryAcquireRuntimeRegistry: borrowAccountRegistry,
            isRuntimeRegistryCurrent: candidate => candidate === registry,
            subscribe: pluginReloadController.subscribe,
        };
        const purposeRuntime = input.needsAccountPurposes && operationContext && accountId ? await (async () => {
            const features = input.resolveServerFeaturesSnapshot ? await input.resolveServerFeaturesSnapshot()
                : await fetchServerFeaturesSnapshot({ serverUrl: authority.serverUrl, token: authority.credentials.token,
                    ...(input.signal ? { signal: input.signal } : {}) });
            const credentialApi = createConnectedServiceCredentialApi(authority.credentials);
            return createRequesterConnectedAccountPurposeBindingRuntime({ operationContext, accountId,
                ...(authority.machineId ? { machineId: authority.machineId } : {}),
                reloadController: accountRegistryAccess,
                isCurrent: async () => await authority.isCurrent() && await authority.isCredentialCurrent?.() !== false,
                allowNativeAccountCredentials: false,
                getAccountEncryptionMode: options => runWithServerHttpBaseUrl(authority.serverUrl,
                    () => credentialApi.getAccountEncryptionMode(options)),
                resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(features),
            });
        })() : null;
        registry = await resolveExecutablePluginRuntimeRegistry({
            ...(input.happyHomeDir ? { happyHomeDir: input.happyHomeDir } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
            ...(purposeRuntime ? { connectedAccounts: purposeRuntime.purposes.owner, actionFormConnectedAccounts: {
                resolveBindingIntent: purposeRuntime.purposes.resolveBindingIntent,
                resolveBindingIntentSelection: purposeRuntime.purposes.resolveBindingIntentSelection,
                activatePurposeBindings: purposeRuntime.purposes.activatePurposeBindings,
            } } : {}),
            accountExecution: authority,
        });
        return { registry, purposeRuntime };
    });
}

export type AccountExecutionRuntime = Awaited<ReturnType<typeof resolveAccountExecutionRuntime>>;
export type RetainedAccountExecutionRuntime = Readonly<{
    read(): Promise<AccountExecutionRuntime>;
    dispose(): Promise<void>;
}>;
export type AccountExecutionRuntimeRegistryLease = PluginRuntimeRegistryLease & Readonly<{
    /** Containing Session owns this Account runtime; native activation keeps its registry. */
    accountRuntime?: RetainedAccountExecutionRuntime;
}>;

/** One registry for the containing host lifetime, shared by all its tool bridges. */
export function createRetainedAccountExecutionRuntime(
    resolveInput: () => AccountExecutionRuntimeInput | Promise<AccountExecutionRuntimeInput>,
): RetainedAccountExecutionRuntime {
    let runtime: Promise<AccountExecutionRuntime> | undefined;
    return {
        read: () => runtime ??= Promise.resolve().then(resolveInput).then(resolveAccountExecutionRuntime),
        dispose: async () => { if (runtime) await runtime.then(value => value.registry.dispose(), () => undefined); },
    };
}
