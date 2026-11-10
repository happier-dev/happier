import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation } from '@/api/client/qualifiedConnectedAccountApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createRequesterConnectedAccountPurposeBindingRuntime } from '@/daemon/connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { isCustodianMachineAdmission } from '@/daemon/lifecycle/requesterWorkAttribution';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { PluginReloadController, PluginRuntimeRegistryLease } from './reload/controller';
import { pluginReloadController } from './reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

type RegistryInput = NonNullable<Parameters<typeof resolveExecutablePluginRuntimeRegistry>[0]>;
export type AccountExecutionRuntimeInput = Readonly<{
    accountExecution: NonNullable<RegistryInput['accountExecution']>;
    externalActionHomeBinding?: RegistryInput['externalActionHomeBinding'];
    happyHomeDir?: string;
    signal?: AbortSignal;
    /** A containing Machine operation holds this registry until Account execution ends. */
    credentialRuntimeRegistry?: PluginRuntimeRegistryLease['registry'];
    resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined | Promise<CliServerFeaturesSnapshot | undefined>;
}>;

/** Compose the existing Account services from an already admitted identity. */
export async function resolveAccountExecutionRuntime(input: AccountExecutionRuntimeInput) {
    const authority = input.accountExecution;
    return await runWithServerHttpBaseUrl(authority.serverUrl, async () => {
        const operationContext = authority.savedSecretOperationContext;
        const accountId = readAccountIdFromToken(authority.credentials.token);
        let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>;
        const readCredentialRegistry = () => input.credentialRuntimeRegistry ?? registry;
        const borrowCredentialRegistry = (): PluginRuntimeRegistryLease => ({
            registry: readCredentialRegistry(), source: 'ephemeral', durableRevision: -1, release: async () => {},
        });
        // Purpose services use the containing operation's held registry, or their
        // Account registry when no Machine is involved. Neither owns publication.
        const credentialRegistryAccess: Pick<PluginReloadController,
            'acquireRuntimeRegistry' | 'tryAcquireRuntimeRegistry' | 'isRuntimeRegistryCurrent' | 'subscribe'> = {
            acquireRuntimeRegistry: async () => borrowCredentialRegistry(),
            tryAcquireRuntimeRegistry: borrowCredentialRegistry,
            isRuntimeRegistryCurrent: candidate => candidate === readCredentialRegistry(),
            subscribe: pluginReloadController.subscribe,
        };
        let qualifiedSupport: Promise<ReturnType<typeof resolveQualifiedConnectedAccountAtomicV4Negotiation>> | undefined;
        const resolveQualifiedSupport = () => qualifiedSupport ??= (async () => {
            const features = input.resolveServerFeaturesSnapshot ? await input.resolveServerFeaturesSnapshot()
                : await fetchServerFeaturesSnapshot({ serverUrl: authority.serverUrl, token: authority.credentials.token,
                    ...(input.signal ? { signal: input.signal } : {}) });
            return resolveQualifiedConnectedAccountAtomicV4Negotiation(features);
        })();
        // Child Actions derive their own purpose demand at admission. Composing
        // these local services must not depend on the parent's declarations.
        const purposeRuntime = operationContext && accountId ? (() => {
            const credentialApi = createConnectedServiceCredentialApi(authority.credentials);
            return createRequesterConnectedAccountPurposeBindingRuntime({ operationContext, accountId,
                ...(authority.machineId ? { machineId: authority.machineId } : {}),
                reloadController: credentialRegistryAccess,
                isCurrent: async () => await authority.isCurrent() && await authority.isCredentialCurrent?.() !== false,
                allowNativeAccountCredentials: operationContext.machineAdmission?.actorAccountId === accountId
                    && isCustodianMachineAdmission(operationContext.machineAdmission),
                getAccountEncryptionMode: options => runWithServerHttpBaseUrl(authority.serverUrl,
                    () => credentialApi.getAccountEncryptionMode(options)),
                resolveQualifiedConnectedAccountV4Support: resolveQualifiedSupport,
            });
        })() : null;
        registry = await resolveExecutablePluginRuntimeRegistry({
            ...(input.externalActionHomeBinding ? { externalActionHomeBinding: input.externalActionHomeBinding } : {}),
            ...(input.happyHomeDir ? { happyHomeDir: input.happyHomeDir } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
            ...(purposeRuntime ? { connectedAccounts: purposeRuntime.purposes.owner, actionFormConnectedAccounts: {
                resolveBindingIntent: purposeRuntime.purposes.resolveBindingIntent,
                resolveBindingIntentSelection: purposeRuntime.purposes.resolveBindingIntentSelection,
                activatePurposeBindings: purposeRuntime.purposes.activatePurposeBindings,
            } } : {}),
            accountExecution: authority,
            runtimeRegistryController: credentialRegistryAccess,
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
