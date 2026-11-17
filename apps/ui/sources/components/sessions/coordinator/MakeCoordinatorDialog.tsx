import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionCoordinatorEnableResultV1Schema } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorActionsV1';
import type { SessionCoordinatorRuleCensusV1 } from '@happier-dev/protocol/sessions/follow/sessionCoordinatorSetupV1';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { describeSessionRoleRefusal } from '@/components/roles/session/sessionRole';
import { useRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { useRoleMark } from '@/components/roles/catalog/useRoleMark';
import { CoordinatorKeepListPreview, CoordinatorKeepRailPreview } from '@/components/settings/coordination/CoordinatorKeepPreviews';
import { useSessionMachineName } from '@/components/sessions/agents/presentation/useSessionMachineName';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';
import { useInboxSessionHandoff } from '@/hooks/inbox/useInboxSessionHandoff';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { Text } from '@/components/ui/text/Text';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { randomUUID } from '@/platform/randomUUID';
import { describeFollowRuleMatchCount, useFollowRuleMatchCounts, type FollowRuleMatchCount } from '@/components/sessions/follow/followRuleMatchCounts';
import { leaveProjectToFollowRule, undoFollowRuleProjectEdit } from '@/sync/api/session/sessionFollowRuleEdits';
import { useSessionFollowRules, type SessionFollowRulesController } from '@/components/sessions/follow/useSessionFollowRules';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSession, useSessionDisplayNameProjections, useSetting } from '@/sync/domains/state/storage';
import { readProjectAccountWorkspaceRefs, useProjectAccountRows, type ProjectAccountRowsSnapshot } from '@/sync/domains/workspaces/projectAccountRows';
import { sessionCoordinatorActions } from '@/sync/ops/sessions/sessionCoordinatorActions';
import { t } from '@/text';
import { inferProjectTitleFromPath } from '@/utils/path/browseSegments';
import { getSessionName, useSessionStatus } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { MakeCoordinatorRoleHeld } from './MakeCoordinatorRoleHeld';

import {
    applyMakeCoordinatorEffectsToDraft,
    buildMakeCoordinatorDraft,
    buildMakeCoordinatorEnableInput,
    describeMakeCoordinatorOverlap,
    readMakeCoordinatorOutcome,
    reconcileMakeCoordinatorProjectDraft,
    toggleMakeCoordinatorRule,
    type MakeCoordinatorDraft,
    type MakeCoordinatorKeep,
} from './makeCoordinatorModel';

type MakeCoordinatorDialogProps = CustomModalInjectedProps & Readonly<{ sessionId: string; serverId: string }>;
type RuleScope = 'project' | 'home';
type RuleCount = FollowRuleMatchCount;
type Census = SessionCoordinatorRuleCensusV1 | null | 'loading';

const KEEP_VALUES = ['rail_bot', 'list_pin', 'none'] as const satisfies readonly MakeCoordinatorKeep[];
const KEEP_TITLES = {
    rail_bot: 'settingsCoordination.keepRail',
    list_pin: 'settingsCoordination.keepList',
    none: 'settingsCoordination.keepNone',
} as const satisfies Record<MakeCoordinatorKeep, string>;
const KEEP_CAPTIONS = {
    rail_bot: 'sessionCoordinator.make.keepRailCaption',
    list_pin: 'sessionCoordinator.make.keepListCaption',
    none: 'sessionCoordinator.make.keepNoneCaption',
} as const satisfies Record<MakeCoordinatorKeep, string>;
const MANAGED_BY_NONE = '__none__';

/**
 * The notice a finished Make coordinator leaves (also drawn by `/dev/work-sections?scene=states`). Coordinator is
 * derived from the Follow relation (Z1): with no rule on, the session is only set up until it manages a session.
 */
export function publishMakeCoordinatorNotice(input: Readonly<{ serverId: string; sessionId: string; name: string; ruleOn: boolean }>) {
    publishPresentationNotice({
        key: `session-coordinator:${input.serverId}:${input.sessionId}`,
        severity: 'info',
        message: input.ruleOn
            ? t('sessionCoordinator.make.done', { name: input.name })
            : t('sessionCoordinator.make.doneNoRule', { name: input.name }),
        emphasis: input.name,
    });
}

