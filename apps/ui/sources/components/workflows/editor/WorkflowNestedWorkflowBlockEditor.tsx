import * as React from 'react';
import { View } from 'react-native';

import type { WorkflowNestedLeafV1 } from '@happier-dev/protocol/workflows/workflowLeafV1';
import type { WorkflowValueReference } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import type { WorkflowInputDefinition } from '@happier-dev/protocol/workflows/workflowV1';
import { projectWorkflowRunInputFields } from '@/sync/domains/workflows/workflowAuthoring';
import { useWorkflowReferenceDefinition } from '@/components/workflows/presentation/useWorkflowReferenceDefinition';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import { Text } from '@/components/ui/text/Text';
import type { WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { t } from '@/text';
import { resolveWorkflowUnnamedHeading, workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';

import type { WorkflowBlockAction } from './WorkflowBlockActionsMenu';
import { WorkflowBlockHeading, type WorkflowBlockNameEditor } from './WorkflowBlockHeading';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { resolveWorkflowBuiltinInputPresentation } from '@/components/workflows/presentation/workflowBuiltinInputPresentation';
import { WORKFLOW_BLOCK_KIND_GLYPH } from '@/components/workflows/presentation/workflowBlockKindGlyph';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { formatWorkflowConditionSentence } from './WorkflowConditionEditor';
import type { WorkflowDocumentStepSlots } from './workflowDocumentPresentation';
import { WorkflowKindCard } from './WorkflowKindCard';
import { WorkflowStepOptionsFootChip } from './WorkflowStepOptionsChip';
import {
    listBuiltinWorkflowReferenceOptions,
    useWorkflowReferenceLibrary,
} from '@/components/workflows/presentation/workflowReferenceOptions';

import { workflowEditorStyles } from './workflowEditorStyles';
import { formatWorkflowBindingLiteral, formatWorkflowFieldLabel, WorkflowBindingRow, WorkflowValueReferenceEditor } from './WorkflowStepDataEditor';

/** "Open ›": the child workflow's own page (its definition, built-in or saved). */
function WorkflowNestedOpenAction(props: Readonly<{ workflowRef: string; workflowName: string; testID: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    const router = useRouter();
    return (
        <HappierPressable
            testID={props.testID}
            accessibilityRole="link"
            accessibilityLabel={t('workflows.page.blocks.openWorkflow', { workflow: props.workflowName })}
            onPress={() => router.push(createWorkflowDefinitionRoute(props.workflowRef) as never)}
            style={(state) => [workflowEditorStyles.actionTarget, workflowEditorStyles.trailingControl,
                state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
        >
            <Text style={workflowEditorStyles.footAction}>{t('common.open')}</Text>
            <Icon name="caret-right" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
        </HappierPressable>
    );
}

/** A child input's declared default, in the reader's words (an option label when the child names one). */
function formatChildInputDefault(
    draft: WorkflowEditorDraft,
    input: WorkflowInputDefinition | undefined,
    optionLabels: Readonly<Record<string, string>> | undefined,
): string | undefined {
    if (input?.default === undefined) return undefined;
    if (typeof input.default === 'string' && optionLabels?.[input.default] !== undefined) return optionLabels[input.default];
    return formatWorkflowBindingLiteral(draft, { kind: 'literal', value: input.default });
}

/**
 * A Run a workflow step (U4, 04 §4.3; lab `editor-S6` "Review the release"):
 * the same card an Action step uses — the child's mark, name and origin with
 * Open ›, one label/value row per declared input (bound by reference, or its
 * default, or "+ Set"), and the foot "Runs another workflow · its steps show in
 * this run" with Step options. Inputs already bound but not declared (a child
 * this client cannot read, or one that changed) stay visible.
 */
export function WorkflowNestedWorkflowBlockEditor(props: Readonly<{
    block: WorkflowNestedLeafV1;
    draft: WorkflowEditorDraft;
    ordinal: number;
    /** The block's visible number (`workflowBlockOrdinalV1`); `null` for a container. */
    visibleOrdinal?: string | null;
    /** Whether this step is the selected block: its ordinal fills. */
    selected?: boolean;
    nameEditor?: WorkflowBlockNameEditor;
    total: number;
    actions: readonly WorkflowBlockAction[];
    onSelect: () => void;
    onChangeBlock: (next: WorkflowNestedLeafV1) => void;
    editable?: boolean;
    /** Registers the block's heading as its focus target (blocks without a prompt). */
    focusRegistration?: (focus: (() => void) | null) => void;
    /** Each input's revealed issue, by input name, in the editor's words (DESIGN-6 P3). */
    fieldIssues?: Readonly<Record<string, string>>;
    slots?: WorkflowDocumentStepSlots | null;
    /** Opens this block's Step options, anchored beside its options control; absent when read-only. */
    onOpenOptions?: (anchorRef: React.RefObject<View | null>) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { block, testIDPrefix } = props;
    const { theme } = useUnistyles();
    const editable = props.editable !== false;
    const frozen = props.slots?.nestedDefinition;
    const library = useWorkflowReferenceLibrary({ enabled: frozen === undefined });
    const libraryOptions = library.options;
    const known = [...listBuiltinWorkflowReferenceOptions(), ...libraryOptions]
        .find((option) => option.ref === block.workflowRef) ?? null;
    const childName = known?.title ?? t('workflows.page.blocks.menuRun');
    const displayName = workflowBlockReferenceLabel(block, childName);
    const child = useWorkflowReferenceDefinition(frozen === undefined ? block.workflowRef : null, frozen === undefined);
    const definition = frozen === undefined ? child.definition : frozen;
    const declared = React.useMemo(() => definition === null ? null
        : projectWorkflowRunInputFields({ inputs: definition.inputs, values: {} }).map((field) => field.definition), [definition]);
    const inputNames = React.useMemo(() => {
        const names = (declared ?? []).map((input) => input.name);
        for (const name of Object.keys(block.input)) if (!names.includes(name)) names.push(name);
        return names;
    }, [block.input, declared]);
    // A built-in names its inputs for people; an authored child names its own.
    const presentation = resolveWorkflowBuiltinInputPresentation(block.workflowRef);
    const rowPrefix = `${testIDPrefix}-workflow-${block.id}`;
    // Unnamed, the heading carries the card's identity (mark, title, Built-in, Open ›); the card shows its rows.
    const headingCarriesCard = resolveWorkflowUnnamedHeading(block) === 'card';
    const openAction = known === null ? undefined
        : <WorkflowNestedOpenAction workflowRef={block.workflowRef} workflowName={childName} testID={`${rowPrefix}-open`} />;

    const setBinding = (name: string, binding: WorkflowValueReference | undefined) => {
        const { [name]: _previous, ...rest } = block.input;
        props.onChangeBlock({ ...block, input: binding === undefined ? rest : { ...rest, [name]: binding } });
    };

    return (
        <View testID={rowPrefix} style={workflowEditorStyles.blockBody}>
            <WorkflowBlockHeading
                nameEditor={props.nameEditor}
                kindMark={<Icon name={WORKFLOW_BLOCK_KIND_GLYPH.workflow} size={ICON_SIZE.sm} />}
                ordinal={props.ordinal}
                selected={props.selected}
                unnamed={resolveWorkflowUnnamedHeading(block)}
                visibleOrdinal={props.visibleOrdinal ?? null}
                {...(props.focusRegistration === undefined ? {} : { focusRegistration: props.focusRegistration })}
                displayName={displayName}
                {...(headingCarriesCard && known?.origin === 'builtin' ? { sourceLabel: t('workflows.page.blocks.builtin') } : {})}
                {...(headingCarriesCard && openAction !== undefined ? { trailing: openAction } : {})}
                accessibilityLabel={t('workflows.a11y.stepContext', { block: displayName, position: props.ordinal, total: props.total })}
                actions={editable ? props.actions : []}
                accessory={props.slots?.state}
                onSelect={props.onSelect}
                testID={`${rowPrefix}-label`}
                actionsTestID={`${rowPrefix}-actions`}
            />
            {props.slots?.occurrenceSelector ?? null}
            <WorkflowKindCard
                testID={`${rowPrefix}-card`}
                mark={<Icon name={WORKFLOW_BLOCK_KIND_GLYPH.workflow} size={ICON_SIZE.sm} />}
                title={childName}
                {...(known?.origin === 'builtin' ? { source: t('workflows.page.blocks.builtin') } : {})}
                {...(openAction === undefined || headingCarriesCard ? {} : { headerAction: openAction })}
                header={!headingCarriesCard}
                note={t('workflows.page.blocks.workflowSub')}
                footAccessory={props.onOpenOptions === undefined || !editable ? undefined : (
                    <WorkflowStepOptionsFootChip
                        label={block.onlyWhen === undefined
                            ? t('workflows.page.blocks.workflowDefaults')
                            : t('workflows.page.inspector.onlyWhenSentence', {
                                condition: formatWorkflowConditionSentence(props.draft, block.onlyWhen),
                            })}
                        changed={block.onlyWhen !== undefined}
                        onOpen={props.onOpenOptions}
                        testID={`${rowPrefix}-options`}
                        labelTestID={`${rowPrefix}-options-label`}
                    />
                )}
            >
                {child.status === 'loading' && inputNames.length === 0
                    ? <Text style={workflowEditorStyles.kindCardNote}>{t('common.loading')}</Text> : null}
                {child.status === 'failed' ? <View style={workflowEditorStyles.metaRow}>
                    <Text accessibilityRole="alert" style={workflowEditorStyles.metaText}>{t('workflows.editor.loadFailedBody')}</Text>
                    <HappierPressable accessibilityRole="button" testID={`${rowPrefix}-retry`}
                        accessibilityLabel={t('workflows.page.blocks.retryLoading')}
                        style={(state) => [workflowEditorStyles.actionTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                        onPress={child.retry}>
                        <Text style={workflowEditorStyles.metaAction}>{t('workflows.page.blocks.retryLoading')}</Text>
                    </HappierPressable>
                </View> : null}
                {frozen === null ? <Text style={workflowEditorStyles.metaText}>{t('workflows.contentUnavailable')}</Text> : null}
                {inputNames.map((name) => {
                    const binding = block.input[name];
                    const declaration = declared?.find((input) => input.name === name);
                    const shown = presentation?.[name];
                    const fieldId = `${rowPrefix}-input-${name}`;
                    const defaultLabel = formatChildInputDefault(props.draft, declaration, shown?.optionLabels);
                    return (
                        <WorkflowBindingRow
                            key={name}
                            testID={fieldId}
                            label={shown?.title ?? formatWorkflowFieldLabel(name)}
                            required={declaration?.required === true}
                            binding={binding}
                            {...(defaultLabel === undefined ? {} : { defaultLabel })}
                            draft={props.draft}
                            editable={editable}
                            editing={props.selected === true}
                            onEdit={props.onSelect}
                            {...(props.fieldIssues?.[name] === undefined ? {} : { issue: props.fieldIssues[name] })}
                            {...(shown?.optionLabels === undefined ? {} : { formatLiteral: (value: unknown) =>
                                typeof value === 'string' ? shown.optionLabels?.[value] ?? null : null })}
                            onSet={() => { setBinding(name, { kind: 'literal', value: declaration?.default ?? '' }); props.onSelect(); }}
                            renderEditor={() => binding === undefined ? null : (
                                <WorkflowValueReferenceEditor
                                    reference={binding}
                                    index={0}
                                    draft={props.draft}
                                    stepId={block.id}
                                    onChange={(next) => setBinding(name, next)}
                                    {...(declaration?.required === true ? {} : { onRemove: () => setBinding(name, undefined) })}
                                    testIDPrefix={fieldId}
                                />
                            )}
                        />
                    );
                })}
            </WorkflowKindCard>
            {props.slots?.reviewedCard ?? null}
            {props.slots?.footer ?? null}
        </View>
    );
}
