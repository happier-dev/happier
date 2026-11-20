import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { projectInputOptionsDependencies } from '@happier-dev/protocol/inputs';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { InputFieldOptionsRequest } from '@/components/sessions/actions/useInputFieldOptions';
import { findWorkflowActionSpec, type WorkflowActionSpec } from './workflowActionCatalog';

/** The shared option demand for an editor or frozen Run document, grouped by its existing source owner. */
export function readWorkflowActionFieldRequests(
    document: Pick<WorkflowDefinitionV1, 'blocks'> | null,
    catalog?: readonly WorkflowActionSpec[],
) {
    const blocks = document === null ? [] : walkWorkflowBlocks(document.blocks);
    return {
        hasActionBlocks: blocks.some((block) => block.kind === 'action'),
        requests: blocks.flatMap((block) => {
            if (block.kind !== 'action') return [];
            const spec = findWorkflowActionSpec(block.actionId, catalog);
            if (!spec) return [];
            const input = Object.fromEntries(Object.entries(block.input).flatMap(([path, binding]) =>
                binding.kind === 'literal' ? [[path, binding.value]] : []));
            const draftInput = projectInputOptionsDependencies(input, undefined, spec.id);
            return resolveEffectiveActionInputFields(spec, input).map((field) => ({
                field: { ...field, optionsDraftDependencies: field.optionsDraftDependencies },
                actionId: spec.id,
                draftInput,
            } satisfies InputFieldOptionsRequest));
        }),
    };
}
