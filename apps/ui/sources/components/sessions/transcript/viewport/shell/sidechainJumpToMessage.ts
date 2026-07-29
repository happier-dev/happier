import {
    performSidechainIndexCommand,
    type SidechainListCommandRef,
} from '@/components/sessions/transcript/viewport/driver/sidechainListCommands';
import type { SidechainOlderPageLoadResult } from './sidechainOlderPageLoad';

export const SIDECHAIN_JUMP_TO_MESSAGE_MAX_OLDER_LOAD_ATTEMPTS = 25;

export type SidechainJumpToMessageTarget<TItem> =
    | Readonly<{ ok: false }>
    | Readonly<{
        ok: true;
        match: 'contained' | 'owner';
        targetIndex: number;
        targetItem: TItem;
    }>;

export type SidechainJumpToMessageListRef = SidechainListCommandRef;

export function resolveSidechainJumpToMessageTarget<TItem>(params: Readonly<{
    containsMessageId: (item: TItem, messageId: string) => boolean;
    items: readonly TItem[];
    messageId: string;
    ownsMessageId: (item: TItem, messageId: string) => boolean;
}>): SidechainJumpToMessageTarget<TItem> {
    const owningIndex = params.items.findIndex((item) => params.ownsMessageId(item, params.messageId));
    if (owningIndex >= 0) {
        return {
            ok: true,
            match: 'owner',
            targetIndex: owningIndex,
            targetItem: params.items[owningIndex]!,
        };
    }

    const containedIndex = params.items.findIndex((item) => params.containsMessageId(item, params.messageId));
    if (containedIndex >= 0) {
        return {
            ok: true,
            match: 'contained',
            targetIndex: containedIndex,
            targetItem: params.items[containedIndex]!,
        };
    }

    return { ok: false };
}

export function applySidechainJumpToMessage(params: Readonly<{
    estimatedItemSizePx: number;
    listRef: SidechainJumpToMessageListRef | null | undefined;
    targetIndex: number;
}>): boolean {
    return performSidechainIndexCommand({
        animated: true,
        estimatedItemSizePx: params.estimatedItemSizePx,
        listRef: params.listRef,
        targetIndex: params.targetIndex,
        viewPosition: 0.5,
    });
}

export type SidechainJumpToMessageRequestResult<TItem> =
    | Readonly<{
        ok: false;
        loadedPages: number;
        reason: 'aborted' | 'load-unavailable' | 'not_found';
    }>
    | Readonly<{
        ok: true;
        applied: boolean;
        loadedPages: number;
        match: 'contained' | 'owner';
        targetIndex: number;
        targetItem: TItem;
    }>;

export async function applySidechainJumpToMessageRequest<TItem>(params: Readonly<{
    containsMessageId: (item: TItem, messageId: string) => boolean;
    estimatedItemSizePx: number;
    getItems: () => readonly TItem[];
    listRef: SidechainJumpToMessageListRef | null | undefined;
    loadOlder: () => Promise<SidechainOlderPageLoadResult | null>;
    messageId: string;
    ownsMessageId: (item: TItem, messageId: string) => boolean;
    signal?: Readonly<{ aborted: boolean }> | null;
    yieldForRender?: () => Promise<void>;
}>): Promise<SidechainJumpToMessageRequestResult<TItem>> {
    let loadedPages = 0;
    let exhaustedOlderPages = false;
    for (let i = 0; i < SIDECHAIN_JUMP_TO_MESSAGE_MAX_OLDER_LOAD_ATTEMPTS; i += 1) {
        if (isSidechainJumpSignalAborted(params.signal)) {
            return { ok: false, loadedPages, reason: 'aborted' };
        }

        const target = resolveSidechainJumpToMessageTarget({
            containsMessageId: params.containsMessageId,
            items: params.getItems(),
            messageId: params.messageId,
            ownsMessageId: params.ownsMessageId,
        });
        if (target.ok) {
            const applied = applySidechainJumpToMessage({
                estimatedItemSizePx: params.estimatedItemSizePx,
                listRef: params.listRef,
                targetIndex: target.targetIndex,
            });
            return {
                ok: true,
                applied,
                loadedPages,
                match: target.match,
                targetIndex: target.targetIndex,
                targetItem: target.targetItem,
            };
        }

        if (exhaustedOlderPages) {
            return { ok: false, loadedPages, reason: 'not_found' };
        }

        const result = await params.loadOlder();
        if (!result) {
            return { ok: false, loadedPages, reason: 'load-unavailable' };
        }
        if (isSidechainJumpSignalAborted(params.signal)) {
            return { ok: false, loadedPages, reason: 'aborted' };
        }
        if ((result.status === 'no_more' || result.hasMore === false) && result.loaded <= 0) {
            return { ok: false, loadedPages, reason: 'not_found' };
        }

        loadedPages += 1;
        if (result.status === 'no_more' || result.hasMore === false) {
            exhaustedOlderPages = true;
        }
        await (params.yieldForRender?.() ?? Promise.resolve());
    }

    if (isSidechainJumpSignalAborted(params.signal)) {
        return { ok: false, loadedPages, reason: 'aborted' };
    }
    const finalTarget = resolveSidechainJumpToMessageTarget({
        containsMessageId: params.containsMessageId,
        items: params.getItems(),
        messageId: params.messageId,
        ownsMessageId: params.ownsMessageId,
    });
    if (finalTarget.ok) {
        const applied = applySidechainJumpToMessage({
            estimatedItemSizePx: params.estimatedItemSizePx,
            listRef: params.listRef,
            targetIndex: finalTarget.targetIndex,
        });
        return {
            ok: true,
            applied,
            loadedPages,
            match: finalTarget.match,
            targetIndex: finalTarget.targetIndex,
            targetItem: finalTarget.targetItem,
        };
    }

    return { ok: false, loadedPages, reason: 'not_found' };
}

function isSidechainJumpSignalAborted(signal: Readonly<{ aborted: boolean }> | null | undefined): boolean {
    return Boolean(signal?.aborted);
}
