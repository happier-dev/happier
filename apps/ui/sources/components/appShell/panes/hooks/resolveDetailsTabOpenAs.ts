export type DetailsTabOpenIntent = 'default' | 'pinned' | 'preview';
export type DetailsTabOpenMode = 'preview' | 'pinned';

export type LastPreviewOpen = Readonly<{ key: string; atMs: number }>;

export type ExistingDetailsTabFlags = Readonly<{
    isPreview?: boolean;
    isPinned?: boolean;
}>;

export type ResolveDetailsTabOpenAsInput = Readonly<{
    detailsPaneTabsBehavior: 'persistent' | 'preview' | null | undefined;
    intent: DetailsTabOpenIntent;
    platform: 'web' | 'native';
    nowMs: number;
    tabKey: string;
    existingTab: ExistingDetailsTabFlags | null;
    lastPreviewOpen: LastPreviewOpen | null;
    doubleOpenPinThresholdMs?: number;
}>;

export type ResolveDetailsTabOpenAsResult = Readonly<{
    openAs: DetailsTabOpenMode;
    nextLastPreviewOpen: LastPreviewOpen | null;
}>;

export function resolveDetailsTabOpenAs(input: ResolveDetailsTabOpenAsInput): ResolveDetailsTabOpenAsResult {
    const thresholdMs = typeof input.doubleOpenPinThresholdMs === 'number'
        ? input.doubleOpenPinThresholdMs
        : 380;

    const baseOpenAs: DetailsTabOpenMode =
        input.detailsPaneTabsBehavior === 'persistent' || input.intent === 'pinned'
            ? 'pinned'
            : 'preview';

    const nextLastPreviewOpen: LastPreviewOpen | null =
        baseOpenAs === 'preview'
            ? { key: input.tabKey, atMs: input.nowMs }
            : input.lastPreviewOpen;

    if (input.platform !== 'web') {
        return { openAs: baseOpenAs, nextLastPreviewOpen };
    }

    if (baseOpenAs !== 'preview') {
        return { openAs: baseOpenAs, nextLastPreviewOpen };
    }

    const existing = input.existingTab;
    const existingIsPreview = existing?.isPreview === true && existing?.isPinned !== true;
    if (!existingIsPreview) {
        return { openAs: baseOpenAs, nextLastPreviewOpen };
    }

    const last = input.lastPreviewOpen;
    const isRapidReopen =
        last?.key === input.tabKey
        && (input.nowMs - last.atMs) > 0
        && (input.nowMs - last.atMs) <= thresholdMs;

    if (!isRapidReopen) {
        return { openAs: baseOpenAs, nextLastPreviewOpen };
    }

    return { openAs: 'pinned', nextLastPreviewOpen };
}
