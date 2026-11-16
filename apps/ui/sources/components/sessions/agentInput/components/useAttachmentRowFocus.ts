import * as React from 'react';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { restoreFocusToBestTarget, type FocusReturnRef, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { hapticsLight } from '@/components/ui/theme/haptics';

type AttachmentKey = Readonly<{ key: string }>;
type PendingAttachmentFocus = Readonly<{ removedKey: string; neighborKeys: readonly string[] }>;

function neighborKeys(items: readonly AttachmentKey[], key: string): readonly string[] {
    const index = items.findIndex((item) => item.key === key);
    return index < 0 ? [] : [items[index + 1]?.key, items[index - 1]?.key].filter(
        (value): value is string => typeof value === 'string',
    );
}

/** The row owns the same neighbor → Composer return for direct and picker removals. */
export function useAttachmentRowFocus(items: readonly AttachmentKey[], onRequestComposerFocus?: () => void) {
    const targets = React.useRef(new Map<string, FocusReturnTarget>());
    const pending = React.useRef<PendingAttachmentFocus | null>(null);
    const restore = useEventCallback((neighbors: readonly string[]) => {
        for (const key of neighbors) {
            if (restoreFocusToBestTarget({ current: targets.current.get(key) })) return;
        }
        onRequestComposerFocus?.();
    });
    const attachmentFocusRef = React.useCallback((key: string, anchorRef?: React.RefObject<unknown>) => (target: FocusReturnTarget): void => {
        if (anchorRef) (anchorRef as React.MutableRefObject<unknown | null>).current = target;
        if (target === null) targets.current.delete(key);
        else targets.current.set(key, target);
    }, []);
    const requestAttachmentRemoval = useEventCallback((item: AttachmentKey, onRemove: (() => void) | undefined) => {
        if (!onRemove) return;
        pending.current = { removedKey: item.key, neighborKeys: neighborKeys(items, item.key) };
        hapticsLight();
        onRemove();
    });
    const createFocusReturnRef = useEventCallback((key: string, origin: FocusReturnRef): FocusReturnRef => {
        const neighbors = neighborKeys(items, key);
        return {
            get current() { return origin?.current; },
            fallback: { focus: () => restore(neighbors) },
        };
    });
    React.useLayoutEffect(() => {
        const removal = pending.current;
        if (!removal || items.some((item) => item.key === removal.removedKey)) return;
        pending.current = null;
        restore(removal.neighborKeys);
    }, [items, restore]);
    return { attachmentFocusRef, requestAttachmentRemoval, createFocusReturnRef };
}
