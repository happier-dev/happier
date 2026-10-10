import { randomBytes } from 'node:crypto';

import type { ProviderCredentialTransportV1 } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import { openPinnedHttpStream } from '@/network/pinnedHttp';
import { resolveUrlConnectionIdentity } from '@/network/urlConnectionIdentity';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';
import { renderProviderProbeCredential } from '@/providers/spawn/runtimeCredential';
import { RunnerDaemonSharedGatewayHttpBindingV1Schema, type RunnerDaemonSharedGatewayHttpBindingV1 } from './agentRuntimeDaemonPluginServicesProtocol';
import { createRunnerManagedProviderBindingLaunchEnvironmentTransformer } from './runnerManagedProviderBindingMaterialization';
import type { ProviderBrokerRequestHandler } from '@/providers/broker/providerBrokerRequestHandler';
import type { ManagedServiceRequest } from '@happier-dev/plugin-sdk/managed-services';
import type { ExecutionRunManagedProviderSourceOpener } from '@/agent/runtime/bridges/executionRun/runtime/managedProvider';
import type { RunnerManagedProviderRunServices } from './agentRuntimeDaemonServiceAuthorityClient';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';

/** Private attached Run source transport; the daemon reconstructs authority
 * from the full original proof, never from this disposable cleanup handle. */
export function createRunnerManagedProviderRunSourceOpener(input: Readonly<{
    services: RunnerManagedProviderRunServices;
    isOwnerCurrent(): Promise<boolean>;
}>): ExecutionRunManagedProviderSourceOpener {
    return async request => {
        const consumer = request.request.consumer;
        const occurrence = request.request.executionRunOccurrenceId;
        if (consumer.kind !== 'execution_run' || !occurrence || !await input.isOwnerCurrent()
            || request.signal.aborted || !await request.isCurrent()) return null;
        const proof = { executionRunId: consumer.executionRunId, executionRunOccurrenceId: occurrence,
            agentId: request.agentId, modelId: request.modelId, runtimeBindingBasis: request.runtimeBindingBasis,
            expectedAccountSettingsScopeKey: request.expectedAccountSettingsScopeKey };
        const opened = await input.services.openBinding({ ...proof, signal: request.signal });
        let bindingId = opened.bindingId;
        let retired = false;
        const resources = createProviderLaunchResourceScope();
        resources.register(async () => await input.services.closeBinding({ bindingId }));
        const cleanup = async () => {
            retired = true;
            await resources.release();
        };
        const readAccess = async ({ signal }: Readonly<{ signal: AbortSignal }>) => {
            if (retired || !await input.isOwnerCurrent() || request.signal.aborted || !await request.isCurrent()) {
                throw createProviderErrorV1('provider_authorization_changed', { connectionId: proof.runtimeBindingBasis.connectionId });
            }
            const result = await input.services.readBinding({ ...proof, bindingId, signal });
            signal.throwIfAborted();
            if (retired || !await input.isOwnerCurrent() || request.signal.aborted || !await request.isCurrent()) {
                throw createProviderErrorV1('provider_authorization_changed', { connectionId: proof.runtimeBindingBasis.connectionId });
            }
            bindingId = result.bindingId;
            return { endpointUrl: result.endpointUrl, headers: result.headers };
        };
        const forward = createRunnerManagedProviderHttpBindingRequest(readAccess);
        return { access: {
            endpointUrl: template => template === proof.runtimeBindingBasis.endpoint.endpointTemplateId ? opened.endpointUrl : null,
            request: async requestInput => {
                const result = await forward(requestInput);
                if (!result.ok) throw createProviderErrorV1('provider_endpoint_unavailable', { connectionId: proof.runtimeBindingBasis.connectionId });
                return result.response;
            },
        },
        revalidate: async signal => {
            try { await readAccess({ signal: signal ?? request.signal }); return true; }
            catch { (signal ?? request.signal).throwIfAborted(); return false; }
        }, retire: cleanup, cleanup };
    };
}

/** One pinned HTTP effect after a fresh private access read; never retries or
 * replays Agent requests. Shared Session and Run listeners consume this owner. */
