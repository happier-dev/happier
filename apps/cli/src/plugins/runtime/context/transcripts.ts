import type {
    TranscriptAppendTurnV1,
    TranscriptSourceDefinitionV1,
    TranscriptsRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import { createPluginTranscriptFileFollowService } from './transcripts/fileFollow';
import type { TranscriptFileFollowPathGrantRegistry } from './transcripts/fileFollowGrants';

const DEFAULT_MAX_TRANSCRIPT_SOURCES = 32;

export function createPluginTranscriptsService(params: Readonly<{
    append: (turn: TranscriptAppendTurnV1) => Promise<void>;
    maxSources?: number;
    addDisposable?: (disposable: Readonly<{ dispose: () => void | Promise<void> }>) => unknown;
    pluginId?: string;
    runtimeId?: string;
    readSessionId?: () => string | null;
    fileFollowAllowedPathRoots?: readonly string[];
    fileFollowPathGrants?: TranscriptFileFollowPathGrantRegistry;
}>): TranscriptsRuntimeServiceV1 {
    const sources = new Map<string, Readonly<{
        definition: TranscriptSourceDefinitionV1<unknown>;
        dispose: () => Promise<void>;
    }>>();
    const maxSources = Math.max(1, params.maxSources ?? DEFAULT_MAX_TRANSCRIPT_SOURCES);

    const service: TranscriptsRuntimeServiceV1 = Object.freeze({
        append: params.append,
        fileFollow: createPluginTranscriptFileFollowService({
            pluginId: params.pluginId,
            runtimeId: params.runtimeId,
            readSessionId: params.readSessionId,
            allowedPathRoots: params.fileFollowAllowedPathRoots,
            fileFollowPathGrants: params.fileFollowPathGrants,
            addDisposable: params.addDisposable,
        }),
        async defineSource<TItem = unknown>(definition: TranscriptSourceDefinitionV1<TItem>) {
            const id = definition.id.trim();
            if (id.length === 0) {
                throw new Error('ctx.transcripts.defineSource requires a non-empty source id');
            }
            if (sources.has(id)) {
                throw new Error(`ctx.transcripts.defineSource source '${id}' is already registered`);
            }
            if (sources.size >= maxSources) {
                throw new Error(`ctx.transcripts.defineSource cannot register more than ${maxSources} sources`);
            }
            const lease = await definition.acquireFollowLease?.({ reason: 'plugin-runtime-source' }) ?? null;
            let disposed = false;
            const source = Object.freeze({
                async dispose() {
                    if (disposed) {
                        return;
                    }
                    disposed = true;
                    sources.delete(id);
                    await lease?.release();
                },
            });
            sources.set(id, Object.freeze({
                definition: definition as TranscriptSourceDefinitionV1<unknown>,
                dispose: source.dispose,
            }));
            params.addDisposable?.(source);
            return Object.freeze({
                id,
                async dispose() {
                    await source.dispose();
                },
            });
        },
    });
    return service;
}
