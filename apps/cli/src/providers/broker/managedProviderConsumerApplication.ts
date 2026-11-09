import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ManagedServiceRequest } from '@happier-dev/plugin-sdk/managed-services';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ProviderCredentialTransportV1 } from '@happier-dev/protocol';

import { renderProviderProbeCredential } from '@/providers/spawn/runtimeCredential';
import { startProviderBrokerApplicationServer } from './providerBrokerApplicationServer';
import type { ProviderBrokerRequestHandler } from './providerBrokerRequestHandler';
import { sanitizeProviderBrokerRequestV1 } from './requestPolicyV1';

/** Stable consumer delivery only; its request port retains source admission and upstream custody. */
export async function startManagedProviderConsumerApplication(input: Readonly<{
    signal: AbortSignal;
    endpointUrl: string;
    credentialTransport: ProviderCredentialTransportV1 | null;
    request(request: ManagedServiceRequest & Readonly<{ signal: AbortSignal }>): ReturnType<ProviderBrokerRequestHandler>;
}>) {
    const transport = input.credentialTransport;
    if (transport?.destination.kind !== 'httpHeader') {
        throw new PluginError({ code: 'plugin_services_managed_provider_authority_unavailable', message: 'Shared Provider access requires an admitted Agent credential transport' });
    }
    input.signal.throwIfAborted();
    const credential = randomBytes(32).toString('base64url');
    const renderedCredential = renderProviderProbeCredential(credential, transport).value;
    const localCredentialHeader = transport.destination.name.toLowerCase();
    const lifetime = new AbortController();
    const isCurrent = () => !input.signal.aborted && !lifetime.signal.aborted;
    const server = await startProviderBrokerApplicationServer({
        handler: async () => ({ ok: false, reasonCode: 'transport_identity_mismatch' }),
        localConsumer: {
            authorize(headers) {
                if (!isCurrent()) return false;
                const presented = Buffer.from(headers[localCredentialHeader] ?? '', 'utf8');
                const expected = Buffer.from(renderedCredential, 'utf8');
                return presented.length === expected.length && timingSafeEqual(presented, expected);
            },
            request: async request => {
                const headers = Object.fromEntries(Object.entries(request.headers ?? {}).flatMap(([name, value]) => {
                    if (name.toLowerCase() === localCredentialHeader || name.toLowerCase() === 'x-happier-machine-local-capability') return [];
                    // Downstream access credentials never reach any upstream
                    // transport; source-owned headers are added by that owner.
                    return [[name, value]];
                }));
                const signal = AbortSignal.any([input.signal, lifetime.signal, ...(request.signal ? [request.signal] : [])]);
                const sanitized = sanitizeProviderBrokerRequestV1({ ...request, headers, signal });
                return sanitized
                    ? input.request({ ...sanitized, signal })
                    : { ok: false, reasonCode: 'request_malformed' };
            },
        },
    });
    let cleanup: Promise<void> | null = null;
    const close = (): Promise<void> => {
        lifetime.abort();
        input.signal.removeEventListener('abort', onAbort);
        cleanup ??= server.close();
        return cleanup;
    };
    const onAbort = () => { void close().catch(() => undefined); };
    input.signal.addEventListener('abort', onAbort, { once: true });
    try {
        input.signal.throwIfAborted();
        return Object.freeze({
            endpointUrl: `${server.localConsumerEndpointUrl}${new URL(input.endpointUrl).pathname}`,
            credential,
            renderedCredential,
            isCurrent,
            cleanup: close,
        });
    } catch (error) {
        await close();
        throw error;
    }
}
