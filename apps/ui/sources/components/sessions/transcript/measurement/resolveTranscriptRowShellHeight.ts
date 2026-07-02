import {
    isTranscriptItemHeightSignatureStable,
    type TranscriptItemHeightCache,
    type TranscriptItemHeightValiditySignature,
} from './transcriptItemHeightCache';

export type TranscriptRowShellHeightHint = Readonly<{
    minHeight: number;
}>;

export function resolveTranscriptRowShellHeight(params: Readonly<{
    cache: TranscriptItemHeightCache;
    signature: TranscriptItemHeightValiditySignature;
}>): TranscriptRowShellHeightHint | undefined {
    if (!isTranscriptItemHeightSignatureStable(params.signature)) return undefined;
    const entry = params.cache.get(params.signature);
    if (entry === undefined) return undefined;
    if (!Number.isFinite(entry.heightPx) || entry.heightPx <= 0) return undefined;
    return { minHeight: entry.heightPx };
}
