import * as React from 'react';
import { getBuiltinWorkflowCatalogV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol';

import { useWorkflowDefinitionLibrary } from '@/components/workflows/library/workflowLibraryReads';
import { t } from '@/text';

/** A workflow a Run a workflow step can name, as the picker and the block both present it. */
export type WorkflowReferenceOption = Readonly<{
    ref: string;
    title: string;
    /** "Built-in" for catalog workflows; absent for the person's own. */
    origin?: 'builtin';
    definition?: WorkflowDefinitionV1;
}>;

/** The built-in workflows, named by their catalog titles. */
export function listBuiltinWorkflowReferenceOptions(): readonly WorkflowReferenceOption[] {
    return getBuiltinWorkflowCatalogV1().map((entry) => ({ ref: entry.id, title: t(entry.titleKey as never), origin: 'builtin' }));
}

/**
 * The person's own saved workflows as references, from the library owner's one
 * read. Mounted only where it is demanded (an open Run a workflow picker, or a
 * block that names a saved workflow), so an editor without either reads nothing.
 */
export function useWorkflowLibraryReferenceOptions(options?: Readonly<{ enabled?: boolean }>): readonly WorkflowReferenceOption[] {
    return useWorkflowReferenceLibrary(options).options;
}

/** Reference presentation borrows pagination/retry from the one library reader. */
export function useWorkflowReferenceLibrary(options?: Readonly<{ enabled?: boolean }>) {
    const library = useWorkflowDefinitionLibrary(options);
    const references = React.useMemo(
        (): readonly WorkflowReferenceOption[] => [
            ...library.definitions.map((definition) => ({ ref: definition.definitionId, title: definition.metadata.title })),
            ...library.pluginWorkflows.map((source) => ({ ref: source.workflow, title: source.title,
                ...(library.status === 'loaded' ? { definition: source.definition } : {}) })),
        ],
        [library.definitions, library.pluginWorkflows, library.status],
    );
    return { ...library, options: references };
}
