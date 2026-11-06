import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { formatWorkflowConditionSentence, WORKFLOW_CONDITION_OPERATOR_LABEL_KEYS as OPERATOR_LABEL_KEYS } from '../presentation/workflowConditionPresentation';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';

import {
    collectWorkflowConditionValueReferences,
    type WorkflowCondition,
    type WorkflowValueReference,
} from '@happier-dev/protocol/workflows/workflowReferenceV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text, TextInput } from '@/components/ui/text/Text';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';

import {
    addWorkflowConditionRow,
    isWorkflowConditionUnset,
    listWorkflowConditionTests,
    readWorkflowConditionGroup,
    readWorkflowConditionRule,
    removeWorkflowConditionRow,
    workflowConditionWithTest,
    workflowConditionWithValue,
    WORKFLOW_CONDITION_UNSET,
    writeWorkflowConditionGroup,
    type WorkflowConditionGroupMode,
    type WorkflowConditionTest,
    type WorkflowConditionValueFacts,
} from '../presentation/workflowConditionRules';
import { workflowEditorStyles } from './workflowEditorStyles';
import { resolveWorkflowConditionValueFacts } from './workflowConditionValueOptions';
import { WorkflowFieldSelect, WorkflowReferenceSentence } from './WorkflowStepDataEditor';
import { WorkflowValuePicker } from './WorkflowValuePicker';

const GROUP_MODE_LABEL_KEYS = {
    all: 'workflows.condition.allOf',
    any: 'workflows.condition.anyOf',
    none: 'workflows.condition.noneOf',
    not_all: 'workflows.condition.notAllOf',
} as const;

function testLabel(test: WorkflowConditionTest): string {
    if (test === 'exists') return t('workflows.condition.exists');
    if (test === 'not_exists') return t('workflows.condition.notExists');
    return t(OPERATOR_LABEL_KEYS[test]);
}

function ConditionAction(props: Readonly<{
    label: string;
    onPress: () => void;
    testID?: string;
    leadingPlus?: boolean;
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
                workflowEditorStyles.addRow,
                state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            {props.leadingPlus === true ? <Icon name="plus" size={ICON_SIZE.xs} color={theme.colors.text.secondary} /> : null}
            <Text style={workflowEditorStyles.metaAction}>{props.label}</Text>
        </HappierPressable>
    );
}

type RuleContext = Readonly<{
    draft: WorkflowEditorDraft;
    consumerBlockId: string;
    continuation: boolean;
}>;

function literalText(value: unknown): string {
    return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
}

/** The compared value: the control its type asks for, or another value picked by name. */
function ConditionComparedValue(props: RuleContext & Readonly<{
    facts: WorkflowConditionValueFacts;
    right: WorkflowValueReference;
    onChange: (right: WorkflowValueReference) => void;
    testID: string;
}>): React.ReactElement {
    const { right, facts } = props;
    if (right.kind !== 'literal') {
        return <WorkflowValuePicker draft={props.draft} consumerBlockId={props.consumerBlockId} continuation={props.continuation} reference={right} label={t('workflows.condition.valuePlaceholder')}
            onChange={(next) => props.onChange(next)}
            onChooseFixedValue={() => props.onChange({ kind: 'literal', value: facts.type === 'boolean' ? true : facts.type === 'number' ? 0 : facts.choices?.[0] ?? '' })}
            testID={`${props.testID}-reference`} pathTestID={`${props.testID}-path`} />;
    }
    const swap = <ConditionCompareSwap {...props} testID={`${props.testID}-swap`} />;
    if (facts.type === 'boolean' && typeof right.value === 'boolean') {
        return <>
            <SegmentedTabBar<'yes' | 'no'> role="radiogroup" segmentSizing="content" accessibilityLabel={t('workflows.condition.valuePlaceholder')}
                testIDPrefix={`${props.testID}-boolean`} activeTabId={right.value ? 'yes' : 'no'}
                tabs={[{ id: 'yes', label: t('common.yes') }, { id: 'no', label: t('common.no') }]}
                onSelectTab={(id) => props.onChange({ kind: 'literal', value: id === 'yes' })} />
            {swap}
        </>;
    }
    if (facts.type === 'choice' && facts.choices !== undefined && facts.choices.length > 0) {
        return <>
            <WorkflowFieldSelect testID={`${props.testID}-choice`} label={t('workflows.condition.valuePlaceholder')}
                items={facts.choices.map((choice) => ({ id: choice, testID: `${props.testID}-choice-${choice}`, title: choice }))}
                selectedId={typeof right.value === 'string' ? right.value : null}
                onSelect={(value) => props.onChange({ kind: 'literal', value })} />
            {swap}
        </>;
    }
    return <>
        <TextInput
            testID={`${props.testID}-literal`}
            style={[workflowEditorStyles.inlineValue, workflowEditorStyles.conditionLiteral]}
            value={literalText(right.value)}
            placeholder={t('workflows.condition.literalPlaceholder')}
            accessibilityLabel={t('workflows.condition.valuePlaceholder')}
            keyboardType={facts.type === 'number' ? 'numeric' : 'default'}
            onChangeText={(text) => {
                if (facts.type === 'number' && text.trim().length > 0 && Number.isFinite(Number(text))) {
                    props.onChange({ kind: 'literal', value: Number(text) });
                    return;
                }
                props.onChange({ kind: 'literal', value: text });
            }}
        />
        {swap}
    </>;
}

