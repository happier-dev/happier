import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { buildMentionRefForKindV1, MENTION_KIND_V1, type MentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import type { WorkflowActionValueReferenceV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowStep, WorkflowValidationIssue } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type { ComposerEditorReference } from '@/components/ui/forms/composerEditor/composerEditorTypes';
import { parseComposerSuggestionQuery } from '@/components/autocomplete/composerSuggestionGrammar';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import { listWorkflowConditionValueOptions, type WorkflowValueContext } from './workflowConditionValueOptions';

/** The validator owns scope and existence; both the live field and its picture consume its result. */
export function resolveWorkflowPromptReferenceStates(
    step: WorkflowStep,
    issues: readonly WorkflowValidationIssue[],
): ReadonlyMap<string, NonNullable<ComposerEditorReference['state']>> | undefined {
    // An Action field's text has the same token paths under `/input/<field>/`; those are not this prompt's.
    return resolveWorkflowTokenReferenceStates(step.document.references, issues, (path) => {
        const match = /\/document\/references\/(\d+)\/ref$/.exec(path);
        return match && !/\/input\/[^/]+$/.test(path.slice(0, match.index)) ? Number(match[1]) : null;
    });
}

/** Projects the issues that address a document's token records onto those tokens' chip states. */
export function resolveWorkflowTokenReferenceStates(
    references: readonly MentionRefV1[],
    issues: readonly WorkflowValidationIssue[],
    readReferenceIndex: (path: string) => number | null,
): ReadonlyMap<string, NonNullable<ComposerEditorReference['state']>> | undefined {
    let states: Map<string, NonNullable<ComposerEditorReference['state']>> | undefined;
    for (const issue of issues) {
        const index = readReferenceIndex(issue.path);
        const reference = index === null ? undefined : references[index];
        if (reference?.kind !== MENTION_KIND_V1.workflowInput) continue;
        states ??= new Map();
        states.set(reference.ref, issue.code === 'missing_reference' || issue.code === 'invalid_input' ? 'removed' : 'unavailable');
    }
    return states;
}

/** Workflow-local values join the real composer catalog; selecting one binds its existing input token. */
export function createWorkflowPromptSuggestions<Reference extends WorkflowActionValueReferenceV1>(params: Readonly<{
    draft: WorkflowEditorDraft;
    /** The block whose scope applies and the value list its tokens address: a prompt step, or one Action text field. */
    step: Readonly<{ id: string; input: readonly Reference[] }>;
    query: string;
    valueContext?: WorkflowValueContext;
    onChangeInput: (input: (Reference | WorkflowValueReference)[]) => void;
}>): AutocompleteSuggestion[] {
    const query = parseComposerSuggestionQuery(params.query);
    if (query?.trigger !== '@') return [];
    const search = query.query.toLocaleLowerCase();
    return listWorkflowConditionValueOptions(params.draft, params.step.id, undefined, { ...params.valueContext, includeUnavailable: true })
        .filter(option => !option.opensPath)
        .flatMap((option): AutocompleteSuggestion[] => {
            const label = option.reference.kind === 'result'
                ? option.reference.path.length === 0 ? option.category : `${option.category} · ${option.title}`
                : option.title;
            if (!`${label} ${option.category}`.toLocaleLowerCase().includes(search)) return [];
            if (option.unavailableReason !== undefined) return [{
                kind: 'composerReference', key: `workflow:${option.id}`, text: '', label,
                group: t('workflows.input.notAvailableHere'), disabled: true,
                description: option.unavailableReason === 'runs_later'
                    ? t('workflows.input.scopeRunsLater') : option.unavailableReason === 'another_lane'
                        ? t('workflows.input.scopeAnotherLane') : t('workflows.input.scopeUnavailable'),
            }];
            const existing = params.step.input.findIndex(value => pluginJsonValuesEqual(value, option.reference));
            const index = existing < 0 ? params.step.input.length : existing;
            const ref = buildMentionRefForKindV1(MENTION_KIND_V1.workflowInput, String(index));
            return [{
                kind: 'composerReference', key: `workflow:${option.id}`, label,
                text: formatInlineReferenceTokenV1({ label, ref }),
                group: option.reference.kind === 'result' ? t('workflows.input.stepResults')
                    : option.reference.kind === 'input' ? t('workflows.inputs.title') : option.category,
                ...(option.typeLabel === null ? {} : { description: option.typeLabel }),
                structuredInput: { kind: MENTION_KIND_V1.workflowInput, ref, label },
                selectionEffect: async () => {
                    if (existing < 0) params.onChangeInput([...params.step.input, option.reference]);
                    return { ok: true };
                },
            }];
        });
}
