export type LoadOlderMessagesResult =
    | { status: 'loaded'; hasMore: boolean }
    | { status: 'no_more' };

export async function jumpToTranscriptSeq(params: Readonly<{
    targetSeq: number;
    getIndex: () => number | null;
    loadOlder: () => Promise<LoadOlderMessagesResult>;
    afterLoadOlder?: () => Promise<void>;
    scrollToIndex: (index: number) => void;
    maxLoads: number;
}>): Promise<Readonly<{ status: 'scrolled' | 'not_found' }>> {
    const targetSeq = Math.max(0, Math.trunc(params.targetSeq));
    if (!Number.isFinite(targetSeq)) return { status: 'not_found' };

    const immediateIndex = params.getIndex();
    if (typeof immediateIndex === 'number' && Number.isFinite(immediateIndex) && immediateIndex >= 0) {
        params.scrollToIndex(Math.trunc(immediateIndex));
        return { status: 'scrolled' };
    }

    const maxLoads = Math.max(0, Math.trunc(params.maxLoads));
    const afterLoadOlder = params.afterLoadOlder ?? (async () => {});
    for (let i = 0; i < maxLoads; i++) {
        const loaded = await params.loadOlder();
        await afterLoadOlder();
        const idx = params.getIndex();
        if (typeof idx === 'number' && Number.isFinite(idx) && idx >= 0) {
            params.scrollToIndex(Math.trunc(idx));
            return { status: 'scrolled' };
        }
        if (loaded.status === 'no_more') break;
    }

    return { status: 'not_found' };
}