/** A compared value is usually typed; comparing to another value stays one quiet press away. */
function ConditionCompareSwap(props: RuleContext & Readonly<{
    onChange: (right: WorkflowValueReference) => void;
    testID: string;
}>): React.ReactElement {
    return <WorkflowValuePicker draft={props.draft} consumerBlockId={props.consumerBlockId} continuation={props.continuation}
        reference={null} label={t('workflows.condition.compareToValue')} onChange={(next) => props.onChange(next)} testID={props.testID}
        renderTrigger={({ toggle }) => (
            <IconButton testID={`${props.testID}-trigger`} variant="plain" iconName="link"
                accessibilityLabel={t('workflows.condition.compareToValue')} tooltip={t('workflows.condition.compareToValue')} onPress={toggle} />
        )} />;
}

/** One rule, read as its sentence: the value, its test, and what it is compared to. */
function ConditionRule(props: RuleContext & Readonly<{
    condition: WorkflowCondition;
    /** The sentence's first word ("If", "Stop when"), when it is one rule alone. */
    lead?: string;
    onChange: (condition: WorkflowCondition) => void;
    onRemove?: () => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const rule = readWorkflowConditionRule(props.condition);
    const unset = isWorkflowConditionUnset(props.condition);
    const left = rule?.left ?? null;
    const facts = left === null || unset ? { type: 'unknown' as const } : resolveWorkflowConditionValueFacts(props.draft, left);
    const remove = props.onRemove === undefined ? null : (
        <IconButton testID={`${props.testIDPrefix}-remove`} variant="plain" iconName="x"
            accessibilityLabel={t('workflows.condition.removeCondition')} tooltip={t('workflows.condition.removeCondition')} onPress={props.onRemove} />
    );
    if (rule === null) return <ConditionNested {...props} />;
    return (
        <View testID={props.testIDPrefix}>
            <View style={workflowEditorStyles.conditionRule}>
                {props.lead === undefined ? null : <Text style={workflowEditorStyles.conditionLead}>{props.lead}</Text>}
                <WorkflowValuePicker draft={props.draft} consumerBlockId={props.consumerBlockId} continuation={props.continuation} reference={unset ? null : left} label={t('workflows.condition.valuePlaceholder')}
                    onChange={(next, nextFacts) => props.onChange(workflowConditionWithValue(props.condition, next, nextFacts))}
                    testID={`${props.testIDPrefix}-value`} pathTestID={`${props.testIDPrefix}-path`} />
                {unset ? null : <WorkflowFieldSelect testID={`${props.testIDPrefix}-test`} label={t('workflows.condition.operatorEq')}
                    items={listWorkflowConditionTests(facts, rule.test).map((test) => ({ id: test, testID: `${props.testIDPrefix}-test-${test}`, title: testLabel(test) }))}
                    selectedId={rule.test}
                    onSelect={(test) => props.onChange(workflowConditionWithTest(props.condition, test as WorkflowConditionTest, facts))} />}
                {unset || rule.right === undefined ? null : <ConditionComparedValue {...props} facts={facts} right={rule.right}
                    onChange={(right) => props.onChange({ kind: 'compare', operator: rule.test as Extract<WorkflowCondition, { kind: 'compare' }>['operator'], left: rule.left, right })}
                    testID={`${props.testIDPrefix}-right`} />}
                {remove === null ? null : <View style={workflowEditorStyles.conditionRemove}>{remove}</View>}
            </View>
            {unset ? <Text testID={`${props.testIDPrefix}-unset-hint`} style={[workflowEditorStyles.metaText, workflowEditorStyles.conditionHint]}>{t('workflows.condition.chooseValueHint')}</Text> : null}
        </View>
    );
}

/** A shape one sentence cannot say: a nested group, or a negation of something other than presence. */
function ConditionNested(props: RuleContext & Readonly<{
    condition: WorkflowCondition;
    onChange: (condition: WorkflowCondition) => void;
    onRemove?: () => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { condition } = props;
    const remove = props.onRemove === undefined ? null : (
        <IconButton testID={`${props.testIDPrefix}-remove`} variant="plain" iconName="x"
            accessibilityLabel={t('workflows.condition.removeCondition')} tooltip={t('workflows.condition.removeCondition')} onPress={props.onRemove} />
    );
    if (condition.kind === 'not' && readWorkflowConditionGroup(condition).mode === 'single') {
        return <View testID={`${props.testIDPrefix}-not`} style={workflowEditorStyles.conditionRule}>
            <Text style={workflowEditorStyles.conditionLead}>{t('workflows.condition.not')}</Text>
            <ConditionRule draft={props.draft} consumerBlockId={props.consumerBlockId} continuation={props.continuation} condition={condition.condition}
                onChange={(next) => props.onChange({ kind: 'not', condition: next })} testIDPrefix={`${props.testIDPrefix}-inner`} />
            {remove === null ? null : <View style={workflowEditorStyles.conditionRemove}>{remove}</View>}
        </View>;
    }
    return <View style={workflowEditorStyles.conditionNested}>
        <ConditionGroup draft={props.draft} consumerBlockId={props.consumerBlockId} continuation={props.continuation} condition={condition}
            onChange={props.onChange} label={t('workflows.condition.not')} hideLabel
            {...(props.onRemove === undefined ? {} : { removable: props.onRemove })} testIDPrefix={props.testIDPrefix} />
    </View>;
}

/** All the rules of one condition; a single rule stays a sentence, and only two or more ask how they combine. */
function ConditionGroup(props: RuleContext & Readonly<{
    condition: WorkflowCondition;
    label: string;
    hideLabel?: boolean;
    /** Removing the last rule leaves no condition, when the host allows that. */
    onRemoveAll?: () => void;
    removable?: () => void;
    onChange: (condition: WorkflowCondition) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { mode, rows } = readWorkflowConditionGroup(props.condition);
    const add = <ConditionAction leadingPlus label={t('workflows.condition.addCondition')} testID={`${props.testIDPrefix}-add`}
        onPress={() => props.onChange(addWorkflowConditionRow(props.condition))} />;
    if (mode === 'single') {
        return <View style={workflowEditorStyles.conditionGroup}>
            <ConditionRule {...props} lead={props.label} condition={props.condition}
                {...(props.onRemoveAll === undefined ? {} : { onRemove: props.onRemoveAll })} />
            {isWorkflowConditionUnset(props.condition) ? null : add}
        </View>;
    }
    const modes: readonly WorkflowConditionGroupMode[] = mode === 'not_all' ? ['all', 'any', 'none', 'not_all'] : ['all', 'any', 'none'];
    return (
        <View style={workflowEditorStyles.conditionGroup}>
            <View style={workflowEditorStyles.conditionRule}>
                {props.hideLabel === true ? null : <Text style={workflowEditorStyles.conditionLead}>{props.label}</Text>}
                <WorkflowFieldSelect testID={`${props.testIDPrefix}-mode`} label={props.label}
                    items={modes.map((candidate) => ({ id: candidate, testID: `${props.testIDPrefix}-mode-${candidate}`, title: t(GROUP_MODE_LABEL_KEYS[candidate as keyof typeof GROUP_MODE_LABEL_KEYS]) }))}
                    selectedId={mode}
                    onSelect={(next) => props.onChange(writeWorkflowConditionGroup(next as WorkflowConditionGroupMode, rows))} />
                {props.removable === undefined ? null : <View style={workflowEditorStyles.conditionRemove}>
                    <IconButton testID={`${props.testIDPrefix}-remove`} variant="plain" iconName="x"
                        accessibilityLabel={t('workflows.condition.removeCondition')} onPress={props.removable} />
                </View>}
            </View>
            {rows.map((row, index) => (
                <ConditionRule
                    key={index}
                    draft={props.draft}
                    consumerBlockId={props.consumerBlockId}
                    continuation={props.continuation}
                    condition={row}
                    onChange={(next) => props.onChange(writeWorkflowConditionGroup(mode, rows.map((current, candidate) => candidate === index ? next : current)))}
                    onRemove={() => {
                        const next = removeWorkflowConditionRow(props.condition, index);
                        props.onChange(next ?? WORKFLOW_CONDITION_UNSET);
                    }}
                    testIDPrefix={`${props.testIDPrefix}-${index}`}
                />
            ))}
            {add}
        </View>
    );
}

/**
 * A condition: "Always" + Add condition while absent (unless required), then its rules as sentences
 * (lab round 1105 C1). If, Only run when and a loop's Stop when all read and edit the same way.
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
    if (props.condition === undefined) {
        return (
            <View testID={props.testIDPrefix} style={workflowEditorStyles.metaRow}>
                <Text style={workflowEditorStyles.metaText}>{`${props.label} · ${t('workflows.condition.always')}`}</Text>
                <ConditionAction
                    label={t('workflows.condition.addCondition')}
                    onPress={() => props.onChange(WORKFLOW_CONDITION_UNSET)}
                    testID={`${props.testIDPrefix}-add-condition`}
                />
            </View>
        );
    }
    return (
        <View testID={props.testIDPrefix}>
            <ConditionGroup
                condition={props.condition}
                label={props.label}
                draft={props.draft}
                consumerBlockId={props.consumerBlockId}
                continuation={props.continuation === true}
                {...(props.required === true ? {} : { onRemoveAll: () => props.onChange(undefined) })}
                onChange={(condition) => props.onChange(condition)}
                testIDPrefix={props.testIDPrefix}
            />
        </View>
    );
}
