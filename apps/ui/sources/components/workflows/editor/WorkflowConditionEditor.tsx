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
} from '@happier-dev/protocol/workflows/workflowReferenceV1';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
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
export function formatWorkflowConditionSentence(draft: WorkflowEditorDraft, condition: WorkflowCondition): string {
    switch (condition.kind) {
        case 'exists':
            return `${formatWorkflowValueReference(draft, condition.value)} ${t('workflows.condition.exists')}`;
        case 'compare':
            return `${formatWorkflowValueReference(draft, condition.left)} ${t(OPERATOR_LABEL_KEYS[condition.operator])} ${formatWorkflowValueReference(draft, condition.right)}`;
        case 'not':
            return t('workflows.page.inspector.conditionNot', { condition: formatWorkflowConditionSentence(draft, condition.condition) });
        case 'all':
        case 'any':
            return `${condition.kind === 'all' ? t('workflows.page.inspector.conditionAll') : t('workflows.page.inspector.conditionAny')}: ${condition.conditions.map((child) => formatWorkflowConditionSentence(draft, child)).join('; ')}`;
    }
}

/**
 * A condition as the lead of a container sentence: a compound condition's own words ("any of these
 * holds:"), whose arms then read as {@link WorkflowConditionArmLines}; any other condition whole.
 * A heading never runs into a paragraph of tokens (E1), and the words are the sentence's own.
 */
export function formatWorkflowConditionLead(draft: WorkflowEditorDraft, condition: WorkflowCondition): string {
    if (condition.kind !== 'all' && condition.kind !== 'any') return formatWorkflowConditionSentence(draft, condition);
    return `${condition.kind === 'all' ? t('workflows.page.inspector.conditionAll') : t('workflows.page.inspector.conditionAny')}:`;
}

/** A compound condition's arms, one quiet line each, nested compounds indented beneath their lead. */
export function WorkflowConditionArmLines(props: Readonly<{
    draft: WorkflowEditorDraft;
    condition: WorkflowCondition;
    testID?: string;
}>): React.ReactElement | null {
    const { condition } = props;
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