/**
 * "Make coordinator…" (C1 §6, lab P3 M/M1/M2/MA): one dialog that shows what will happen and asks only what it
 * can't answer for you. Role, Managed by, where to keep it and what it hears about start from Settings →
 * Coordination; Protocol prepares the suggestions and the one `session.coordinator.enable` Action applies the
 * ordinary pieces (role, Bot/pin, manager, rule follows) and reports each one.
 */
export function MakeCoordinatorDialog(props: MakeCoordinatorDialogProps) {
    const { sessionId, serverId, onClose } = props;
    const session = useSession(sessionId, serverId);
    const settings = {
        coordinationCoordinatorRoleId: useSetting('coordinationCoordinatorRoleId'),
        coordinationCoordinatorKeep: useSetting('coordinationCoordinatorKeep'),
        coordinationCoordinatorAnswersWorkerQuestions: useSetting('coordinationCoordinatorAnswersWorkerQuestions'),
        coordinationCoordinatorSuggestProjectRule: useSetting('coordinationCoordinatorSuggestProjectRule'),
        coordinationCoordinatorSuggestHomeRule: useSetting('coordinationCoordinatorSuggestHomeRule'),
    };
    const ownerMetadata = session ? readSessionOwnerMetadataView(session) : null;
    const projectCensus = useProjectAccountRows(useShallow((rows: ProjectAccountRowsSnapshot | null) => ({
        scope: rows?.scope, refs: readProjectAccountWorkspaceRefs({ projectAccountRows: rows }),
    })));
    const workspaceRefs = projectCensus.refs;
    const ruleIds = React.useRef({ project: randomUUID(), home: randomUUID() }).current;
    const initialSettings = React.useRef(settings).current;
    const preparedDraft = React.useMemo(() => buildMakeCoordinatorDraft({ serverId, sessionId, ownerMetadata, projectKey: session?.projectKey,
        workspaceRefsScope: projectCensus.scope,
        sessionAuthority: { ownerAccountId: session?.ownerAccountId, access: session?.access, accessLevel: session?.accessLevel },
        workspaceRefs, settings: initialSettings, ruleIds, ruleCensus: null }),
    [serverId, sessionId, ownerMetadata, session?.projectKey, session?.ownerAccountId, session?.access, session?.accessLevel,
        projectCensus.scope, workspaceRefs, initialSettings, ruleIds]);
    const [capturedDraft, setDraft] = React.useState<MakeCoordinatorDraft>(preparedDraft);
    const rulesChosen = React.useRef(false);
    const draft = reconcileMakeCoordinatorProjectDraft(capturedDraft, preparedDraft, rulesChosen.current);
    const project = draft.project;
    // A name only from a readable path; never an id or a hash in its place.
    const projectName = project && typeof ownerMetadata?.path === 'string' && ownerMetadata.path.trim()
        ? inferProjectTitleFromPath(ownerMetadata.path) : null;
    const projectLabel = projectName ?? t('sessionCoordinator.make.thisProject');
    const currentManagerSessionId = readSessionManagerSessionIdV1(session);
    const name = session ? getSessionName(session, serverId) : '';

    // Capture setup choices for this open. Late Project hydration can supply the
    // initial suggestion; a refresh cannot broaden a chosen Project into Home.
    React.useEffect(() => {
        setDraft(current => reconcileMakeCoordinatorProjectDraft(current, preparedDraft, rulesChosen.current));
    }, [preparedDraft]);
    const ruleInputs = useSessionFollowRules(serverId, true);
    const census: Census = ruleInputs.snapshot === null ? (ruleInputs.loading ? 'loading' : null)
        : ruleInputs.snapshot.status === 'ready' ? { serverId, coverage: 'complete', rules: ruleInputs.snapshot.rules } : null;
    const managedByChosen = React.useRef(false);
    React.useEffect(() => {
        if (!ruleInputs.snapshot || managedByChosen.current) return;
        const next = ruleInputs.snapshot.status === 'ready'
            ? { serverId, coverage: 'complete' as const, rules: ruleInputs.snapshot.rules } : null;
        const suggested = buildMakeCoordinatorDraft({ serverId, sessionId, ownerMetadata, projectKey: session?.projectKey,
            workspaceRefsScope: projectCensus.scope,
            sessionAuthority: { ownerAccountId: session?.ownerAccountId, access: session?.access, accessLevel: session?.accessLevel },
            workspaceRefs, settings, ruleIds, ruleCensus: next }).managedBySessionId;
        setDraft(current => current.managedBySessionId === suggested ? current : { ...current, managedBySessionId: suggested });
        // Setup choices were captured for this open; only its authoritative rule input changes this suggestion.
    }, [ruleInputs.snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

    const counts = useRulePreviews(serverId, sessionId, draft.rules, ruleInputs);
    const [submitting, setSubmitting] = React.useState(false);
    const [footnote, setFootnote] = React.useState<string | null>(null);
    // The Role step was held back: the committed steps and the draft stay, Retry is the primary action.
    const [roleHeld, setRoleHeld] = React.useState<RoleHeld | null>(null);

    const submit = async () => {
        setSubmitting(true);
        setFootnote(null);
        const result = await sessionCoordinatorActions.enable(sessionId, buildMakeCoordinatorEnableInput(draft, { currentManagerSessionId }), { serverId });
        setSubmitting(false);
        if (!result.ok) { setFootnote(t('sessionCoordinator.make.failed')); return; }
        if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) {
            setFootnote(t('sessionCoordinator.make.waitingApproval'));
            return;
        }
        const parsed = SessionCoordinatorEnableResultV1Schema.safeParse(result.result);
        if (!parsed.success) { setFootnote(t('sessionCoordinator.make.failed')); return; }
        setDraft(current => applyMakeCoordinatorEffectsToDraft(current, parsed.data.effects));
        // A partial result keeps the dialog open: what didn't land is said, and Make coordinator again finishes it.
        const outcome = readMakeCoordinatorOutcome(parsed.data.effects);
        const refusal = outcome.roleRefusalCode
            ? describeSessionRoleRefusal({ ok: false, errorCode: outcome.roleRefusalCode })
            : null;
        setRoleHeld(refusal && outcome.roleRefusalCode ? { ...refusal, endingTurnClearsIt: outcome.roleRefusalCode === 'role_policy_restart_required' } : null);
        if (!outcome.done) {
            setFootnote(outcome.approvalPending
                ? t('sessionCoordinator.make.partialApproval')
                : outcome.otherUnfinished > 0
                    ? t('sessionCoordinator.make.partial', { count: outcome.otherUnfinished })
                    : t('sessionCoordinator.make.roleHeldNote'));
            return;
        }
        publishMakeCoordinatorNotice({ serverId, sessionId, name, ruleOn: draft.rules.some((rule) => rule.enabled) });
        onClose();
    };
    const submitRef = React.useRef(submit);
    submitRef.current = submit;

    const noRules = draft.rules.every((rule) => !rule.enabled);
    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('sessionCoordinator.make.title'),
        subtitle: project ? t('sessionCoordinator.make.subtitleProject', { project: projectLabel }) : t('sessionCoordinator.make.subtitle'),
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default },
        phonePresentation: 'sheet' as const,
        scrollHost: 'bounded' as const,
        testID: 'make-coordinator-dialog',
        footer: (
            <View style={styles.footer}>
                <SectionButtonRow
                    footnote={footnote ?? (noRules ? t('sessionCoordinator.make.noRulesHint') : null)}
                    footnoteTone={footnote && !roleHeld ? 'danger' : 'secondary'}
                    trailing={<RoundButton
                        testID="make-coordinator-submit"
                        size="small"
                        title={roleHeld ? t('common.retry') : t('sessionCoordinator.make.submit')}
                        disabled={submitting}
                        loading={submitting}
                        onPress={() => { void submitRef.current(); }}
                    />}
                >
                    <RoundButton testID="make-coordinator-cancel" size="small" display="inverted" title={t('common.cancel')} onPress={onClose} />
                </SectionButtonRow>
            </View>
        ),
    }), [footnote, noRules, onClose, project, projectLabel, roleHeld, submitting]));

    const ruleTitle = (scope: RuleScope) => scope === 'project'
        ? t('sessionCoordinator.make.ruleProject', { project: projectLabel })
        : t('sessionCoordinator.make.ruleHome');
    return (
        <ItemList presentation="grouped" style={styles.list} keyboardShouldPersistTaps="handled" testID="make-coordinator">
            {roleHeld ? <RoleHeldNotice sessionId={sessionId} serverId={serverId} held={roleHeld} /> : null}
            <ItemGroup>
                <RoleField roleId={draft.roleId} onChange={(roleId) => setDraft({ ...draft, roleId })} />
                <ManagedByField
                    sessionId={sessionId}
                    serverId={serverId}
                    census={census}
                    value={draft.managedBySessionId}
                    onChange={(managedBySessionId) => { managedByChosen.current = true; setDraft({ ...draft, managedBySessionId }); }}
                />
            </ItemGroup>
            <KeepSection draft={draft} onChange={(keep) => setDraft({ ...draft, keep, keepFromSetting: false })} />
            <ItemGroup title={t('sessionCoordinator.make.hearsAbout')}>
                {draft.rules.map((rule) => (
                    <Item
                        key={rule.scope}
                        testID={`make-coordinator-rule-${rule.scope}`}
                        title={ruleTitle(rule.scope)}
                        subtitle={describeRuleCount(counts[rule.scope])}
                        subtitleLines={0}
                        showChevron={false}
                        rightElement={<Switch
                            accessibilityLabel={ruleTitle(rule.scope)}
                            value={rule.enabled}
                            onValueChange={(enabled) => { rulesChosen.current = true; setDraft(toggleMakeCoordinatorRule(draft, rule.scope, enabled)); }}
                        />}
                    />
                ))}
                <Item
                    testID="make-coordinator-answers-questions"
                    title={t('settingsCoordination.answersWorkerQuestions')}
                    subtitle={t('settingsCoordination.answersWorkerQuestionsDescription')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={<Switch
                        accessibilityLabel={t('settingsCoordination.answersWorkerQuestions')}
                        value={draft.answersWorkerQuestions}
                        onValueChange={(answersWorkerQuestions) => setDraft({ ...draft, answersWorkerQuestions })}
                    />}
                />
            </ItemGroup>
            {project && census !== 'loading' && census && draft.rules.some((rule) => rule.scope === 'project' && rule.enabled) ? (
                <OverlapNote
                    sessionId={sessionId}
                    serverId={serverId}
                    project={project}
                    projectLabel={projectLabel}
                    census={census}
                    preview={counts.project}
                    onEdited={() => { void ruleInputs.refresh(); }}
                />
            ) : null}
            <MachineNote sessionId={sessionId} serverId={serverId} />
        </ItemList>
    );
}

