import { t } from '@/text';

import { WORKFLOW_PREVIOUS_ROUND_CONTEXT_INPUT_V1 } from '@happier-dev/protocol/workflows';

import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';

import type { WorkflowRunInputPresentation } from '../run/WorkflowRunComposer';

/**
 * Localized copy for the inputs of Happier's built-in workflows.
 *
 * Built-in definitions name their inputs with protocol keys (`request`, `maxRounds`), which are
 * the authored contract and never shown. Every surface that collects a built-in's inputs (the run
 * composer, the trigger popover) reads its labels here, so a built-in input reads the same
 * everywhere. Authored workflows name their own inputs and have no entry.
 */
export function resolveWorkflowBuiltinInputPresentation(workflowRef: string | null | undefined): WorkflowRunInputPresentation | undefined {
    switch (workflowRef) {
        case 'builtin:review-and-converge':
            return {
                engines: { title: t('workflows.builtins.reviewAndConverge.inputs.engines') },
                reviewSession: { title: t('workflows.builtins.reviewAndConverge.inputs.reviewSession') },
                useJudge: { title: t('workflows.builtins.reviewAndConverge.inputs.useJudge') },
                focus: { title: t('workflows.builtins.reviewAndConverge.inputs.focus') },
                maxRounds: { title: t('workflows.builtins.reviewAndConverge.rounds') },
                apply: { title: t('workflows.builtins.reviewAndConverge.apply'), optionLabels: {
                    fix: t('workflows.builtins.reviewAndConverge.verifyAndFix'),
                    report: t('workflows.builtins.reviewAndConverge.verifyOnly'),
                } },
            };
        case 'builtin:plan-with-a-panel':
            return {
                request: { title: t('workflows.builtins.planWithAPanel.inputs.request'),
                    placeholder: t('workflows.builtins.planWithAPanel.inputs.requestPlaceholder') },
                engines: { title: t('workflows.builtins.planWithAPanel.inputs.engines') },
                participants: { title: t('workflows.builtins.patternInputs.participants') },
                previousRoundContext: { title: t('workflows.builtins.patternInputs.previousRoundContext') },
            };
        case 'builtin:fresh-opinions':
            return {
                question: { title: t('workflows.builtins.patternInputs.question') },
                participants: { title: t('workflows.builtins.patternInputs.participants') },
                synthesis: { title: t('workflows.builtins.patternInputs.synthesis') },
                synthesizer: { title: t('workflows.builtins.patternInputs.synthesizer') },
                previousRoundContext: { title: t('workflows.builtins.patternInputs.previousRoundContext') },
            };
        case 'builtin:answer-and-review':
            return {
                question: { title: t('workflows.builtins.patternInputs.question') },
                answerer: { title: t('workflows.builtins.patternInputs.answerer') },
                reviewer: { title: t('workflows.builtins.patternInputs.reviewer') },
            };
        case 'builtin:debate':
            return {
                question: { title: t('workflows.builtins.patternInputs.question') },
                participants: { title: t('workflows.builtins.patternInputs.participants') },
                rounds: { title: t('workflows.builtins.patternInputs.rounds') },
                digestAuthor: { title: t('workflows.builtins.patternInputs.digestAuthor') },
                previousRoundContext: { title: t('workflows.builtins.patternInputs.previousRoundContext') },
            };
        case 'builtin:open-a-pull-request':
            return {
                base: { title: t('workflows.builtins.openAPullRequest.inputs.base') },
                title: { title: t('workflows.builtins.openAPullRequest.inputs.title') },
                body: { title: t('workflows.builtins.openAPullRequest.inputs.body') },
                question: { title: t('workflows.builtins.openAPullRequest.inputs.question') },
            };
        default:
            return undefined;
    }
}

/**
 * Inputs the host binds by exact name when it starts a Run, never a person:
 * - `previousRoundContext`: Another round reads the prior Run's outcomes into it; a first start keeps its default.
 * - `triggerId`: the starting trigger passes its own id (Keep going's Goal trigger).
 * - `diffFingerprint`: the daemon fingerprints the origin workspace so an unchanged diff is not reviewed again.
 * Only optional ones are hidden: a required input stays askable, so a form never hides what it needs to start.
 */
const HOST_BOUND_WORKFLOW_INPUTS: ReadonlySet<string> = new Set([WORKFLOW_PREVIOUS_ROUND_CONTEXT_INPUT_V1, 'triggerId', 'diffFingerprint']);

export function isWorkflowHostBoundInput(input: Pick<WorkflowInputDefinition, 'name' | 'required'>): boolean {
    return !input.required && HOST_BOUND_WORKFLOW_INPUTS.has(input.name);
}

/** The inputs a person is asked for in the picker preview, its "Asks for" line and every Run form. */
export function listWorkflowPersonInputs<T extends Pick<WorkflowInputDefinition, 'name' | 'required'>>(inputs: readonly T[]): readonly T[] {
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
