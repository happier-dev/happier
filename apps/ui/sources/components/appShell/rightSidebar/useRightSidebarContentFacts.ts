import * as React from 'react';

import { useCodeIntelligencePaneProducer } from '@/components/workspaces/files/intelligence/codeIntelligencePaneStore';
import type { RightSidebarContentFacts } from './rightSidebarBuiltinTabs';

const noSubscription = () => () => undefined;
const unknown = () => null;

/** Passive scalar selectors: opening a rail never acquires a File controller or its details. */
export function useRightSidebarContentFacts(input: Readonly<{
    scopeId: string;
    runningServices?: boolean | null;
    runningScripts?: boolean | null;
    boardItems?: boolean | null;
}>): RightSidebarContentFacts {
    const controller = useCodeIntelligencePaneProducer(input.scopeId)?.controller ?? null;
    const problems = React.useSyncExternalStore(controller?.subscribe ?? noSubscription, () => {
        const diagnostics = controller?.getSnapshot().diagnostics;
        return diagnostics?.state === 'ready' && diagnostics.count !== null ? diagnostics.count > 0 : null;
    }, unknown);
    const references = React.useSyncExternalStore(controller?.subscribe ?? noSubscription, () => {
        if (!controller) return null;
        const snapshot = controller.getSnapshot();
        if (snapshot.status === 'unavailable') return null;
        return snapshot.kind === 'references' && snapshot.result !== null
            && 'locations' in snapshot.result && snapshot.result.locations.length > 0;
    }, unknown);
    const runningServices = input.runningServices ?? null;
    const runningScripts = input.runningScripts ?? null;
    const boardItems = input.boardItems ?? null;
    return React.useMemo(() => ({ runningServices, problems, references, runningScripts, boardItems }),
        [runningServices, problems, references, runningScripts, boardItems]);
}