export function createRunnerManagedProviderHttpBindingRequest(
    readAccess: (options: Readonly<{ signal: AbortSignal }>) => Promise<RunnerDaemonSharedGatewayHttpBindingV1>,
): (request: ManagedServiceRequest) => ReturnType<ProviderBrokerRequestHandler> {
    return async request => {
        const signal = request.signal ?? new AbortController().signal;
        try {
            const access = RunnerDaemonSharedGatewayHttpBindingV1Schema.parse(await readAccess({ signal }));
            signal.throwIfAborted();
            const origin = new URL(access.endpointUrl);
            const url = new URL(request.pathAndQuery, origin.origin);
            if (url.origin !== origin.origin) return { ok: false, reasonCode: 'route_not_allowed' };
            const response = await openPinnedHttpStream({ url: url.toString(),
                validatedAddresses: [resolveUrlConnectionIdentity(origin.hostname).hostname],
                method: request.method, ...(request.body ? { body: request.body } : {}),
                headers: { ...request.headers, ...access.headers }, signal });
            let cancelled = false;
            const cancelResponse = () => { if (!cancelled) { cancelled = true; response.cancel(); } };
            return { ok: true, response: { ok: true, status: response.status, statusText: '',
                headers: Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => entry[1] !== undefined)),
                body: new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        try { const bytes = await response.read(); if (bytes === null) controller.close(); else controller.enqueue(bytes); }
                        catch (error) { cancelResponse(); controller.error(error); }
                    },
                    cancel: cancelResponse,
                }),
            } };
        } catch {
            return { ok: false, reasonCode: 'broker_unavailable' };
        }
    };
}

/** The runner retains delivery access only. Every upstream projection is freshly admitted by its daemon. */
export async function createRunnerManagedProviderConsumerAccess(input: Readonly<{
    signal: AbortSignal;
    credentialTransport: ProviderCredentialTransportV1 | null;
    readAccess(options?: Readonly<{ signal?: AbortSignal }>): Promise<RunnerDaemonSharedGatewayHttpBindingV1>;
    materialize(input: Readonly<{ endpointUrl: string; credentialPlaceholder: string | null }>): Promise<unknown>;
}>) {
    const transport = input.credentialTransport;
    if (transport?.destination.kind !== 'httpHeader') {
        throw new PluginError({ code: 'plugin_services_managed_provider_authority_unavailable', message: 'Shared Provider access requires an admitted Agent credential transport' });
    }
    input.signal.throwIfAborted();
    const initial = RunnerDaemonSharedGatewayHttpBindingV1Schema.parse(await input.readAccess({ signal: input.signal }));
    const placeholder = `happier_consumer_${randomBytes(32).toString('hex')}`;
    const renderedPlaceholder = renderProviderProbeCredential(placeholder, transport).value;
    const consumer = await startManagedProviderConsumerApplication({
        signal: input.signal, endpointUrl: initial.endpointUrl, credentialTransport: transport,
        request: createRunnerManagedProviderHttpBindingRequest(options => input.readAccess(options)),
    });
    try {
        input.signal.throwIfAborted();
        const materialization = await input.materialize({ endpointUrl: consumer.endpointUrl, credentialPlaceholder: placeholder });
        input.signal.throwIfAborted();
        const transformed = createRunnerManagedProviderBindingLaunchEnvironmentTransformer({
            materialization, placeholder, credential: consumer.credential,
            // Raw transports still use the canonical raw marker slot. A distinct
            // rendered variant lets the transformer fence both representations.
            renderedPlaceholder: renderedPlaceholder === placeholder ? `Bearer ${placeholder}` : renderedPlaceholder,
            renderedCredential: consumer.renderedCredential === consumer.credential ? `Bearer ${consumer.credential}` : consumer.renderedCredential,
            isCurrent: consumer.isCurrent,
        });
        return Object.freeze({
            materialization: transformed.materialization,
            redactionValues: transformed.redactionValues,
            transformLaunchEnvironment: transformed.transform,
            cleanup: consumer.cleanup,
        });
    } catch (error) {
        await consumer.cleanup();
        throw error;
    }
}
