import {
    MachineLiveStreamCaptureSourceV1Schema,
    MachineLiveStreamCaptureUnavailableV1Schema,
    type MachineLiveStreamCaptureSourceV1,
    type MachineLiveStreamCaptureUnavailableV1,
} from '@happier-dev/protocol';

import type { MachineLiveStreamCaptureAdapter } from './captureAdapter';

export type MachineLiveStreamRegisteredCaptureSource = Readonly<{
    sourceId: string;
    streamFamily: string;
    adapter: MachineLiveStreamCaptureAdapter;
    capabilities: MachineLiveStreamCaptureSourceV1;
}>;

export type MachineLiveStreamCaptureRegistryResolveInput = Readonly<{
    sourceId?: string;
    streamFamily?: string;
}>;

export type MachineLiveStreamCaptureRegistryResolveResult = Readonly<
    | { ok: true; source: MachineLiveStreamRegisteredCaptureSource }
    | { ok: false; diagnostic: MachineLiveStreamCaptureUnavailableV1 }
>;

export type MachineLiveStreamCaptureRegistry = Readonly<{
    register: (source: MachineLiveStreamRegisteredCaptureSource) => void;
    unregister: (sourceId: string) => void;
    resolve: (input: MachineLiveStreamCaptureRegistryResolveInput) => MachineLiveStreamCaptureRegistryResolveResult;
    list: () => readonly MachineLiveStreamRegisteredCaptureSource[];
}>;

function unavailableDiagnostic(input: MachineLiveStreamCaptureRegistryResolveInput): MachineLiveStreamCaptureUnavailableV1 {
    return MachineLiveStreamCaptureUnavailableV1Schema.parse({
        v: 1,
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        reasonCode: 'capture_source_unavailable',
    });
}

export function createMachineLiveStreamCaptureRegistry(): MachineLiveStreamCaptureRegistry {
    const sourcesById = new Map<string, MachineLiveStreamRegisteredCaptureSource>();

    return {
        register: (source) => {
            const capabilities = MachineLiveStreamCaptureSourceV1Schema.parse(source.capabilities);
            sourcesById.set(source.sourceId, {
                ...source,
                capabilities,
            });
        },
        unregister: (sourceId) => {
            sourcesById.delete(sourceId);
        },
        resolve: (input) => {
            if (input.sourceId) {
                const source = sourcesById.get(input.sourceId);
                return source ? { ok: true, source } : { ok: false, diagnostic: unavailableDiagnostic(input) };
            }
            if (input.streamFamily) {
                const source = [...sourcesById.values()].find((entry) => entry.streamFamily === input.streamFamily);
                return source ? { ok: true, source } : { ok: false, diagnostic: unavailableDiagnostic(input) };
            }
            return { ok: false, diagnostic: unavailableDiagnostic(input) };
        },
        list: () => [...sourcesById.values()],
    };
}
