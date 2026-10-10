import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import {
    WORKFLOW_COMPARE_OPERATORS,
    collectWorkflowConditionValueReferences,
    type WorkflowCompareOperator,
    type WorkflowCondition,
    type WorkflowValueReference,
} from '@happier-dev/protocol/workflows/workflowReferenceV1';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { findWorkflowBlock } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { WorkflowLoopOutcomeV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { t } from '@/text';

import { workflowEditorStyles } from './workflowEditorStyles';
import { formatWorkflowValueReference, WorkflowReferenceSentence, WorkflowValueReferenceEditor } from './WorkflowStepDataEditor';

const DEFAULT_CONDITION: WorkflowCondition = { kind: 'exists', value: { kind: 'literal', value: true } };
const CONDITION_KINDS = ['exists', 'compare', 'all', 'any', 'not'] as const;
const CONDITION_KIND_LABEL_KEYS = {
    exists: 'workflows.condition.exists',
    compare: 'workflows.condition.operatorEq',
    all: 'workflows.condition.allOf',
    any: 'workflows.condition.anyOf',
    not: 'workflows.condition.not',
} as const;
const OPERATOR_LABEL_KEYS = {
    eq: 'workflows.condition.operatorEq',
    neq: 'workflows.condition.operatorNeq',
    lt: 'workflows.condition.operatorLt',
    lte: 'workflows.condition.operatorLte',
    gt: 'workflows.condition.operatorGt',
    gte: 'workflows.condition.operatorGte',
} as const;

function conditionForKind(kind: WorkflowCondition['kind']): WorkflowCondition {
    if (kind === 'exists') return DEFAULT_CONDITION;
    if (kind === 'compare') return {
        kind,
        operator: 'eq',
        left: { kind: 'literal', value: true },
        right: { kind: 'literal', value: true },
    };
    if (kind === 'not') return { kind, condition: DEFAULT_CONDITION };
    return { kind, conditions: [DEFAULT_CONDITION] };
}

/**
 * A condition read as one sentence ("Check the build result · verdict is
 * “pass”"): Step options' Only run when row, container headings ("Repeat
 * until …", "If …") and the document's quiet "Only when …" line all read it
 * here, so a condition is never worded two ways.
 */
export function formatWorkflowConditionSentence(draft: WorkflowEditorDraft, authored: WorkflowCondition): string {
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
            return `${formatConditionValue(draft, left)} ${t(OPERATOR_LABEL_KEYS[operator])} ${formatConditionValue(draft, right)}`;
        }
        case 'not':
            return t('workflows.page.inspector.conditionNot', { condition: formatWorkflowConditionSentence(draft, condition.condition) });
        case 'all':
        case 'any':
            return `${condition.kind === 'all' ? t('workflows.page.inspector.conditionAll') : t('workflows.page.inspector.conditionAny')}: ${condition.conditions.map((child) => formatWorkflowConditionSentence(draft, child)).join('; ')}`;
    }
}

