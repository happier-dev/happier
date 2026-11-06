import { collectWorkflowConditionValueReferences, type WorkflowCondition, type WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WorkflowLoopOutcomeV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { t } from '@/text';
import { isWorkflowConditionUnset } from './workflowConditionRules';
import { formatWorkflowValueReference, type WorkflowValuePresentationContext } from './workflowValuePresentation';

export const WORKFLOW_CONDITION_OPERATOR_LABEL_KEYS = {
    eq: 'workflows.condition.operatorEq',
    neq: 'workflows.condition.operatorNeq',
    lt: 'workflows.condition.operatorLt',
    lte: 'workflows.condition.operatorLte',
    gt: 'workflows.condition.operatorGt',
    gte: 'workflows.condition.operatorGte',
} as const;

/**
 * A condition read as one sentence ("Check the build result · verdict is
 * “pass”"): Step options' Only run when row, container headings ("Repeat
 * until …", "If …") and the document's quiet "Only when …" line all read it
 * here, so a condition is never worded two ways.
 */
export function formatWorkflowConditionSentence(draft: WorkflowValuePresentationContext, authored: WorkflowCondition): string {
    const condition = foldWorkflowConditionGuards(authored);
    switch (condition.kind) {
        case 'exists':
            return `${formatConditionValue(draft, condition.value)} ${t('workflows.condition.exists')}`;
        case 'compare': {
            const { left, right, operator } = condition;
            // "Round index, from 0 is more than 0" is how a machine says it; a person says "after the first round".
            if (left.kind === 'iteration' && left.field === 'index' && operator === 'gt'
                && right.kind === 'literal' && right.value === 0) return t('workflows.condition.notFirstRound');
            // How a loop ended, as the loop's own sentence: "Review until it converges ran out of rounds".
            const loopEnding = formatWorkflowLoopEndingCondition(draft, condition);
            if (loopEnding !== null) return loopEnding;
            // A run of the same verdict: "Check progress · Verdict is “no progress” 3 times in a row".
            if (left.kind === 'loop_trailing_count' && operator === 'gte') {
                return t('workflows.condition.trailingCountAtLeast', {
                    source: formatWorkflowValueReference(draft, { kind: 'result', producer: left.producer, path: left.path }),
                    value: formatConditionValue(draft, { kind: 'literal', value: left.equals }),
                    count: formatConditionValue(draft, right),
                });
            }
            return `${formatConditionValue(draft, left)} ${t(WORKFLOW_CONDITION_OPERATOR_LABEL_KEYS[operator])} ${formatConditionValue(draft, right)}`;
        }
        case 'not':
            // "has no value" is the rule the person chose; only other negations read as "not …".
            if (condition.condition.kind === 'exists') return `${formatConditionValue(draft, condition.condition.value)} ${t('workflows.condition.notExists')}`;
            return t('workflows.page.inspector.conditionNot', { condition: formatWorkflowConditionSentence(draft, condition.condition) });
        case 'all':
        case 'any':
            return `${condition.kind === 'all' ? t('workflows.page.inspector.conditionAll') : t('workflows.page.inspector.conditionAny')}: ${condition.conditions.map((child) => formatWorkflowConditionSentence(draft, child)).join('; ')}`;
    }
}

/** `loop.outcome == …` and `loop.outcome.kind == "exhausted"` read as how the loop ended, not as its wire fields. */
function formatWorkflowLoopEndingCondition(draft: WorkflowValuePresentationContext, condition: Extract<WorkflowCondition, { kind: 'compare' }>): string | null {
    const { left, right, operator } = condition;
    if (operator !== 'eq' || left.kind !== 'result' || left.producer.scope.kind !== 'current' || right.kind !== 'literal') return null;
    const loop = findWorkflowBlock(draft, left.producer.blockId);
    if (loop === null || loop.kind !== 'loop') return null;
    const name = workflowBlockReferenceLabel(loop);
    const path = left.path.join('.');
    if (path === 'outcome.kind' && right.value === 'exhausted') return t('workflows.condition.loopRanOutOfRounds', { loop: name });
    const outcome = path === 'outcome' ? WorkflowLoopOutcomeV1Schema.safeParse(right.value) : null;
    if (outcome?.success !== true) return null;
    // A stop condition reads as the condition itself: "… stopped because Check progress · Verdict is “done”".
    if (outcome.data.kind === 'stop_condition' && loop.repetition.kind === 'until') {
        const stopWhen = loop.repetition.stopWhen;
        const arm = outcome.data.arm === undefined ? stopWhen
            : stopWhen.kind === 'all' || stopWhen.kind === 'any' ? stopWhen.conditions[outcome.data.arm]
                : outcome.data.arm === 0 ? stopWhen : undefined;
        if (arm !== undefined) {
            return t('workflows.condition.loopStoppedBecause', { loop: name, condition: formatWorkflowConditionSentence(draft, arm) });
        }
    }
    return t('workflows.condition.loopEnded', { loop: name, outcome: formatWorkflowValueReference(draft, right) });
}

/**
 * A condition as a person reads it: an "all of these" that only guards its comparison's operands
 * ("Tokens used has a value", "Goal token budget has a value", "Tokens used is at least Goal token
 * budget") reads as the comparison alone — a missing value cannot satisfy it anyway. Presentation
 * only; the authored condition is untouched.
 */
export function foldWorkflowConditionGuards(condition: WorkflowCondition): WorkflowCondition {
    if (condition.kind === 'not') return { ...condition, condition: foldWorkflowConditionGuards(condition.condition) };
    if (condition.kind !== 'all' && condition.kind !== 'any') return condition;
    const arms = condition.conditions.map(foldWorkflowConditionGuards);
    if (condition.kind !== 'all') return { ...condition, conditions: arms };
    const operands = new Set(arms.flatMap((arm) => arm.kind === 'compare' ? [JSON.stringify(arm.left), JSON.stringify(arm.right)] : []));
    const kept = arms.filter((arm) => arm.kind !== 'exists' || !operands.has(JSON.stringify(arm.value)));
    return kept.length === 1 ? kept[0]! : { ...condition, conditions: kept };
}

/**
 * A value as a condition reads it. A literal that is an enum-like identifier (a verdict such as
 * `done` or `no_progress`) is a word of the sentence — "Verdict is no progress", unquoted (DESIGN-7
 * M4); free text keeps its quotes, and every other value reads as the document reads it.
 */
function formatConditionValue(draft: WorkflowValuePresentationContext, value: WorkflowValueReference): string {
    // A value not typed yet reads as the blank it is, never as empty quotes.
    if (value.kind === 'literal' && value.value === '') return '…';
    if (value.kind === 'literal' && typeof value.value === 'string' && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(value.value)) {
        return value.value.replaceAll('_', ' ');
    }
    return formatWorkflowValueReference(draft, value);
}

/**
 * A condition as a container heading reads it (lab `editor-E1`: "If ↵ Check the fix · fixed is No"):
 * one compact sentence with its references as tokens. A compound condition reads as its first arm
 * and how many more, never a paragraph of arms under the heading; every arm is in Step options'
 * condition editor, and the accessible label carries the whole sentence.
 */
export function resolveWorkflowConditionHeadline(draft: WorkflowValuePresentationContext, authored: WorkflowCondition): Readonly<{
    sentence: string;
    references: readonly WorkflowValueReference[];
}> {
    const condition = foldWorkflowConditionGuards(authored);
    // Nothing chosen yet: the heading says what to do, never "Yes has a value".
    if (isWorkflowConditionUnset(condition)) return { sentence: t('workflows.condition.unsetSentence'), references: [] };
    if (condition.kind !== 'all' && condition.kind !== 'any') {
        return { sentence: formatWorkflowConditionSentence(draft, condition), references: collectWorkflowConditionValueReferences(condition) };
    }
    const [first, ...rest] = condition.conditions;
    if (first === undefined) {
        return { sentence: condition.kind === 'all' ? t('workflows.page.inspector.conditionAll') : t('workflows.page.inspector.conditionAny'), references: [] };
    }
    const head = resolveWorkflowConditionHeadline(draft, first);
    return rest.length === 0 ? head
        : { sentence: `${head.sentence} · ${t('workflows.page.inspector.conditionMore', { count: rest.length })}`, references: head.references };
}