type RoleHeld = Readonly<{ title: string; message: string; endingTurnClearsIt: boolean }>;

/** The turn is read live, so the stop control goes away on its own when the turn ends. */
function RoleHeldNotice(props: Readonly<{ sessionId: string; serverId: string; held: RoleHeld }>) {
    const session = useSession(props.sessionId, props.serverId);
    const status = useSessionStatus(session ?? null, { subscribeToTranscript: false });
    const turnRunning = status?.state === 'thinking' || status?.state === 'permission_required' || status?.state === 'action_required';
    const [stopping, setStopping] = React.useState(false);
    const stopTurn = () => {
        setStopping(true);
        fireAndForget((async () => {
            try {
                requireActionSuccess(await createFrontDoorActionExecute()('session.turn.cancel', { sessionId: props.sessionId },
                    { surface: 'ui', defaultSessionId: props.sessionId, serverId: props.serverId }));
            } catch {
                publishPresentationNotice({ key: `session-coordinator-stop:${props.sessionId}`, severity: 'error', message: t('errors.operationFailed') });
            } finally {
                setStopping(false);
            }
        })(), { tag: 'MakeCoordinatorDialog.stopTurn' });
    };
    return <MakeCoordinatorRoleHeld title={props.held.title} message={props.held.message} turnRunning={turnRunning}
        onStopTurn={props.held.endingTurnClearsIt ? stopTurn : null} stopping={stopping} />;
}

