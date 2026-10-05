import * as React from 'react';
import { View } from 'react-native';

import type { WorkflowConversationSelection, WorkflowReferenceScope } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import type { WorkflowWorkspaceSelection } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SelectionList, type SelectionListStep } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import {
    listWorkflowProducerOptions,
    resolveWorkflowReferenceScopeFacts,
    type WorkflowExistingSessionOption,
    type WorkflowProducerOption,
} from '@/sync/domains/workflows/workflowAuthoring';
import { type WorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { findWorkflowBlock, walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { workflowBlockReferenceLabel } from '@/sync/domains/workflows/workflowBlockLabel';
import { t } from '@/text';

import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * Conversation and workspace continuity, authored as the canonical selection
 * vocabulary, as two field selects (04 §5.2, M8). Both are separate from
 * dataflow: continuing a conversation never implies reusing a workspace, and
 * sharing a workspace never implies sharing history.
 *
 * For a step (`inherited` given) the first option of each field is "Workflow
 * default · {value}", which deletes the step's own choice so later default
 * changes reach it; every explicit option — including the one equal to today's
 * default — stays offered, because choosing it pins that value (F24).
 *
 * "A session…" opens the canonical Session picker over the host's candidates
 * (its Session candidacy and machine owners); the editor never lists Sessions
 * itself and never fabricates a Session id.
 */

const NO_EXISTING_SESSIONS: readonly WorkflowExistingSessionOption[] = [];
const DEFAULT_OPTION_ID = 'default';
const EXISTING_SESSION_OPTION_ID = 'existing_session';

function scopeKey(scope: WorkflowReferenceScope): string {
    return JSON.stringify(scope);
}

function blockLabelOf(draft: WorkflowEditorDraft, blockId: string): string {
    const block = findWorkflowBlock(draft, blockId);
    return block === null ? blockId : workflowBlockReferenceLabel(block);
}

/** One conversation choice in words: the same label in the field, its summary and the settings group line. */
export function formatWorkflowConversationLabel(params: Readonly<{
    draft: WorkflowEditorDraft;
    conversation: WorkflowConversationSelection | undefined;
    existingSessions?: readonly WorkflowExistingSessionOption[];
}>): string {
    const conversation = params.conversation ?? { kind: 'shared_run' as const };
    switch (conversation.kind) {
        case 'shared_run': return t('workflows.conversation.sharedRun');
        case 'fresh': return t('workflows.conversation.fresh');
        case 'origin_session': return t('workflows.page.inspector.originSession');
        case 'from_step': return t('workflows.conversation.fromStep', { block: blockLabelOf(params.draft, conversation.producer.blockId) });
        case 'existing_session':
            return t('workflows.page.inspector.continues', {
                // A recorded Session this host cannot list (imported, or no longer
                // offered here) stays visible by its exact identity, never hidden.
                session: params.existingSessions?.find((option) => option.sessionId === conversation.sessionId)?.label
                    ?? t('workflows.conversation.existingSessionById', { sessionId: conversation.sessionId }),
            });
    }
}

/** One workspace choice in words. */
export function formatWorkflowWorkspaceLabel(draft: WorkflowEditorDraft, workspace: WorkflowWorkspaceSelection | undefined): string {
    const value = workspace ?? { kind: 'inherit' as const };
    switch (value.kind) {
        case 'inherit': return t('workflows.workspace.inherit');
        case 'project_checkout': return t('workflows.workspace.projectCheckout');
        case 'from_step': return t('workflows.workspace.fromStep', { block: blockLabelOf(draft, value.producer.blockId) });
        case 'new_worktree':
            if (value.source.kind === 'original') return t('workflows.workspace.newWorktreeOriginal');
            if (value.source.kind === 'workflow') return t('workflows.workspace.newWorktreeWorkflow');
            return t('workflows.workspace.newWorktreeStep', { block: blockLabelOf(draft, value.source.producer.blockId) });
    }
}

/**
 * The closed reading of a conversation and workspace choice ("Same
 * conversation · Workflow workspace"): the same labels the fields offer, so a
 * settings summary never words a choice differently from its row.
 */
export function formatWorkflowContinuitySummary(params: Readonly<{
    draft: WorkflowEditorDraft;
    conversation: WorkflowConversationSelection | undefined;
    workspace: WorkflowWorkspaceSelection | undefined;
    existingSessions?: readonly WorkflowExistingSessionOption[];
}>): string {
    return `${formatWorkflowConversationLabel(params)} · ${formatWorkflowWorkspaceLabel(params.draft, params.workspace)}`;
}

function conversationOptionId(conversation: WorkflowConversationSelection): string {
    switch (conversation.kind) {
        case 'from_step': return `from_step:${conversation.producer.blockId}:${scopeKey(conversation.producer.scope)}`;
        default: return conversation.kind;
    }
}

function workspaceOptionId(workspace: WorkflowWorkspaceSelection): string {
    switch (workspace.kind) {
        case 'from_step': return `from_step:${workspace.producer.blockId}:${scopeKey(workspace.producer.scope)}`;
        case 'new_worktree':
            return workspace.source.kind === 'step'
                ? `new_worktree:step:${workspace.source.producer.blockId}:${scopeKey(workspace.source.producer.scope)}`
                : `new_worktree:${workspace.source.kind}`;
        default: return workspace.kind;
    }
}

function producerRef(producer: WorkflowProducerOption) {
    return { blockId: producer.blockId, scope: producer.scope };
}

/** A field select whose options carry their own values; the menu's controlled open state is local. */
function ContinuityField(props: Readonly<{
    title: string;
    items: ReadonlyArray<DropdownMenuItem>;
    selectedId: string;
    onSelect: (id: string) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    return (
        <DropdownMenu
            testID={`${props.testIDPrefix}-field`}
            open={open}
            onOpenChange={setOpen}
            selectedId={props.selectedId}
            items={props.items}
            onSelect={props.onSelect}
            itemTrigger={{ title: props.title, itemProps: { testID: props.testIDPrefix } }}
        />
    );
}

export function WorkflowContinuityControls(props: Readonly<{
    draft: WorkflowEditorDraft;
    consumerBlockId?: string;
    /** This subject's own choice; `undefined` means it inherits (a step) or reads the default (the workflow). */
    conversation: WorkflowConversationSelection | undefined;
    workspace: WorkflowWorkspaceSelection | undefined;
    /** A step's effective workflow defaults: present, the fields offer "Workflow default · {value}" first. */
    inherited?: Readonly<{
        conversation: WorkflowConversationSelection | undefined;
        workspace: WorkflowWorkspaceSelection | undefined;
    }>;
    /** Existing Sessions the host offers for continuation; absent means none can be offered here. */
    existingSessions?: readonly WorkflowExistingSessionOption[];
    onChangeConversation: (value: WorkflowConversationSelection | undefined) => void;
    onBindExistingSession?: (sessionId: string) => Promise<EntityDropOutcomeV1>;
    onChangeWorkspace: (value: WorkflowWorkspaceSelection | undefined) => void;
    testIDPrefix: string;
}>): React.ReactElement {
    const { draft, onChangeConversation, onChangeWorkspace, testIDPrefix } = props;
    const producers = props.consumerBlockId === undefined
        ? []
        : listWorkflowProducerOptions(draft, props.consumerBlockId);
    const existingSessions = props.existingSessions ?? NO_EXISTING_SESSIONS;
    const existingSessionOffered = existingSessions.length > 0 && props.onBindExistingSession !== undefined;
    const inherits = props.inherited !== undefined;

    // What actually runs: the step's own choice, else the default it inherits.
    const effectiveConversation = props.conversation ?? props.inherited?.conversation;
    const effectiveWorkspace = props.workspace ?? props.inherited?.workspace;
    const conversationKind = effectiveConversation?.kind ?? 'shared_run';
    const workspaceKind = effectiveWorkspace?.kind ?? 'inherit';

    // A from-step continuation joins one specific producer's conversation, so
    // the waiting disclosure names the producer the selection actually
    // records — not the first offered one — and stays silent when the recorded
    // producer is no longer offered here.
    const conversationFromStep = effectiveConversation?.kind === 'from_step' ? effectiveConversation : null;
    const fromStepProducer = conversationFromStep === null
        ? null
        : producers.find((option) => option.blockId === conversationFromStep.producer.blockId
            && scopeKey(option.scope) === scopeKey(conversationFromStep.producer.scope)) ?? null;

    /**
     * Branches that resolve to one directory write to it at the same time, and
     * that is allowed (UX-10) — so it is stated, not prevented. The step's own
     * scope decides for a step; the workflow defaults reach every branch.
     */
    const sharesWorkspaceWithParallelSiblings = workspaceKind !== 'new_worktree' && (
        props.consumerBlockId === undefined
            ? walkWorkflowBlocks(draft.blocks).some((block) => block.kind === 'parallel')
            : resolveWorkflowReferenceScopeFacts(draft, props.consumerBlockId).insideParallel
    );

    // Choosing "A session…" needs a Session before it is a selection, so the
    // option opens the picker; the selection is authored when a row is chosen
    // and the picker closes.
    const [choosingSession, setChoosingSession] = React.useState(false);
    const [bindingRefusal, setBindingRefusal] = React.useState<string | null>(null);
    const recordedSession = props.conversation?.kind === 'existing_session' ? props.conversation : null;
    const existingSessionStep = React.useMemo<SelectionListStep>(() => ({
        id: `${testIDPrefix}-conversation-existing-session`,
        inputPlaceholder: t('sessionsList.searchSessionsPlaceholder'),
        sections: [{
            kind: 'static',
            id: 'sessions',
            options: existingSessions.map((option) => ({
                id: option.sessionId,
                label: option.label,
                testID: `${testIDPrefix}-conversation-session-${option.sessionId}`,
            })),
        }],
    }), [existingSessions, testIDPrefix]);
    const selectExistingSession = React.useCallback(async (sessionId: string) => {
        const option = existingSessions.find((candidate) => candidate.sessionId === sessionId);
        if (option === undefined || !props.onBindExistingSession) return;
        const outcome = await props.onBindExistingSession(sessionId);
        if (outcome.status === 'applied') {
            setBindingRefusal(null);
            setChoosingSession(false);
        } else if ('reason' in outcome) setBindingRefusal(outcome.reason.message);
    }, [existingSessions, props.onBindExistingSession]);

    const conversationChoices = new Map<string, WorkflowConversationSelection>();
    const conversationItems: DropdownMenuItem[] = [];
    if (inherits) {
        conversationItems.push({
            id: DEFAULT_OPTION_ID,
            title: t('workflows.page.inspector.workflowDefault', {
                value: formatWorkflowConversationLabel({ draft, conversation: props.inherited?.conversation, existingSessions }),
            }),
            testID: `${testIDPrefix}-conversation-option-default`,
        });
    }
    const offerConversation = (choice: WorkflowConversationSelection, title: string, suffix: string) => {
        const id = conversationOptionId(choice);
        conversationChoices.set(id, choice);
        conversationItems.push({ id, title, testID: `${testIDPrefix}-conversation-option-${suffix}` });
    };
    offerConversation({ kind: 'shared_run' }, t('workflows.conversation.sharedRun'), 'shared');
    offerConversation({ kind: 'fresh' }, t('workflows.conversation.fresh'), 'fresh');
    // A recorded origin-session continuation stays selectable as recorded; it is never silently replaced.
    if (props.conversation?.kind === 'origin_session') {
        offerConversation({ kind: 'origin_session' }, t('workflows.page.inspector.originSession'), 'origin');
    }
    for (const producer of producers) {
        offerConversation(
            { kind: 'from_step', producer: producerRef(producer) },
            t('workflows.conversation.fromStep', { block: producer.label }),
            `from-step-${producer.blockId}`,
        );
    }
    conversationItems.push({
        id: EXISTING_SESSION_OPTION_ID,
        title: recordedSession === null
            ? t('workflows.page.inspector.aSession')
            : formatWorkflowConversationLabel({ draft, conversation: recordedSession, existingSessions }),
        testID: `${testIDPrefix}-conversation-option-existing`,
        disabled: !existingSessionOffered,
        // The reason reaches the option itself, not only nearby text.
        ...(existingSessionOffered ? {} : { subtitle: existingSessions.length === 0
            ? t('workflows.conversation.noExistingSessions') : t('entityDragDrop.reasons.generic') }),
    });
    const conversationSelectedId = props.conversation === undefined
        ? (inherits ? DEFAULT_OPTION_ID : 'shared_run')
        : conversationOptionId(props.conversation);

    const workspaceChoices = new Map<string, WorkflowWorkspaceSelection>();
    const workspaceItems: DropdownMenuItem[] = [];
    if (inherits) {
        workspaceItems.push({
            id: DEFAULT_OPTION_ID,
            title: t('workflows.page.inspector.workflowDefault', {
                value: formatWorkflowWorkspaceLabel(draft, props.inherited?.workspace),
            }),
            testID: `${testIDPrefix}-workspace-option-default`,
        });
    }
    const offerWorkspace = (choice: WorkflowWorkspaceSelection, suffix: string) => {
        const id = workspaceOptionId(choice);
        workspaceChoices.set(id, choice);
        workspaceItems.push({ id, title: formatWorkflowWorkspaceLabel(draft, choice), testID: `${testIDPrefix}-workspace-option-${suffix}` });
    };
    offerWorkspace({ kind: 'inherit' }, 'inherit');
    offerWorkspace({ kind: 'project_checkout' }, 'project');
    for (const producer of producers) {
        offerWorkspace({ kind: 'from_step', producer: producerRef(producer) }, `from-step-${producer.blockId}`);
    }
    offerWorkspace({ kind: 'new_worktree', source: { kind: 'original' } }, 'worktree');
    offerWorkspace({ kind: 'new_worktree', source: { kind: 'workflow' } }, 'worktree-workflow');
    for (const producer of producers) {
        offerWorkspace({ kind: 'new_worktree', source: { kind: 'step', producer: producerRef(producer) } }, `worktree-step-${producer.blockId}`);
    }
    // A recorded choice whose producer is no longer offered stays visible as recorded.
    if (props.workspace !== undefined && !workspaceChoices.has(workspaceOptionId(props.workspace))) {
        offerWorkspace(props.workspace, 'recorded');
    }
    if (props.conversation !== undefined && props.conversation.kind === 'from_step'
        && !conversationChoices.has(conversationOptionId(props.conversation))) {
        offerConversation(props.conversation, formatWorkflowConversationLabel({ draft, conversation: props.conversation }), 'recorded');
    }
    const workspaceSelectedId = props.workspace === undefined
        ? (inherits ? DEFAULT_OPTION_ID : 'inherit')
        : workspaceOptionId(props.workspace);

    return (
        <View>
            <ContinuityField
                title={t('workflows.conversation.title')}
                items={conversationItems}
                selectedId={conversationSelectedId}
                onSelect={(id) => {
                    if (id === DEFAULT_OPTION_ID) {
                        onChangeConversation(undefined);
                        return;
                    }
                    if (id === EXISTING_SESSION_OPTION_ID) {
                        if (existingSessionOffered) { setBindingRefusal(null); setChoosingSession(true); }
                        return;
                    }
                    const choice = conversationChoices.get(id);
                    if (choice !== undefined) onChangeConversation(choice);
                }}
                testIDPrefix={`${testIDPrefix}-conversation`}
            />
            {/*
              * Continuing reaches an existing conversation with the Agent and
              * folder it already has: the runtime refuses a mismatch rather
              * than silently forking, so a different Agent or folder means a
              * separate conversation. Stated only where a continuation is
              * actually chosen.
              */}
            {conversationKind === 'from_step' || conversationKind === 'existing_session' ? (
                <Text testID={`${testIDPrefix}-conversation-continuation-note`} style={workflowEditorStyles.groupSummary}>
                    {t('workflows.conversation.continuingKeepsAgentAndFolder')}
                </Text>
            ) : null}
            {/* Joining a producer's conversation means this branch takes its
              * turn only after that block finishes; state it where a from-step
              * continuation is actually selected. */}
            {fromStepProducer === null ? null : (
                <Text testID={`${testIDPrefix}-conversation-waiting-note`} style={workflowEditorStyles.groupSummary}>
                    {t('workflows.conversation.waitingForConversation', { block: fromStepProducer.label })}
                </Text>
            )}
            {existingSessionOffered ? null : (
                <Text testID={`${testIDPrefix}-conversation-existing-unavailable`} style={workflowEditorStyles.groupSummary}>
                    {existingSessions.length === 0 ? t('workflows.conversation.noExistingSessions') : t('entityDragDrop.reasons.generic')}
                </Text>
            )}
            {choosingSession && existingSessionOffered ? (
                <SelectionList
                    testID={`${testIDPrefix}-conversation-session-picker`}
                    rootStep={existingSessionStep}
                    selectedOptionId={recordedSession?.sessionId ?? null}
                    listAccessibilityLabel={t('workflows.conversation.chooseExistingSession')}
                    onSelect={(sessionId) => selectExistingSession(sessionId)}
                    onRequestClose={() => setChoosingSession(false)}
                    autoFocusInputOnWeb
                    maxHeight={360}
                    heightBehavior="stabilizedContentHeight"
                />
            ) : null}
            {choosingSession && bindingRefusal !== null ? (
                <Text accessibilityRole="alert" style={workflowEditorStyles.groupSummary}>{bindingRefusal}</Text>
            ) : null}

            <ContinuityField
                title={t('workflows.workspace.title')}
                items={workspaceItems}
                selectedId={workspaceSelectedId}
                onSelect={(id) => {
                    if (id === DEFAULT_OPTION_ID) {
                        onChangeWorkspace(undefined);
                        return;
                    }
                    const choice = workspaceChoices.get(id);
                    if (choice !== undefined) onChangeWorkspace(choice);
                }}
                testIDPrefix={`${testIDPrefix}-workspace`}
            />
            {/* Reuse continues the exact directory, dirty state included. */}
            {workspaceKind !== 'from_step' ? null : (
                <Text testID={`${testIDPrefix}-workspace-reuse-note`} style={workflowEditorStyles.groupSummary}>
                    {t('workflows.workspace.reuseNote')}
                </Text>
            )}
            {sharesWorkspaceWithParallelSiblings ? (
                <Text testID={`${testIDPrefix}-workspace-shared-parallel-note`} style={workflowEditorStyles.groupSummary}>
                    {t('workflows.workspace.sharedParallelNote')}
                </Text>
            ) : null}
            {workspaceKind !== 'new_worktree' ? null : (
                <Text testID={`${testIDPrefix}-workspace-committed-note`} style={workflowEditorStyles.groupSummary}>
                    {t('workflows.workspace.committedOnlyNote')}
                </Text>
            )}
        </View>
    );
}
