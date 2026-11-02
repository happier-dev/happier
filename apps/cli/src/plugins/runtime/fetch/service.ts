import { AsyncLocalStorage } from 'node:async_hooks';
import { createPluginHttpService as createPortablePluginHttpService, createStablePluginHttpHost as createPortableStablePluginHttpHost,
    type CreatePluginHttpServiceParams, type StablePluginHttpHost as PortableStablePluginHttpHost, type StablePluginHttpPurposeHost as PortableStablePluginHttpPurposeHost, type StablePluginHttpCredentialBindingHost as PortableStablePluginHttpCredentialBindingHost, type StablePluginHttpHostParams as PortableStablePluginHttpHostParams, type StablePluginHttpBindingPolicy as PortableStablePluginHttpBindingPolicy } from '@happier-dev/cli-common/plugins/http';
import { runTracedExternalActionInnerStage } from '@/daemon/externalActions/externalActionPhase';
import type { PluginInvocationServicesSeed, PluginInvocationServiceBinding } from '../invocation/services/types';
import { normalizePluginWebSocketOpenInput } from './webSocket';

export { MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES } from '@happier-dev/cli-common/plugins/http';
export type { CreatePluginHttpServiceParams, PluginRequestInterceptorDeclarationV1, PluginRequestInterceptorBindingV1, PluginRequestInterceptorRegistryV1, PluginHttpRuntimeRequestOptions, PluginHttpRuntimeAdapter, PluginHttpPurposeInjection } from '@happier-dev/cli-common/plugins/http';
export type StablePluginHttpHost = PortableStablePluginHttpHost<PluginInvocationServicesSeed, PluginInvocationServiceBinding>;
export type StablePluginHttpPurposeHost = PortableStablePluginHttpPurposeHost<PluginInvocationServicesSeed, PluginInvocationServiceBinding>;
export type StablePluginHttpCredentialBindingHost = PortableStablePluginHttpCredentialBindingHost<PluginInvocationServicesSeed, PluginInvocationServiceBinding>;
export type StablePluginHttpHostParams = PortableStablePluginHttpHostParams<PluginInvocationServicesSeed, PluginInvocationServiceBinding>;
export type StablePluginHttpBindingPolicy = PortableStablePluginHttpBindingPolicy<PluginInvocationServicesSeed, PluginInvocationServiceBinding>;

// Ambient Node operation context and host tracing never enter the portable graph.
const operationContext = new AsyncLocalStorage<Set<string>>();
export function createPluginHttpService(params: CreatePluginHttpServiceParams) {
    return createPortablePluginHttpService({ ...params, operationContext, trace: runTracedExternalActionInnerStage });
}
export function createStablePluginHttpHost(params: StablePluginHttpHostParams): StablePluginHttpHost {
    return createPortableStablePluginHttpHost({ ...params, operationContext, trace: runTracedExternalActionInnerStage,
        adapter: { ...params.adapter, async openWebSocket(input, options) {
            normalizePluginWebSocketOpenInput(input);
            return await params.adapter.openWebSocket(input, options);
        } } });
}