function describeRuleCount(count: RuleCount | undefined): string {
    return describeFollowRuleMatchCount(count, t('session.follow.policy.important'));
}

/** Toggling a suggestion does not change its filter; live counts share this dialog's private input. */
function useRulePreviews(serverId: string, sessionId: string, rules: MakeCoordinatorDraft['rules'], acquired: SessionFollowRulesController) {
    const previews = React.useMemo(() => rules.map((rule) => ({ key: rule.scope, filter: rule.suggestion.ruleDefinition.filter })), [rules]);
    return useFollowRuleMatchCounts(serverId, sessionId, previews, acquired) as Partial<Record<RuleScope, RuleCount>>;
}

/** The same Role catalog and marks every role picker reads. */
function RoleField(props: Readonly<{ roleId: string; onChange: (roleId: string) => void }>) {
    const [open, setOpen] = React.useState(false);
    const catalog = useRoleCatalog();
    const mark = useRoleMark();
    const choices = catalog.entries.filter((entry) => entry.role.enabled || entry.roleId === props.roleId);
    const selected = choices.find((entry) => entry.roleId === props.roleId);
    const items: DropdownMenuItem[] = choices.map((entry) => ({ id: entry.roleId, title: entry.role.name, icon: mark(entry.role, 20, entry.roleId) }));
    return (
        <DropdownMenu
            testID="make-coordinator-role"
            open={open}
            onOpenChange={setOpen}
            variant="selectable"
            search={false}
            selectedId={selected ? props.roleId : null}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            itemTrigger={{
                title: t('sessionCoordinator.make.role'),
                subtitle: t('sessionCoordinator.make.roleDescription'),
                showSelectedSubtitle: false,
                detailFormatter: () => selected?.role.name ?? (catalog.status === 'ready' ? t('common.unavailable') : t('common.loading')),
                field: selected ? { leading: mark(selected.role, 16, selected.roleId) } : undefined,
                itemProps: { subtitleLines: 0 },
            }}
            items={items}
            onSelect={(id) => { props.onChange(id); setOpen(false); }}
        />
    );
}

