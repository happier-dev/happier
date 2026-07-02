import type { ProviderId, ProviderProtocol } from '../types';

type ProviderTraceProtocolMatcherInput = {
    providerId: ProviderId;
    providerProtocol: ProviderProtocol;
    eventProtocol: string | null | undefined;
};

export function providerTraceProtocolMatches(params: ProviderTraceProtocolMatcherInput): boolean {
    if (typeof params.eventProtocol !== 'string' || params.eventProtocol.length === 0) {
        return false;
    }
    if (params.eventProtocol === params.providerProtocol) {
        return true;
    }
    if (params.providerId === 'codex') {
        return params.eventProtocol === 'acp' || params.eventProtocol === 'codex';
    }
    return false;
}
