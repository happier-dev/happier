import { getTranslationValue } from '@/text';

import { supportsWorkflowAnotherRoundV1 } from '@happier-dev/protocol/workflows';
import {
    resolvePluginLocalizedStringV2Text,
    type PluginLocalizedStringV2,
} from '@happier-dev/protocol/plugins/contributions/public-types';
import {
    workflowInputTitle,
    type WorkflowInputDefinition,
} from '@happier-dev/protocol/workflows/workflowV1';

export function resolveWorkflowInputCopy(text: PluginLocalizedStringV2): string {
    if (typeof text === 'string') return text;
    const translation = getTranslationValue(text.key);
    return resolvePluginLocalizedStringV2Text(text, typeof translation === 'string' ? translation : undefined);
}

export function resolveWorkflowInputTitle(input: WorkflowInputDefinition): string {
    return workflowInputTitle(input, resolveWorkflowInputCopy);
}

/**
 * Inputs the host binds when it starts a Run:
 * - `previousRoundContext`: Another round reads the prior Run's outcomes into it; a first start keeps its default.
 * - `triggerId`: the starting trigger passes its own id (Keep going's Goal trigger).
 * - `diffFingerprint`: the daemon fingerprints the origin workspace so an unchanged diff is not reviewed again.
 * Only optional ones are hidden: a required input stays askable, so a form never hides what it needs to start.
 */
const HOST_BOUND_WORKFLOW_INPUTS: ReadonlySet<string> = new Set(['triggerId', 'diffFingerprint']);

export function isWorkflowHostBoundInput(input: WorkflowInputDefinition): boolean {
    return !input.required && (HOST_BOUND_WORKFLOW_INPUTS.has(input.name) || supportsWorkflowAnotherRoundV1({ inputs: [input] }));
}

/** The inputs a person is asked for in the picker preview, its "Asks for" line and every Run form. */
export function listWorkflowPersonInputs<T extends WorkflowInputDefinition>(inputs: readonly T[]): readonly T[] {
    return inputs.filter((input) => !isWorkflowHostBoundInput(input));
}

/** A declared source, enum or input type is chosen, never typed into the main composer. */
export function isWorkflowChoiceInput(definition: Pick<WorkflowInputDefinition, 'optionsSourceId' | 'enum' | 'inputType'>): boolean {
    return definition.optionsSourceId !== undefined || definition.enum !== undefined || definition.inputType !== undefined;
}

/** The input a typed draft fills: the first free-text input a person is asked for. */
export function findWorkflowMainInput<T extends WorkflowInputDefinition>(inputs: readonly T[]): T | undefined {
    return listWorkflowPersonInputs(inputs).find((input) => input.valueType === 'string' && !isWorkflowChoiceInput(input));
}
