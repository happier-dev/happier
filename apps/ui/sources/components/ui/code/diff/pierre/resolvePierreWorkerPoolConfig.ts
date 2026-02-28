export type PierreDiffPresentationStyle = 'unified' | 'split';

export type PierreWorkerPoolConfig = Readonly<{
    poolSize: number;
    totalASTLRUCacheSize: number;
    defaultLineDiffType: 'none' | 'word-alt';
}>;

export function resolvePierreWorkerPoolConfig(style: PierreDiffPresentationStyle): PierreWorkerPoolConfig {
    if (style === 'unified') {
        return {
            poolSize: 1,
            totalASTLRUCacheSize: 24,
            defaultLineDiffType: 'none',
        };
    }
    return {
        poolSize: 2,
        totalASTLRUCacheSize: 56,
        defaultLineDiffType: 'word-alt',
    };
}
