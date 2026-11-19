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
 * Conversation continuity, authored as the canonical selection vocabulary
 * (04 §5.2, M8). It is separate from dataflow and from the Workspace, which the
 * sessions' checkout picker chooses (WF-REDESIGN-1116 change a): continuing a
 * conversation never implies reusing a workspace, and sharing a workspace never
 * implies sharing history. The workspace it is given only says when branches
 * share one folder.
 *
 * For a step (`inherited` given) the first option is "Workflow
 * default · {value}", which deletes the step's own choice so later default
 * changes reach it; every explicit option — including the one equal to today's
 * default — stays offered, because choosing it pins that value (F24).
 *
 * "A session…" opens the canonical Session picker over the host's candidates
 * (its Session candidacy and machine owners); the editor never lists Sessions
 * itself and never fabricates a Session id.
 */

const NO_EXISTING_SESSIONS: readonly WorkflowExistingSessionOption[] = [];
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
        // One name for the step's inherited Workspace, the checkout picker's own row (WF-REDESIGN-1116).
        case 'inherit': return t('workflows.workspace.sameAsWorkflow');
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
    /**
     * `item` (default): settings rows. `track`: Conversation on its card's label track, its segments
     * beside the label (How and where it runs, round 1116).
     */
    layout?: 'item' | 'track';
    testIDPrefix: string;
}>): React.ReactElement {
    const { draft, onChangeConversation, testIDPrefix } = props;
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

    if (props.conversation !== undefined && props.conversation.kind === 'from_step'
        && !conversationChoices.has(conversationOptionId(props.conversation))) {
        offerConversation(props.conversation, formatWorkflowConversationLabel({ draft, conversation: props.conversation }), 'recorded');
    }

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
            <WorkflowFieldPair label={t('workflows.conversation.title')} trackKey="conversation" labelAlign="control"
                // A step following its workflow says what Default means here (the item layout's subtitle), under the row.
                note={props.conversation === undefined && inherits ? (
                    <Text testID={`${testIDPrefix}-conversation-consequence`} style={workflowEditorStyles.actionFieldNote}>{conversationConsequence}</Text>
                ) : null}>
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
    // Branches writing one folder together is the workspace's consequence; the Workspace is chosen in the
    // checkout picker, and this note stays here, where the steps' running is decided.
    return (
        <>
            {conversation}
            {sharesWorkspaceWithParallelSiblings ? (
                <Text testID={`${testIDPrefix}-workspace-shared-parallel-note`} style={workflowEditorStyles.groupSummary}>
                    {t('workflows.workspace.sharedParallelNote')}
                </Text>
            ) : null}
        </>
    );
}
