import * as React from 'react';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionAddressV1';
import { useSessionListSelectionController } from '@/components/sessions/shell/selection/SessionListSelectionContext';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { freezeBulkSessionTargets, type BulkSessionComposerSeed } from './bulkSessionComposerHandoff';

export function useBulkSessionTargetSelection(input: Readonly<{
    scopeKey: string;
    visibleTargets: readonly ActionSessionAddressV1[];
    eligibleTargets?: readonly ActionSessionAddressV1[];
    text?: string;
    onCompose: (seed: BulkSessionComposerSeed) => void;
}>) {
    const eligibleTargets = input.eligibleTargets ?? input.visibleTargets;
    const visibleOrderedKeys = React.useMemo(() => input.visibleTargets.map(sessionAddressKey), [input.visibleTargets]);
    const eligibleKeys = React.useMemo(() => eligibleTargets.map(sessionAddressKey), [eligibleTargets]);
    const store = useSessionListSelectionController({ scopeKey: input.scopeKey, visibleOrderedKeys, eligibleKeys });
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const toggleTarget = useEventCallback((target: ActionSessionAddressV1) => store.toggle(sessionAddressKey(target)));
    const compose = useEventCallback(() => {
        const selected = store.getSnapshot().selectedKeys;
        const targets = eligibleTargets.filter(target => selected.has(sessionAddressKey(target)));
        if (targets.length === 0) return;
        input.onCompose({ targets: freezeBulkSessionTargets(targets), ...(input.text === undefined ? {} : { text: input.text }) });
    });
    return { store, snapshot, enter: store.enter, exit: store.exit, toggleTarget, compose };
}
