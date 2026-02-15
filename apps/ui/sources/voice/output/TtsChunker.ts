export type TtsChunker = Readonly<{
    push: (textDelta: string) => string[];
    flush: () => string[];
}>;

function clampChunkChars(raw: unknown): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 200;
    return Math.max(32, Math.min(2000, n));
}

export function resolveStreamingTtsChunkChars(raw: unknown): number {
    return clampChunkChars(raw);
}

function lastBoundaryIndex(text: string, maxChars: number): number {
    const limit = Math.min(text.length, maxChars);
    const scoped = text.slice(0, limit);

    for (let i = scoped.length - 1; i >= 0; i -= 1) {
        const c = scoped[i];
        if (c === '.' || c === '!' || c === '?' || c === '\n') {
            return i + 1;
        }
    }

    for (let i = scoped.length - 1; i >= 0; i -= 1) {
        if (/\s/.test(scoped[i])) {
            return i + 1;
        }
    }

    return limit;
}

export function createTtsChunker(chunkChars: number): TtsChunker {
    const bounded = clampChunkChars(chunkChars);
    let buffer = '';

    const drain = (force: boolean): string[] => {
        const chunks: string[] = [];

        while (buffer.trim().length > 0) {
            if (!force && buffer.length < bounded) {
                break;
            }

            const isFinalSmallChunk = force && buffer.length <= bounded;
            const cut = isFinalSmallChunk ? buffer.length : lastBoundaryIndex(buffer, bounded);
            const nextChunk = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut).trimStart();

            if (!nextChunk) {
                if (!force) break;
                continue;
            }
            chunks.push(nextChunk);

            if (!force && buffer.length < bounded) {
                break;
            }
        }

        return chunks;
    };

    return {
        push: (textDelta: string) => {
            if (typeof textDelta !== 'string' || textDelta.length === 0) {
                return [];
            }
            buffer += textDelta;
            return drain(false);
        },
        flush: () => drain(true),
    };
}
