import * as React from 'react';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';
import { getTempData, peekTempData, storeTempData } from '@/utils/sessions/tempDataStore';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { retainDeep } from '@/sync/domains/state/structuralSharing';

export type BulkSessionComposerSeed = Readonly<{
    targets: readonly ActionSessionAddressV1[];
    /** Already formatted by the transcript's existing send-to-session template owner. */
    text?: string;
}>;

export function freezeBulkSessionTargets(targets: readonly ActionSessionAddressV1[]): readonly ActionSessionAddressV1[] {
    return Object.freeze(targets.map(target => Object.freeze({ serverId: target.serverId, sessionId: target.sessionId })));
}

export function storeBulkSessionComposerSeed(seed: BulkSessionComposerSeed): string {
    return storeTempData({ ...seed, targets: freezeBulkSessionTargets(seed.targets) });
}

export function takeBulkSessionComposerSeed(dataId: string): BulkSessionComposerSeed | null {
    return getTempData<BulkSessionComposerSeed>(dataId);
}

/** Non-consuming read for a render-time initializer, which React may run more than once (StrictMode, remounts). */
export function readBulkSessionComposerSeed(dataId: string): BulkSessionComposerSeed | null {
    return peekTempData<BulkSessionComposerSeed>(dataId);
}

/** The entry is captured once. Later list selection changes cannot rewrite an open composer. */
export function useFrozenBulkSessionTargets(initialTargets: readonly ActionSessionAddressV1[]) {
    const [targets, setTargets] = React.useState(() => freezeBulkSessionTargets(initialTargets));
    const editToTargets = useEventCallback((next: readonly ActionSessionAddressV1[]) => {
        setTargets(previous => retainDeep(previous, freezeBulkSessionTargets(next)));
    });
    return { targets, editToTargets };
}
