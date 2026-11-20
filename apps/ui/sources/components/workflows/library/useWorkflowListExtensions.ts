import * as React from 'react';
import { useCollectionListExtensions, type CollectionListExtensions } from '@/components/ui/lists/collection/useCollectionListExtensions';

import { readWorkflowLibraryRowFacts, workflowLibraryExtensionFacts, type WorkflowLibraryItem, type WorkflowLibraryRowFacts } from './workflowLibraryCells';

/**
 * A workflow list's admitted plugin details and columns for a surface that keeps no facts reading of its own (the
 * sidebar, the phone View sheet): the same held facts the library page offers (`workflowLibraryExtensionFacts`).
 */
export function useWorkflowLibraryRowExtensions(): CollectionListExtensions<WorkflowLibraryItem> {
    const readFacts = React.useMemo(() => {
        const facts = new WeakMap<WorkflowLibraryItem, WorkflowLibraryRowFacts>();
        return (row: WorkflowLibraryItem) => {
            let read = facts.get(row);
            if (read === undefined) { read = readWorkflowLibraryRowFacts(row); facts.set(row, read); }
            return read;
        };
    }, []);
    const readableFacts = React.useMemo(() => workflowLibraryExtensionFacts(readFacts), [readFacts]);
    return useCollectionListExtensions('workflow', readableFacts);
}
