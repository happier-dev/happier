import { createConnectedAccountEstablishedRuntimeDispatcher, createConnectedAccountEstablishedRuntimeOwner,
    createConnectedAccountPurposeMaterializer, type ConnectedAccountEstablishedRuntimeRegistry,
    type ConnectedAccountPurposeMaterializationInput, type QualifiedConnectedAccountEstablishedRuntimeOwner } from '@happier-dev/cli-common/connectedAccounts';
import type { ConnectedAccountPortableReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { resolvePluginUiAccountConnectedAccountRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { createPluginSurfaceAccountNetworkServices } from '@/components/plugins/surfaces/pluginSurfaceAccountNetworkServices';
import type { AccountConnectedServiceDeclaration } from '@/sync/domains/connectedServices/accountDeclarations';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { UiConnectedAccountAuthenticationRuntime } from './connectedAccountAuthenticationRuntime';
import type { createUiConnectedAccountCredentialPersistence } from './connectedAccountCredentialPersistence';

type OwnerPorts = Parameters<typeof createConnectedAccountEstablishedRuntimeOwner>[0];

/** Physical Account ports for the same established owner used by the daemon. */
export function createUiConnectedAccountEstablishedMaterializer(input: Readonly<{
    selected: NonNullable<Awaited<ReturnType<typeof resolvePluginUiAccountConnectedAccountRegistration>>>;
    declaration: AccountConnectedServiceDeclaration;
    account: LazyActionAccountContext;
    persistence: ReturnType<typeof createUiConnectedAccountCredentialPersistence>;
    configuration: OwnerPorts['configuration'];
    configurationOwner: NonNullable<OwnerPorts['configurationOwner']>;
}>): Pick<UiConnectedAccountAuthenticationRuntime, 'materialize' | 'readConfiguredEndpoints'> {
    const { registration } = input.selected;
    const lifetime = registration.accountLifetime;
    const version = registration.pluginVersion;
    if (!lifetime || !version) throw new Error('connected_account_runtime_unavailable');
    const isCurrent = () => registration.lifecycle.isCurrent() && lifetime.isCurrent();
    const assertCurrent = async (signal?: AbortSignal) => {
        signal?.throwIfAborted();
        input.account.assertCurrent();
        if (!isCurrent()) throw new Error('connected_account_runtime_unavailable');
    };
    const run = async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
        await assertCurrent(signal);
        return work();
    };
    const contribution = { ref: input.declaration.service, descriptor: input.declaration.descriptor,
        occurrenceId: input.declaration.occurrenceId, sourceCustody: input.declaration.sourceCustody, isCurrent };
    const sameService = (ref: typeof input.declaration.service) => ref.pluginId === contribution.ref.pluginId
        && ref.localId === contribution.ref.localId;
    const dispatcher = createConnectedAccountEstablishedRuntimeDispatcher();
    const createOwner = (registerRawForRedaction?: (value: string) => void) => {
        // Per-invocation redaction custody never becomes retained registration state.
        const registry: ConnectedAccountEstablishedRuntimeRegistry = {
            connectedAccountContributions: { describe: ref => sameService(ref) ? contribution : null },
            async resolveConnectedAccountRuntime(ref) {
                return sameService(ref) ? { ...contribution, runtime: {} } : null;
            },
            connectedAccountRuntimeInvoker: { async invokeEstablished(invocation) {
                dispatcher.assertEstablishedTarget(invocation);
                const cancellation = mergeAbortSignals([registration.lifecycle.signal, invocation.signal]);
                const network = createPluginSurfaceAccountNetworkServices({ pluginId: contribution.ref.pluginId,
                    accountLifetime: lifetime, signal: cancellation.signal, isCurrent });
                const register = (value: string) => {
                    network.registerRawForRedaction(value);
                    registerRawForRedaction?.(value);
                };
                const fence = (phase?: 'beforeCallback' | 'afterCallback') =>
                    dispatcher.assertEstablishedFenceCurrent(invocation, contribution, cancellation.signal, phase);
                try {
                    await dispatcher.assertEstablishedAuthorityCurrent(invocation, contribution, cancellation.signal);
                    const context: ConnectedAccountPortableReadContext = {
                        ...invocation.context, plugin: { id: contribution.ref.pluginId, version },
                        contribution: { id: contribution.ref.localId,
                            qualifiedId: `${contribution.ref.pluginId}/connectedAccountDescriptors/${contribution.ref.localId}` },
                        surface: 'ui', invokedAtMs: Date.now(), signal: cancellation.signal,
                        services: { http: network.http },
                        configuration: { ...invocation.context.configuration, async getSecret(field, options) {
                            await fence();
                            const value = await invocation.context.configuration.getSecret(field, options);
                            await fence();
                            if (value !== null) register(value);
                            return value;
                        } },
                        credentials: { async get(key, options) {
                            await fence();
                            const value = await invocation.context.credentials.get(key, options);
                            await fence();
                            if (value !== null) register(value);
                            return value;
                        } },
                    };
                    return await dispatcher.invokeEstablishedRuntime(input.selected.runtime, contribution.descriptor,
                        context, invocation, register, fence, network.redactDiagnosticText);
                } finally { network.dispose(); cancellation.dispose(); }
            } },
        };
        return createConnectedAccountEstablishedRuntimeOwner({
            reloadController: { async acquireRuntimeRegistry() { return { registry, async release() {} }; },
                isRuntimeRegistryCurrent: candidate => candidate === registry && isCurrent() },
            readScope: { isAccountRuntimeCurrent: async () => isCurrent(), assertAccountRuntimeCurrent: assertCurrent,
                runMaterialization: run, runCurrentAccountRead: run, runIndependentAccountRead: run },
            getAccountEncryptionMode: (_signal, options) => input.persistence.content.resolveAccountMode(options?.usage),
            readCredential: ({ ref }) => input.persistence.readCredential(ref),
            readConfiguration: ({ target }) => input.persistence.readConfiguration(target.ref),
            configuration: input.configuration, configurationOwner: input.configurationOwner,
            openContent: ({ kind, accountMode, envelope }) => input.persistence.content.open(kind, accountMode, envelope),
            sealCredentialContent: (mode, plaintext) => input.persistence.content.seal('credential', mode, plaintext),
        });
    };
    return {
        materialize(request: ConnectedAccountPurposeMaterializationInput & Readonly<{
            registerRawForRedaction(value: string): void;
        }>) {
            return createConnectedAccountPurposeMaterializer(createOwner(request.registerRawForRedaction))(request);
        },
        readConfiguredEndpoints(request: Parameters<QualifiedConnectedAccountEstablishedRuntimeOwner['readConfiguredEndpoints']>[0]) {
            return createOwner().readConfiguredEndpoints(request);
        },
    };
}