/** Other sessions that follow by a rule in this Home: the ones that can sensibly hear this one's summaries. */
function ManagedByField(props: Readonly<{
    sessionId: string;
    serverId: string;
    census: Census;
    value: string | null;
    onChange: (sessionId: string | null) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const isSessionVisible = useSessionRecordingVisibility();
    const loading = props.census === 'loading';
    const rules = props.census === 'loading' ? null : props.census?.rules;
    const candidateIds = React.useMemo(() => {
        const ids = new Set<string>();
        for (const rule of rules ?? []) {
            if (rule.receiver.kind === 'session' && rule.receiver.sessionId !== props.sessionId && rule.definition.enabled
                && isSessionVisible({ sessionId: rule.receiver.sessionId, serverId: props.serverId })) ids.add(rule.receiver.sessionId);
        }
        if (props.value) ids.add(props.value);
        return [...ids];
    }, [props.sessionId, props.serverId, props.value, rules, isSessionVisible]);
    const addresses = React.useMemo(() => candidateIds.map((sessionId) => ({ sessionId, serverId: props.serverId })), [candidateIds, props.serverId]);
    const names = useSessionDisplayNameProjections(addresses, (source) => (source ? getSessionName(source, props.serverId) : null));
    const nameOf = (id: string) => (isSessionVisible({ sessionId: id, serverId: props.serverId })
        ? names[candidateIds.indexOf(id)] : null) ?? t('sessionCoordinator.make.unknownSession');
    const items: DropdownMenuItem[] = [
        { id: MANAGED_BY_NONE, title: t('sessionCoordinator.make.managedByNone') },
        ...candidateIds.map((id) => ({ id, title: nameOf(id) })),
    ];
    const subtitle = props.value ? t('sessionCoordinator.make.managedByDescription')
        : candidateIds.length > 1 ? t('sessionCoordinator.make.managedByChoose') : t('sessionCoordinator.make.managedByNoneDescription');
    return (
        <DropdownMenu
            testID="make-coordinator-managed-by"
            open={open}
            onOpenChange={setOpen}
            variant="selectable"
            search={false}
            selectedId={props.value ?? MANAGED_BY_NONE}
            showCategoryTitles={false}
            matchTriggerWidth={true}
            connectToTrigger={true}
            rowKind="item"
            itemTrigger={{
                title: t('sessionCoordinator.make.managedBy'),
                subtitle,
                showSelectedSubtitle: false,
                detailFormatter: () => loading ? t('common.loading')
                    : props.value ? nameOf(props.value) : t('sessionCoordinator.make.managedByNone'),
                itemProps: { subtitleLines: 0 },
            }}
            items={items}
            onSelect={(id) => { props.onChange(id === MANAGED_BY_NONE ? null : id); setOpen(false); }}
        />
    );
}

/** Settings → Coordination's Where-to-keep anatomy: one stacked row, the real-surface tiles, the choice in words. */
function KeepSection(props: Readonly<{ draft: MakeCoordinatorDraft; onChange: (keep: MakeCoordinatorKeep) => void }>) {
    const caption = t(KEEP_CAPTIONS[props.draft.keep]);
    return (
        <ItemGroup>
            <Item
                testID="make-coordinator-keep"
                title={t('sessionCoordinator.make.keepTitle')}
                subtitle={props.draft.keepFromSetting ? `${caption} · ${t('sessionCoordinator.make.fromSetting')}` : caption}
                subtitleLines={0}
                accessoryLayout="stacked"
                showChevron={false}
                rightElement={<SelectionTiles
                    variant="visual"
                    accessibilityLabel={t('sessionCoordinator.make.keepTitle')}
                    testIdPrefix="make-coordinator-keep"
                    value={props.draft.keep}
                    onChange={(next) => { if (next) props.onChange(next); }}
                    options={KEEP_VALUES.map((value) => ({
                        id: value,
                        title: t(KEEP_TITLES[value]),
                        preview: value === 'rail_bot' ? <CoordinatorKeepRailPreview /> : <CoordinatorKeepListPreview pinned={value === 'list_pin'} />,
                    }))}
                />}
            />
        </ItemGroup>
    );
}

/**
 * "3 of these are also followed by Daily coordinator" (lab P3 M, MA). Leave them to this one edits that other
 * rule through the shared rule-edit owner (adds "not in project …") and its receipt carries a version-bound Undo.
 */
function OverlapNote(props: Readonly<{
    sessionId: string;
    serverId: string;
    project: QualifiedProjectKeyV1;
    projectLabel: string;
    census: SessionCoordinatorRuleCensusV1;
    preview: RuleCount | undefined;
    onEdited: (census: SessionCoordinatorRuleCensusV1) => void;
}>) {
    const { theme } = useUnistyles();
    const isSessionVisible = useSessionRecordingVisibility();
    const first = props.preview?.status === 'ready'
        ? describeMakeCoordinatorOverlap({ sessionId: props.sessionId, census: props.census, overlaps: props.preview.preview.overlaps })[0]
        : undefined;
    const receiverSessionId = first?.receiverSessionId;
    const addresses = React.useMemo(() => (receiverSessionId ? [{ sessionId: receiverSessionId, serverId: props.serverId }] : []), [props.serverId, receiverSessionId]);
    const [otherName] = useSessionDisplayNameProjections(addresses, (source) => (source ? getSessionName(source, props.serverId) : null));
    const [pending, setPending] = React.useState(false);
    if (!first) return null;
    const other = (receiverSessionId && isSessionVisible({ sessionId: receiverSessionId, serverId: props.serverId })
        ? otherName : null) ?? t('sessionCoordinator.make.unknownSession');
    const { census, onEdited } = props;
    const replaceRule = (rule: SessionCoordinatorRuleCensusV1['rules'][number]) =>
        onEdited({ ...census, rules: census.rules.map((candidate) => (candidate.ruleId === rule.ruleId ? rule : candidate)) });
    const leave = async () => {
        const key = `coordinator-overlap:${first.rule.ruleId}`;
        setPending(true);
        const result = await leaveProjectToFollowRule({ serverId: props.serverId, rule: first.rule, project: props.project });
        setPending(false);
        if (result.kind !== 'ok') {
            publishPresentationNotice({ key, severity: 'error', message: t('sessionCoordinator.make.leaveFailed') });
            return;
        }
        replaceRule(result.value.rule);
        const noticeName = (readSessionRecordingVisibility()({ sessionId: first.receiverSessionId, serverId: props.serverId })
            ? otherName : null) ?? t('sessionCoordinator.make.unknownSession');
        publishPresentationNotice({
            key,
            severity: 'info',
            message: t('sessionCoordinator.make.leftNotice', { name: noticeName, project: props.projectLabel }),
            emphasis: noticeName,
            undo: {
                label: t('bots.undo'),
                run: () => {
                    retirePresentationNotice(key);
                    fireAndForget((async () => {
                        const undone = await undoFollowRuleProjectEdit(result.value.undo);
                        if (undone.kind === 'ok') replaceRule(undone.value);
                        else publishPresentationNotice({ key, severity: 'error', message: t('sessionCoordinator.make.undoFailed') });
                    })(), { tag: 'MakeCoordinatorDialog.undoOverlap' });
                },
            },
        });
    };
    return (
        <ItemGroup>
            <Item
                testID="make-coordinator-overlap"
                icon={<Icon name="tree-structure" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                title={t('sessionCoordinator.make.overlap', { count: first.count, name: other })}
                titleLines={0}
                subtitle={t('sessionCoordinator.make.overlapBoth')}
                subtitleLines={0}
                mode="info"
                showChevron={false}
            />
            <Item
                testID="make-coordinator-overlap-leave"
                title={t('sessionCoordinator.make.leaveToThis')}
                subtitle={t('sessionCoordinator.make.leaveToThisDescription', { name: other, project: props.projectLabel })}
                subtitleLines={0}
                loading={pending}
                onPress={() => { void leave(); }}
                showChevron={false}
            />
        </ItemGroup>
    );
}

/** The session's machine as it is now; reachable now is never promised as always on. */
function MachineNote(props: Readonly<{ sessionId: string; serverId: string }>) {
    const { theme } = useUnistyles();
    const machineName = useSessionMachineName(props.sessionId, props.serverId);
    const { machineReachability } = useSessionMachineReachability(props.sessionId, props.serverId);
    // Move goes through the one Session handoff owner, offered only when a move can succeed now.
    const handoff = useInboxSessionHandoff(useSession(props.sessionId, props.serverId) ?? null);
    if (!machineName) return null;
    const reachable = machineReachability === 'reachable';
    const unreachable = machineReachability === 'unreachable';
    return (
        <ItemGroup>
            <Item
                testID="make-coordinator-machine"
                icon={<Icon name="desktop" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                title={reachable ? t('sessionCoordinator.make.machineOnline', { machine: machineName })
                    : unreachable ? t('sessionCoordinator.make.machineOffline', { machine: machineName }) : machineName}
                titleLines={0}
                subtitle={reachable ? t('sessionCoordinator.make.machineOnlineDescription')
                    : unreachable ? t('sessionCoordinator.make.machineOfflineDescription') : t('common.unavailable')}
                subtitleLines={0}
                mode="info"
                showChevron={false}
                rightElement={handoff.availability.available ? (
                    <RoundButton testID="make-coordinator-move" size="small" display="secondary"
                        title={t('sessionCoordinator.make.moveMachine')} onPress={() => { void handoff.run(); }} />
                ) : undefined}
            />
        </ItemGroup>
    );
}

export function showMakeCoordinatorDialog(params: Readonly<{ sessionId: string; serverId: string }>): void {
    Modal.show({ component: MakeCoordinatorDialog, props: params });
}

const styles = StyleSheet.create(() => ({
    list: { paddingTop: 0 },
    footer: { width: '100%' },
}));
