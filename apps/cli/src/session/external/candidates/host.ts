import type {
    ExternalSessionCandidateHostListRequestV1,
    ExternalSessionCandidatePageV1,
} from '@happier-dev/agents';
import type { ExternalSessionsProviderId } from '@happier-dev/protocol';

export type ExternalSessionCandidateHostAdapter = Readonly<{
    providerId: ExternalSessionsProviderId;
    listViaChildHost(input: ExternalSessionCandidateHostListRequestV1): Promise<ExternalSessionCandidatePageV1>;
}>;

export type ExternalSessionCandidateHostService = Readonly<{
    listViaChildHost(input: ExternalSessionCandidateHostListRequestV1): Promise<ExternalSessionCandidatePageV1>;
}>;

function buildAdapterMap(adapters: readonly ExternalSessionCandidateHostAdapter[]) {
    const map = new Map<ExternalSessionsProviderId, ExternalSessionCandidateHostAdapter>();
    for (const adapter of adapters) {
        if (map.has(adapter.providerId)) {
            throw new Error(`Duplicate external-session candidate host adapter for ${adapter.providerId}`);
        }
        map.set(adapter.providerId, adapter);
    }
    return map;
}

export function createExternalSessionCandidateHostService(params: Readonly<{
    adapters: readonly ExternalSessionCandidateHostAdapter[];
}>): ExternalSessionCandidateHostService {
    const adapters = buildAdapterMap(params.adapters);

    return Object.freeze({
        listViaChildHost: async (input) => {
            const adapter = adapters.get(input.providerId);
            if (!adapter) {
                throw new Error(`Missing external-session candidate host adapter for ${input.providerId}`);
            }
            return await adapter.listViaChildHost(input);
        },
    });
}
