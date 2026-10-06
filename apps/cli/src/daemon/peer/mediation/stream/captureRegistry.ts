import { MachineLiveStreamCaptureSourceV1Schema, MachineLiveStreamCaptureUnavailableV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/captureV1';
import type { MachineLiveStreamCaptureSourceV1, MachineLiveStreamCaptureUnavailableV1 } from '@happier-dev/protocol';
import type { PluginLiveStreamReferenceV1 } from '@happier-dev/protocol/plugins/ui';

import type { MachineLiveStreamCaptureAdapter } from './captureAdapter';
import type { ComputerCaptureSource } from '../../../computer/source';
import { randomUUID } from 'node:crypto';

export type MachineLiveStreamRegisteredCaptureSource = Readonly<{
    sourceId: string;
    streamFamily: string;
    adapter: MachineLiveStreamCaptureAdapter;
    capabilities: MachineLiveStreamCaptureSourceV1;
    /** Native target lifecycle and control share this exact registered capture source. */
    computer?: ComputerCaptureSource;
    /** Supplied only by manifest-backed activation, never renderer input. */
    plugin?: Readonly<{ pluginId: string; localId: string; occurrenceId: string }>;
    /** Retired when this exact source is unregistered or replaced. */
    retirementSignal?: AbortSignal;
    sourceOccurrenceId?: string;
}>;

export type MachineLiveStreamViewingReference = PluginLiveStreamReferenceV1;

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
    describeViewing(input: Readonly<{ pluginId: string; reference: MachineLiveStreamViewingReference }>):
        Readonly<{ ok: true; source: MachineLiveStreamRegisteredCaptureSource }>
        | Readonly<{ ok: false; reasonCode: 'capture_source_denied' | 'capture_source_unavailable' }>;
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
    const retirements = new Map<string, AbortController>();
    const describeViewing: MachineLiveStreamCaptureRegistry['describeViewing'] = (input) => {
        const reference = input.reference;
        if (reference.kind === 'plugin' && reference.source.pluginId !== input.pluginId) {
            return { ok: false, reasonCode: 'capture_source_denied' };
        }
        const source = reference.kind === 'host' ? sourcesById.get(reference.sourceId)
            : [...sourcesById.values()].find(candidate => candidate.plugin?.pluginId === input.pluginId
                && candidate.plugin.localId === reference.source.localId);
        if (!source || source.retirementSignal?.aborted) return { ok: false, reasonCode: 'capture_source_unavailable' };
        if (reference.kind === 'host' && source.plugin) return { ok: false, reasonCode: 'capture_source_denied' };
        return { ok: true, source };
    };

    return {
        register: (source) => {
            const capabilities = MachineLiveStreamCaptureSourceV1Schema.parse(source.capabilities);
            retirements.get(source.sourceId)?.abort();
            const retirement = new AbortController();
            retirements.set(source.sourceId, retirement);
            const retire = () => retirement.abort();
            source.retirementSignal?.addEventListener('abort', retire, { once: true });
            retirement.signal.addEventListener('abort', () => source.retirementSignal?.removeEventListener('abort', retire), { once: true });
            if (source.retirementSignal?.aborted) retirement.abort();
            sourcesById.set(source.sourceId, {
                ...source,
                capabilities,
                retirementSignal: retirement.signal,
                sourceOccurrenceId: randomUUID(),
            });
        },
        unregister: (sourceId) => {
            retirements.get(sourceId)?.abort();
            retirements.delete(sourceId);
            sourcesById.delete(sourceId);
        },
        resolve: (input) => {
            if (input.sourceId) {
                const source = sourcesById.get(input.sourceId);
                return source && !source.retirementSignal?.aborted && (!input.streamFamily || source.streamFamily === input.streamFamily)
                    ? { ok: true, source } : { ok: false, diagnostic: unavailableDiagnostic(input) };
            }
            if (input.streamFamily) {
                const sources = [...sourcesById.values()].filter((entry) => !entry.retirementSignal?.aborted && entry.streamFamily === input.streamFamily);
                return sources.length === 1 ? { ok: true, source: sources[0]! } : { ok: false, diagnostic: unavailableDiagnostic(input) };
            }
            return { ok: false, diagnostic: unavailableDiagnostic(input) };
        },
        list: () => [...sourcesById.values()].filter(source => !source.retirementSignal?.aborted),
        describeViewing,
    };
}
