import type { WorkflowPluginSourceV1 } from '@happier-dev/protocol/workflows';

import { isSharedWithYouWorkflowDefinition, type WorkflowLibraryDefinition } from '@/components/workflows/library/workflowLibraryReads';

/**
 * What the Workflows column shows from each owner's read (FIN 04 §3.3). Each function is a pure
 * projection: the column never decides a lifecycle, an attention state or a trigger's schedule.
 */

/** A selected saved definition, excluding the destination's own routes. */
export function readOpenWorkflowDefinition(pathname: string): string | null {
    const match = /^\/workflows\/([^/?#]+)$/.exec(pathname);
    if (!match || ['new', 'runs', 'settings', 'edit', 'events'].includes(match[1]!)) return null;
    try { return decodeURIComponent(match[1]!); } catch { return match[1]!; }
}

/** Your saved workflows and the ones shared with you (`isSharedWithYouWorkflowDefinition`). */
export function splitLibraryDefinitions(
    definitions: readonly WorkflowLibraryDefinition[],
    pluginWorkflows: readonly WorkflowPluginSourceV1[] = [],
): Readonly<{
    library: readonly WorkflowLibraryDefinition[];
    sharedWithYou: readonly WorkflowLibraryDefinition[];
    fromPlugins: readonly WorkflowPluginSourceV1[];
}> {
    const library: WorkflowLibraryDefinition[] = [];
    const sharedWithYou: WorkflowLibraryDefinition[] = [];
    for (const definition of definitions) {
        (isSharedWithYouWorkflowDefinition(definition) ? sharedWithYou : library).push(definition);
    }
    return { library, sharedWithYou, fromPlugins: pluginWorkflows };
}