/** `loop.outcome == …` and `loop.outcome.kind == "exhausted"` read as how the loop ended, not as its wire fields. */
function formatWorkflowLoopEndingCondition(draft: WorkflowEditorDraft, condition: Extract<WorkflowCondition, { kind: 'compare' }>): string | null {
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
function formatConditionValue(draft: WorkflowEditorDraft, value: WorkflowValueReference): string {
    if (value.kind === 'literal' && typeof value.value === 'string' && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(value.value)) {
        return value.value.replaceAll('_', ' ');
    }
    return formatWorkflowValueReference(draft, value);
}

/**
 * A condition as the lead of a container sentence: a compound condition's own words ("any of these
 * holds:"), whose arms then read as {@link WorkflowConditionArmLines}; any other condition whole.
 * A heading never runs into a paragraph of tokens (E1), and the words are the sentence's own.
 */
export function formatWorkflowConditionLead(draft: WorkflowEditorDraft, authored: WorkflowCondition): string {
    const condition = foldWorkflowConditionGuards(authored);
    if (condition.kind !== 'all' && condition.kind !== 'any') return formatWorkflowConditionSentence(draft, condition);
    return `${condition.kind === 'all' ? t('workflows.page.inspector.conditionAll') : t('workflows.page.inspector.conditionAny')}:`;
}

/** A compound condition's arms, one quiet line each, nested compounds indented beneath their lead. */
export function WorkflowConditionArmLines(props: Readonly<{
    draft: WorkflowEditorDraft;
    condition: WorkflowCondition;
    testID?: string;
}>): React.ReactElement | null {
    const condition = foldWorkflowConditionGuards(props.condition);
    if (condition.kind !== 'all' && condition.kind !== 'any') return null;
    return (
        <View testID={props.testID} style={workflowEditorStyles.conditionArms}>
            {condition.conditions.map((arm, index) => (
                <React.Fragment key={index}>
                    <Text style={workflowEditorStyles.groupSummary}>
                        <WorkflowReferenceSentence draft={props.draft}
                            sentence={formatWorkflowConditionLead(props.draft, arm)}
                            references={arm.kind === 'all' || arm.kind === 'any' ? [] : collectWorkflowConditionValueReferences(arm)} />
                    </Text>
                    <WorkflowConditionArmLines draft={props.draft} condition={arm} />
                </React.Fragment>
            ))}
        </View>
    );
}

/**
 * One choice among more than four short options — a field select (04 §5.2's
 * control table), never a row of radio text.
 */
function ConditionFieldSelect<T extends string>(props: Readonly<{
    title: string;
    value: T;
    options: readonly T[];
    label: (value: T) => string;
    onChange: (value: T) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    return (
        <DropdownMenu
            testID={props.testIDPrefix}
            open={open}
            onOpenChange={setOpen}
            selectedId={props.value}
            items={props.options.map((option) => ({
                id: option,
                title: props.label(option),
                testID: `${props.testIDPrefix}-${option}`,
            }))}
            onSelect={(id) => props.onChange(id as T)}
            itemTrigger={{ title: props.title, itemProps: { testID: `${props.testIDPrefix}-trigger` } }}
        />
    );
}

function ConditionAction(props: Readonly<{
    label: string;
    onPress: () => void;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <HappierPressable
            {...(props.testID === undefined ? {} : { testID: props.testID })}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            onPress={props.onPress}
            style={(state) => [
                workflowEditorStyles.actionTarget,
                state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            <Text style={workflowEditorStyles.metaAction}>{props.label}</Text>
        </HappierPressable>
    );
}

function ConditionNode(props: Readonly<{
    condition: WorkflowCondition;
    draft: WorkflowEditorDraft;
    consumerBlockId: string;
    continuation?: boolean;
    /** The condition's own label ("Only run when", "Stop when"), naming its kind select. */
    kindTitle: string;
    onChange: (condition: WorkflowCondition) => void;
    testIDPrefix: string;
    depth: number;
}>): React.ReactElement {
    const { condition } = props;
    const continuation = props.continuation === true ? { continuation: true } : {};
    return (
        <View style={props.depth === 0 ? undefined : workflowEditorStyles.nestedList}>
            <ConditionFieldSelect<WorkflowCondition['kind']>
                title={props.kindTitle}
                value={condition.kind}
                options={CONDITION_KINDS}
                label={(kind) => t(CONDITION_KIND_LABEL_KEYS[kind])}
                onChange={(kind) => {
                    if (kind !== condition.kind) props.onChange(conditionForKind(kind));
                }}
                testIDPrefix={`${props.testIDPrefix}-kind`}
            />
            {condition.kind === 'exists' ? (
                <WorkflowValueReferenceEditor
                    reference={condition.value}
                    index={props.depth}
                    draft={props.draft}
                    stepId={props.consumerBlockId}
                    {...continuation}
                    onChange={(value) => props.onChange({ ...condition, value })}
                    testIDPrefix={`${props.testIDPrefix}-value`}
                />
            ) : null}
            {condition.kind === 'compare' ? (
                <>
                    <WorkflowValueReferenceEditor
                        reference={condition.left}
                        index={props.depth * 2}
                        draft={props.draft}
                        stepId={props.consumerBlockId}
                        {...continuation}
                        onChange={(left) => props.onChange({ ...condition, left })}
                        testIDPrefix={`${props.testIDPrefix}-left`}
                    />
                    <ConditionFieldSelect<WorkflowCompareOperator>
                        title={t('workflows.condition.operatorEq')}
                        value={condition.operator}
                        options={WORKFLOW_COMPARE_OPERATORS}
                        label={(operator) => t(OPERATOR_LABEL_KEYS[operator])}
                        onChange={(operator) => props.onChange({ ...condition, operator })}
                        testIDPrefix={`${props.testIDPrefix}-operator`}
                    />
                    <WorkflowValueReferenceEditor
                        reference={condition.right}
                        index={props.depth * 2 + 1}
                        draft={props.draft}
                        stepId={props.consumerBlockId}
                        {...continuation}
                        onChange={(right) => props.onChange({ ...condition, right })}
                        testIDPrefix={`${props.testIDPrefix}-right`}
                    />
                </>
            ) : null}
            {condition.kind === 'not' ? (
                <ConditionNode
                    {...props}
                    condition={condition.condition}
                    onChange={(next) => props.onChange({ kind: 'not', condition: next })}
                    testIDPrefix={`${props.testIDPrefix}-not`}
                    depth={props.depth + 1}
                />
            ) : null}
            {condition.kind === 'all' || condition.kind === 'any' ? (
                <>
                    {condition.conditions.map((child, index) => (
                        <ConditionNode
                            key={index}
                            {...props}
                            condition={child}
                            onChange={(next) => props.onChange({
                                ...condition,
                                conditions: condition.conditions.map((current, candidate) => candidate === index ? next : current),
                            })}
                            testIDPrefix={`${props.testIDPrefix}-${index}`}
                            depth={props.depth + 1}
                        />
                    ))}
                    <ConditionAction
                        label={t('workflows.condition.addCondition')}
                        onPress={() => props.onChange({ ...condition, conditions: [...condition.conditions, DEFAULT_CONDITION] })}
                        testID={`${props.testIDPrefix}-add`}
                    />
                </>
            ) : null}
        </View>
    );
}

/**
 * A condition: "Always" + Add condition while absent (unless required), then
 * the condition tree with its kinds and operators as field selects and
 * Remove condition (unless required).
 */
export function WorkflowConditionEditor(props: Readonly<{
    label: string;
    condition: WorkflowCondition | undefined;
    draft: WorkflowEditorDraft;
    consumerBlockId: string;
    /** True for a loop's after-each-round condition (`stopWhen`), which resolves inside the body. */
    continuation?: boolean;
    required?: boolean;
    editable?: boolean;
    onChange: (condition: WorkflowCondition | undefined) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    if (props.editable === false) return <View testID={props.testIDPrefix}>
        <Text style={workflowEditorStyles.metaText}>{props.label}</Text>
        <Text style={workflowEditorStyles.metaText}>{props.condition === undefined ? t('workflows.condition.always')
            : <WorkflowReferenceSentence draft={props.draft} sentence={formatWorkflowConditionSentence(props.draft, props.condition)}
                references={collectWorkflowConditionValueReferences(props.condition)} />}</Text>
    </View>;
    return (
        <View testID={props.testIDPrefix}>
            <View style={workflowEditorStyles.metaRow}>
                <Text style={workflowEditorStyles.metaText}>
                    {props.condition === undefined ? `${props.label} · ${t('workflows.condition.always')}` : props.label}
                </Text>
                {props.condition === undefined ? (
                    <ConditionAction
                        label={t('workflows.condition.addCondition')}
                        onPress={() => props.onChange(DEFAULT_CONDITION)}
                        testID={`${props.testIDPrefix}-add-condition`}
                    />
                ) : props.required === true ? null : (
                    <ConditionAction
                        label={t('workflows.condition.removeCondition')}
                        onPress={() => props.onChange(undefined)}
                        testID={`${props.testIDPrefix}-remove-condition`}
                    />
                )}
            </View>
            {props.condition === undefined ? null : (
                <ConditionNode
                    condition={props.condition}
                    draft={props.draft}
                    consumerBlockId={props.consumerBlockId}
                    {...(props.continuation === true ? { continuation: true } : {})}
                    kindTitle={props.label}
                    onChange={(condition) => props.onChange(condition)}
                    testIDPrefix={props.testIDPrefix}
                    depth={0}
                />
            )}
        </View>
    );
}
