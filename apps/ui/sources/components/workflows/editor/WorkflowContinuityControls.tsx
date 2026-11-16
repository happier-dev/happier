import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import * as React from 'react';
import { View } from 'react-native';

import type { WorkflowConversationSelection, WorkflowReferenceScope } from '@happier-dev/protocol/workflows/workflowReferenceV1';
import type { WorkflowWorkspaceSelection } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import type { EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
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
import { useSessionDisplayNameSource } from '@/sync/store/hooks';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

import { resolveWorkflowSessionChoice } from '../presentation/workflowSessionChoice';
import { workflowSessionOptionRow } from '../presentation/workflowSessionOptionRow';
import { workflowEditorStyles } from './workflowEditorStyles';
import { WorkflowFieldPair } from './WorkflowStepDataEditor';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';

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

/**
 * A continued Session's name through the Session label owner (`getSessionName` over the one
 * display-name selection), or `null` while this device cannot read that Session.
 */
export function useWorkflowContinuedSessionLabel(conversation: WorkflowConversationSelection | undefined): string | null {
    const focusedLifetime = useActiveServerAccountScopeLifetime();
    const addressedLifetime = useWorkflowAccountLifetime();
    const lifetime = addressedLifetime === undefined ? focusedLifetime : addressedLifetime;
    const current = lifetime?.isCurrent() === true;
    const sessionId = current && conversation?.kind === 'existing_session' ? conversation.sessionId : '';
    const source = useSessionDisplayNameSource(sessionId, lifetime?.scope.serverId ?? null);
    const isSessionVisible = useSessionRecordingVisibility();
    if (sessionId && !isSessionVisible({ sessionId, serverId: lifetime?.scope.serverId })) return t('workflows.conversation.savedSession');
    return !current || sessionId.length === 0 || source === null ? null : getSessionName(source);
}

/** One conversation choice in words: the same label in the field, its summary and the settings group line. */
export function formatWorkflowConversationLabel(params: Readonly<{
    draft: WorkflowEditorDraft;
    conversation: WorkflowConversationSelection | undefined;
    existingSessions?: readonly WorkflowExistingSessionOption[];
    /** The continued Session's name (`useWorkflowContinuedSessionLabel`). */
    sessionLabel?: string | null;
}>): string {
    const conversation = params.conversation ?? { kind: 'shared_run' as const };
    switch (conversation.kind) {
        case 'shared_run': return t('workflows.conversation.sharedRun');
        case 'fresh': return t('workflows.conversation.fresh');
        case 'origin_session': return t('workflows.page.inspector.originSession');
        case 'input': return t('workflows.input.workflowInput', { name: conversation.name });
        case 'from_step': return t('workflows.conversation.fromStep', { block: blockLabelOf(params.draft, conversation.producer.blockId) });
        case 'existing_session':
            return t('workflows.page.inspector.continues', {
                // A recorded Session this host cannot list (imported, or no longer
                // offered here) stays visible by its exact identity, never hidden.
                session: (params.sessionLabel !== undefined ? params.sessionLabel
                    : params.existingSessions?.find((option) => option.sessionId === conversation.sessionId)?.label)
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
    sessionLabel?: string | null;
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
    sessionOptionsStatus?: 'loading' | 'ready' | 'error';
    /** Reads the host's Session options again after a reported failure (while this control demands them). */
    onRetrySessionOptions?: () => void;
    onSessionOptionsDemandChange?: (demanded: boolean) => void;
    onChangeConversation: (value: WorkflowConversationSelection | undefined) => void;
    onBindExistingSession?: (sessionId: string) => Promise<EntityDropOutcomeV1>;
    onChangeWorkspace: (value: WorkflowWorkspaceSelection | undefined) => void;
    /**
     * `item` (default): settings rows. `track`: Conversation on its card's label track, its segments
     * beside the label (How and where it runs, round 1116).
     */
    layout?: 'item' | 'track';
    /** `conversation`: a host that chooses the Workspace elsewhere (the checkout picker) shows only Conversation. */
    parts?: 'all' | 'conversation';
    testIDPrefix: string;
}>): React.ReactElement {
    const { draft, onChangeConversation, onChangeWorkspace, testIDPrefix } = props;
    const producers = props.consumerBlockId === undefined
        ? []
        : listWorkflowProducerOptions(draft, props.consumerBlockId);
    const existingSessions = props.existingSessions ?? NO_EXISTING_SESSIONS;
    const existingSessionOffered = existingSessions.length > 0 && props.onBindExistingSession !== undefined;
    // Only a host that can bind a Session has a chooser to explain; loading and failure are never "none".
    const sessionChoice = props.onBindExistingSession === undefined ? null
        : resolveWorkflowSessionChoice(props.sessionOptionsStatus, existingSessions.length > 0);
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
    const focusedLifetime = useActiveServerAccountScopeLifetime();
    const addressedLifetime = useWorkflowAccountLifetime();
    const accountLifetime = addressedLifetime === undefined ? focusedLifetime : addressedLifetime;
    React.useEffect(() => {
        const retire = () => { setChoosingSession(false); };
        retire();
        const retirement = accountLifetime?.onRetire(retire);
        return () => retirement?.dispose();
    }, [accountLifetime]);
    // A settled read without candidates, or a failed one, retires the chooser and its demand; the
    // outcome stays said under Conversation (a failure offers the retry) instead of a silent revert.
    const [sessionNotice, setSessionNotice] = React.useState<'failed' | 'empty' | null>(null);
    // Only a read this choice started settles it: a status already reported when the person chose
    // (before the demand reached the host, or a failure whose retry is in flight) never retires it.
    const readSeenSinceChoice = React.useRef(false);
    React.useEffect(() => {
        if (!choosingSession) return;
        if (props.sessionOptionsStatus === 'loading'
            || (props.sessionOptionsStatus === 'ready' && existingSessionOffered)) {
            readSeenSinceChoice.current = true;
            return;
        }
        if (!readSeenSinceChoice.current) return;
        if (props.sessionOptionsStatus === 'error') {
            setChoosingSession(false);
            setSessionNotice('failed');
        } else if (props.sessionOptionsStatus === 'ready' && !existingSessionOffered) {
            setChoosingSession(false);
            setSessionNotice('empty');
        }
    }, [choosingSession, existingSessionOffered, props.sessionOptionsStatus]);
    const sessionOptionsDemanded = choosingSession;
    const onSessionOptionsDemandChange = props.onSessionOptionsDemandChange;
    React.useEffect(() => {
        if (!sessionOptionsDemanded || !onSessionOptionsDemandChange) return;
        onSessionOptionsDemandChange(true);
        return () => onSessionOptionsDemandChange(false);
    }, [sessionOptionsDemanded, onSessionOptionsDemandChange]);
    const [bindingRefusal, setBindingRefusal] = React.useState<string | null>(null);
    const recordedSession = props.conversation?.kind === 'existing_session' ? props.conversation : null;
    const recordedSessionLabel = useWorkflowContinuedSessionLabel(props.conversation);
    const inheritedSessionLabel = useWorkflowContinuedSessionLabel(props.inherited?.conversation);
    const existingSessionStep = React.useMemo<SelectionListStep>(() => ({
        id: `${testIDPrefix}-conversation-existing-session`,
        inputPlaceholder: t('sessionsList.searchSessionsPlaceholder'),
        sections: [{
            kind: 'static',
            id: 'sessions',
            options: existingSessions.map((option) => ({
                id: option.sessionId,
                label: option.label,
                ...workflowSessionOptionRow(option),
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

    // The targets a kind can name (which step, which worktree source), offered beneath its segment.
    const conversationChoices = new Map<string, WorkflowConversationSelection>();
    const conversationItems: DropdownMenuItem[] = [];
    const offerConversation = (choice: WorkflowConversationSelection, title: string, suffix: string) => {
        const id = conversationOptionId(choice);
        conversationChoices.set(id, choice);
        conversationItems.push({ id, title, testID: `${testIDPrefix}-conversation-option-${suffix}` });
    };
    for (const producer of producers) {
        offerConversation(
            { kind: 'from_step', producer: producerRef(producer) },
            t('workflows.conversation.fromStep', { block: producer.label }),
            `from-step-${producer.blockId}`,
        );
    }

    const workspaceChoices = new Map<string, WorkflowWorkspaceSelection>();
    const workspaceItems: DropdownMenuItem[] = [];
    const offerWorkspace = (choice: WorkflowWorkspaceSelection, suffix: string) => {
        const id = workspaceOptionId(choice);
        workspaceChoices.set(id, choice);
        workspaceItems.push({ id, title: formatWorkflowWorkspaceLabel(draft, choice), testID: `${testIDPrefix}-workspace-option-${suffix}` });
    };
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
    const workspaceSelectedId = props.workspace === undefined ? '' : workspaceOptionId(props.workspace);

    // Conversation and Workspace are visible choices (lab `editor-E1o`): one segment per kind, the
    // consequence under the label, and a field select beneath only when the chosen kind has more
    // than one target (which step, which worktree source).
    // Continuing another conversation (a step's or an existing Session) is one segment; which one is
    // chosen beneath it, so the row keeps to four short, always-visible options.
    type ConversationSegment = 'default' | 'shared_run' | 'fresh' | 'origin_session' | 'input' | 'continue';
    const continuesConversation = choosingSession || props.conversation?.kind === 'from_step'
        || props.conversation?.kind === 'existing_session';
    const conversationSegment: ConversationSegment = continuesConversation ? 'continue'
        : props.conversation === undefined ? (inherits ? 'default' : 'shared_run') : props.conversation.kind as ConversationSegment;
    const sessionOffered = sessionChoice !== null || recordedSession !== null;
    const conversationSegments: SegmentedChoiceOption<ConversationSegment>[] = [];
    if (inherits) conversationSegments.push({ id: 'default', label: t('workflows.page.inspector.choiceDefault') });
    conversationSegments.push({ id: 'shared_run', label: t('workflows.page.inspector.conversationShared') });
    conversationSegments.push({ id: 'fresh', label: t('workflows.page.inspector.conversationFresh') });
    // A recorded origin-session or input continuation stays selectable as recorded; never silently replaced.
    if (props.conversation?.kind === 'origin_session' || props.conversation?.kind === 'input') {
        conversationSegments.push({ id: props.conversation.kind,
            label: formatWorkflowConversationLabel({ draft, conversation: props.conversation }) });
    }
    if (producers.length > 0 || sessionOffered || props.conversation?.kind === 'from_step') {
        conversationSegments.push({ id: 'continue', label: t('workflows.page.inspector.conversationContinue') });
    }
    const conversationConsequence = props.conversation === undefined && inherits
        ? t('workflows.page.inspector.workflowDefault', { value: formatWorkflowConversationLabel({ draft,
            conversation: props.inherited?.conversation, existingSessions, sessionLabel: inheritedSessionLabel }) })
        : formatWorkflowConversationLabel({ draft, conversation: props.conversation, existingSessions,
            sessionLabel: recordedSessionLabel });
    const chooseSession = () => {
        readSeenSinceChoice.current = false;
        setBindingRefusal(null);
        setSessionNotice(null);
        setChoosingSession(true);
    };
    const selectConversationSegment = (segment: ConversationSegment) => {
        if (segment !== 'continue') { setChoosingSession(false); setSessionNotice(null); }
        if (segment === 'default') { onChangeConversation(undefined); return; }
        if (segment === 'continue') {
            if (continuesConversation) return;
            const producer = producers[0];
            if (producer !== undefined) onChangeConversation({ kind: 'from_step', producer: producerRef(producer) });
            else if (sessionOffered) chooseSession();
            return;
        }
        if (segment === props.conversation?.kind) return;
        if (segment === 'shared_run' || segment === 'fresh') onChangeConversation({ kind: segment });
    };
    // What "Continue" continues: a step's conversation, or an existing Session through its picker.
    const continueItems: DropdownMenuItem[] = [...conversationItems];
    if (recordedSession !== null) {
        continueItems.push({ id: EXISTING_SESSION_OPTION_ID, title: formatWorkflowConversationLabel({ draft,
            conversation: recordedSession, existingSessions, sessionLabel: recordedSessionLabel }),
            testID: `${testIDPrefix}-conversation-option-existing` });
    } else if (sessionChoice !== null) {
        continueItems.push({ id: EXISTING_SESSION_OPTION_ID, title: t('workflows.page.inspector.aSession'),
            testID: `${testIDPrefix}-conversation-option-existing` });
    }
    const continueSelectedId = choosingSession || props.conversation?.kind === 'existing_session' ? EXISTING_SESSION_OPTION_ID
        : props.conversation === undefined ? '' : conversationOptionId(props.conversation);

    // A step's Default segment covers both ways of using the workflow's workspace: following the workflow
    // default (the step records nothing) and the explicit Workflow workspace (F24: every supported choice
    // stays reachable), chosen in the field beneath it. Workflow settings have no Default, so the explicit
    // choice is its own segment there.
    type WorkspaceSegment = WorkflowWorkspaceSelection['kind'] | typeof DEFAULT_OPTION_ID;
    const workspaceSegment: WorkspaceSegment = inherits && (props.workspace === undefined || props.workspace.kind === 'inherit')
        ? DEFAULT_OPTION_ID : props.workspace?.kind ?? 'inherit';
    const workspaceSegments: SegmentedChoiceOption<WorkspaceSegment>[] = [];
    if (inherits) workspaceSegments.push({ id: DEFAULT_OPTION_ID, label: t('workflows.page.inspector.choiceDefault') });
    else workspaceSegments.push({ id: 'inherit', label: t('workflows.page.inspector.workspaceWorkflow') });
    workspaceSegments.push({ id: 'project_checkout', label: t('workflows.page.inspector.workspaceProject') });
    workspaceSegments.push({ id: 'new_worktree', label: t('workflows.page.inspector.workspaceNewWorktree') });
    if (producers.length > 0 || props.workspace?.kind === 'from_step') {
        workspaceSegments.push({ id: 'from_step', label: t('workflows.page.inspector.conversationContinue') });
    }
    const workspaceConsequence = props.workspace === undefined && inherits
        ? t('workflows.page.inspector.workflowDefault', { value: formatWorkflowWorkspaceLabel(draft, props.inherited?.workspace) })
        : formatWorkflowWorkspaceLabel(draft, props.workspace);
    const selectWorkspaceSegment = (segment: WorkspaceSegment) => {
        if (segment === DEFAULT_OPTION_ID) {
            // Reselecting Default keeps a recorded Workflow workspace; the field beneath changes it.
            if (props.workspace?.kind !== 'inherit') onChangeWorkspace(undefined);
            return;
        }
        if (segment === props.workspace?.kind) return;
        if (segment === 'from_step') {
            const producer = producers[0];
            if (producer !== undefined) onChangeWorkspace({ kind: 'from_step', producer: producerRef(producer) });
            return;
        }
        if (segment === 'new_worktree') { onChangeWorkspace({ kind: 'new_worktree', source: { kind: 'original' } }); return; }
        onChangeWorkspace({ kind: segment });
    };
    const followItems: DropdownMenuItem[] = [
        // Inherit by default (a later change to the workflow's workspace carries here) or pin it explicitly.
        { id: DEFAULT_OPTION_ID, title: t('workflows.page.inspector.workspaceFollowsChanges'), testID: `${testIDPrefix}-workspace-follows-default` },
        { id: 'inherit', title: t('workflows.page.inspector.workspaceFollowsPinned'), testID: `${testIDPrefix}-workspace-follows-workflow` },
    ];
    const workspaceVariantItems = workspaceItems.filter((item) => workspaceSegment === 'from_step'
        ? item.id.startsWith('from_step:') : workspaceSegment === 'new_worktree' && item.id.startsWith('new_worktree:'));
    const sessionStatusLine = choosingSession
        ? (existingSessionOffered ? null : props.sessionOptionsStatus === 'ready' || props.sessionOptionsStatus === undefined
            ? t('workflows.conversation.noExistingSessions') : t('workflows.conversation.sessionsLoading'))
        : sessionNotice === 'failed' ? t('workflows.conversation.sessionsFailedRetry')
        : sessionNotice === 'empty' ? t('workflows.conversation.noExistingSessions') : null;

    const conversationDetails = (
        <>
            {conversationSegment === 'continue' && (continueItems.length > 1 || continueItems[0]?.id === EXISTING_SESSION_OPTION_ID) ? (
                <ContinuityField
                    title={t('workflows.page.inspector.continueFrom')}
                    items={continueItems}
                    selectedId={continueSelectedId}
                    onSelect={(id) => {
                        if (id === EXISTING_SESSION_OPTION_ID) { chooseSession(); return; }
                        setChoosingSession(false);
                        const choice = conversationChoices.get(id);
                        if (choice !== undefined) onChangeConversation(choice);
                    }}
                    testIDPrefix={`${testIDPrefix}-conversation-continue`}
                />
            ) : null}
            {sessionStatusLine === null ? null : (
                <Text testID={`${testIDPrefix}-conversation-session-status`}
                    {...(sessionNotice === 'failed' && !choosingSession ? {
                        accessibilityRole: 'button' as const,
                        onPress: () => { props.onRetrySessionOptions?.(); chooseSession(); },
                    } : {})}
                    style={workflowEditorStyles.groupSummary}>
                    {sessionStatusLine}
                </Text>
            )}
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
        </>
    );
    const conversation = props.layout === 'track' ? (
        <View style={workflowEditorStyles.actionFieldRow}>
            <WorkflowFieldPair label={t('workflows.conversation.title')} trackKey="conversation">
                <SegmentedTabBar<ConversationSegment>
                    tabs={conversationSegments}
                    activeTabId={conversationSegment}
                    onSelectTab={selectConversationSegment}
                    segmentSizing="content"
                    accessibilityLabel={t('workflows.conversation.title')}
                    role="radiogroup"
                    testIDPrefix={`${testIDPrefix}-conversation`}
                />
                {conversationDetails}
            </WorkflowFieldPair>
        </View>
    ) : (
        <>
            <SegmentedChoiceItem<ConversationSegment>
                testIDPrefix={`${testIDPrefix}-conversation`}
                title={t('workflows.conversation.title')}
                subtitle={conversationConsequence}
                options={conversationSegments}
                value={conversationSegment}
                valueSource={conversationSegment === 'default' ? 'inherited' : 'set'}
                onChange={selectConversationSegment}
                accessoryLayout="stacked"
                showDivider={false}
            />
            {conversationDetails}
        </>
    );
    // Branches writing one folder together is the workspace's consequence; a host choosing the Workspace
    // elsewhere still hears it here, where the steps' running is decided.
    if (props.parts === 'conversation') return (
        <>
            {conversation}
            {sharesWorkspaceWithParallelSiblings ? (
                <Text testID={`${testIDPrefix}-workspace-shared-parallel-note`} style={workflowEditorStyles.groupSummary}>
                    {t('workflows.workspace.sharedParallelNote')}
                </Text>
            ) : null}
        </>
    );

    return (
        <View>
            {conversation}
            <SegmentedChoiceItem<WorkspaceSegment>
                testIDPrefix={`${testIDPrefix}-workspace`}
                title={t('workflows.workspace.title')}
                subtitle={workspaceConsequence}
                options={workspaceSegments}
                value={workspaceSegment}
                valueSource={workspaceSegment === DEFAULT_OPTION_ID && props.workspace === undefined ? 'inherited' : 'set'}
                onChange={selectWorkspaceSegment}
                accessoryLayout="stacked"
                showDivider={false}
            />
            {workspaceSegment === DEFAULT_OPTION_ID ? (
                <ContinuityField
                    title={t('workflows.page.inspector.workspaceFollows')}
                    items={followItems}
                    selectedId={props.workspace === undefined ? DEFAULT_OPTION_ID : 'inherit'}
                    onSelect={(id) => onChangeWorkspace(id === 'inherit' ? { kind: 'inherit' } : undefined)}
                    testIDPrefix={`${testIDPrefix}-workspace-follows`}
                />
            ) : null}
            {workspaceVariantItems.length > 1 ? (
                <ContinuityField
                    title={workspaceSegment === 'new_worktree' ? t('workflows.page.inspector.worktreeSource') : t('workflows.page.inspector.continueFrom')}
                    items={workspaceVariantItems}
                    selectedId={workspaceSelectedId}
                    onSelect={(id) => {
                        const choice = workspaceChoices.get(id);
                        if (choice !== undefined) onChangeWorkspace(choice);
                    }}
                    testIDPrefix={`${testIDPrefix}-workspace-variant`}
                />
            ) : null}
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
