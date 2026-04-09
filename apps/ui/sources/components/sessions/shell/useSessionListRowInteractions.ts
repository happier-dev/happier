import * as React from 'react';
import { useSharedValue } from 'react-native-reanimated';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { setTagsForSession } from './sessionTagUtils';

export function useSessionListRowInteractions(input: Readonly<{
    listItems: ReadonlyArray<SessionListIndexItem> | null;
    currentGroupOrderMap: Readonly<Record<string, string[]>>;
    canReorderSessions: boolean;
    setSessionListGroupOrderV1: (value: Record<string, string[]>) => void;
    pinnedKeyList: ReadonlyArray<string>;
    pinnedKeySet: ReadonlySet<string>;
    setPinnedSessionKeysV1: (value: string[]) => void;
    sessionTags: Readonly<Record<string, string[]>>;
    setSessionTagsV1: (value: Record<string, string[]>) => void;
}>) {
    const listItemsRef = React.useRef(input.listItems);
    listItemsRef.current = input.listItems;

    const groupOrderRef = React.useRef(input.currentGroupOrderMap);
    groupOrderRef.current = input.currentGroupOrderMap;

    const [draggingSessionKey, setDraggingSessionKey] = React.useState<string | null>(null);
    const [nativeContextMenuSessionKey, setNativeContextMenuSessionKey] = React.useState<string | null>(null);

    const dropIndicatorIdx = useSharedValue(-1);
    const dropIndicatorEdge = useSharedValue(0);

    const handleDragEnd = React.useCallback((sessionKey: string, groupKey: string, positionDelta: number) => {
        if (!input.canReorderSessions) {
            setDraggingSessionKey(null);
            return;
        }
        if (positionDelta !== 0) {
            const items = (listItemsRef.current ?? []) as Array<SessionListIndexItem>;
            const groupSessions = items.filter(
                (item): item is Extract<SessionListIndexItem, { type: 'session' }> =>
                    item.type === 'session' && String(item.groupKey ?? '').trim() === groupKey,
            );
            const currentMap = groupOrderRef.current;
            const existingOrder = currentMap[groupKey];
            const orderedKeys = existingOrder
                ? existingOrder
                : groupSessions.map((sessionItem) => (
                    typeof sessionItem.serverId === 'string'
                        ? `${sessionItem.serverId}:${sessionItem.sessionId}`
                        : sessionItem.sessionId
                ));
            const currentIndex = orderedKeys.indexOf(sessionKey);
            if (currentIndex >= 0) {
                const targetIndex = Math.max(0, Math.min(orderedKeys.length - 1, currentIndex + positionDelta));
                if (targetIndex !== currentIndex) {
                    const nextOrder = [...orderedKeys];
                    nextOrder.splice(currentIndex, 1);
                    nextOrder.splice(targetIndex, 0, sessionKey);
                    input.setSessionListGroupOrderV1({
                        ...currentMap,
                        [groupKey]: nextOrder.slice(0, SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP),
                    });
                }
            }
        }
        setDraggingSessionKey(null);
    }, [input.canReorderSessions, input.setSessionListGroupOrderV1]);

    const handleDragStart = React.useCallback((sessionKey: string) => {
        setNativeContextMenuSessionKey(null);
        setDraggingSessionKey(sessionKey);
    }, []);

    const handleTogglePinnedSessionKey = React.useCallback((sessionKey: string) => {
        if (input.pinnedKeySet.has(sessionKey)) {
            input.setPinnedSessionKeysV1(input.pinnedKeyList.filter((key) => key !== sessionKey));
        } else {
            input.setPinnedSessionKeysV1([...input.pinnedKeyList, sessionKey]);
        }
    }, [input.pinnedKeyList, input.pinnedKeySet, input.setPinnedSessionKeysV1]);

    const handleSetTagsSessionKey = React.useCallback((sessionKey: string, newTags: string[]) => {
        const nextTags = setTagsForSession(input.sessionTags, sessionKey, newTags);
        if (nextTags === input.sessionTags) return;
        input.setSessionTagsV1(nextTags);
    }, [input.sessionTags, input.setSessionTagsV1]);

    const handleNativeContextMenuOpenChangeSessionKey = React.useCallback((sessionKey: string, next: boolean) => {
        setNativeContextMenuSessionKey((prev) => {
            if (next) return sessionKey;
            return prev === sessionKey ? null : prev;
        });
    }, []);

    return {
        draggingSessionKey,
        nativeContextMenuSessionKey,
        dropIndicatorIdx,
        dropIndicatorEdge,
        handleDragStart,
        handleDragEnd,
        handleTogglePinnedSessionKey,
        handleSetTagsSessionKey,
        handleNativeContextMenuOpenChangeSessionKey,
    };
}
