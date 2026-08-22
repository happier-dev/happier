import { lookup } from 'node:dns/promises';

import {
    assessProviderEndpoint,
    type VoiceSpeechEndpointPolicy,
} from '@happier-dev/protocol';

function unavailable(): Error {
    return Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable' });
}

function isWithinBasePath(base: URL, request: URL): boolean {
    const basePath = base.pathname.replace(/\/+$/u, '');
    return request.pathname === basePath || request.pathname.startsWith(`${basePath}/`);
}

/** Final-attempt admission for contribution-owned speech HTTP. */
export async function revalidateVoiceSpeechHttpEndpoint(input: Readonly<{
    policy: VoiceSpeechEndpointPolicy;
    requestUrl: string;
    resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
}>): Promise<void> {
    let base: URL;
    let request: URL;
    try {
        base = new URL(input.policy.normalizedBaseUrl);
        request = new URL(input.requestUrl);
    } catch {
        throw unavailable();
    }
    if (
        request.origin !== input.policy.origin
        || request.origin !== base.origin
        || request.search.length > 0
        || request.hash.length > 0
        || !isWithinBasePath(base, request)
        || (request.protocol === 'http:' && !input.policy.insecureHttpConfirmed)
    ) throw unavailable();

    const resolveAddresses = input.resolveAddresses ?? (async (hostname: string) => (
        await lookup(hostname, { all: true, verbatim: true })
    ).map((answer) => answer.address));
    try {
        const syntax = new URL(input.policy.normalizedBaseUrl);
        const resolvedAddresses = await resolveAddresses(syntax.hostname.replace(/^\[|\]$/gu, ''));
        assessProviderEndpoint(input.policy.normalizedBaseUrl, {
            resolvedAddresses,
            privateNetworkConfirmed: input.policy.insecureHttpConfirmed,
        });
    } catch {
        throw unavailable();
    }
}
