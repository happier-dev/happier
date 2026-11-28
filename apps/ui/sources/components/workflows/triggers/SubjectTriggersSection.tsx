import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { useRouter } from 'expo-router';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider, useListPresentation } from '@/components/ui/lists/listPresentation';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useWidgetFrameBodyMeta } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { WidgetGlanceRow } from '@/components/widgets/glance/WidgetGlanceRow';
import { PageRowDensityProvider } from '@/components/ui/lists/useResolvedItemDensity';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SkeletonTitle } from '@/components/ui/lists/SkeletonRows';
import { Typography } from '@/constants/Typography';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import type { WorkflowSentenceEditorIntent } from '@/components/workflows/authoring/workflowSentenceAuthoring';
import { WorkflowSentenceBuilder } from '@/components/workflows/sentence/WorkflowSentenceBuilder';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { areExactTurnAutomationPrefillsEqual, type ExactTurnAutomationPrefill } from '@/components/automations/sessionLifecycle/exactTurnAutomationPrefill';
import type { SessionWorkflowSentenceOptions } from '@/components/workflows/authoring/workflowSentenceAuthoring';

import { formatAutomationSourceStatusWarning } from '@/components/automations/list/automationListFormatting';
import type { AccountTriggerRow, TriggerSubject } from './accountTriggerRows';
import { NewAccountTriggerPopover } from './AccountTriggersSection';
import { DeploymentPushTriggerSetup } from './DeploymentPushTriggerSetup';
import type { DeploymentPushSetupConfig } from './deploymentPushSetup';
import { ScheduledServiceJobSetup } from './ScheduledServiceJobSetup';
import { subjectStarterWhen, subjectStarterEventSeed, type SubjectSentenceStarter } from './subjectTriggerStarters';
import { buildTriggerDefinition } from './sessionTriggerForm';
import {
  SUBJECT_TRIGGER_PERSISTENT_STARTERS,
  SUBJECT_TRIGGER_STARTER_GLYPH,
  SUBJECT_TRIGGER_STARTERS,
  type SubjectTriggerStarter,
} from './subjectTriggerStarters';
import { TriggerRow, type TriggerRowOutcome } from './TriggerRow';
import { ResourceLinkWorkflowSheet } from './ResourceLinkWorkflowSheet';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { resolveUnknownAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import { HappierAutomationsSection, joinHappierFacts, type HappierAutomationsSectionBindings } from '@happier-dev/plugin-ui/presentation';
import { useResourceAutomationsSection, type ResourceAutomationsSectionRead, type SelectedAutomationsSectionRead } from './useResourceAutomationsSection';
import { createWorkflowTriggerStartWhen } from './workflowTriggerStarts';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';

const NO_STARTERS: readonly SubjectTriggerStarter[] = [];

/** One sentence per kind: what starts from this resource (05 S5). A legacy page offers starters when it has none. */
function describeAutomationsSection(kind: SubjectTriggersSectionProps['subject']['kind'], empty: boolean): string {
  switch (kind) {
    case 'action': return t('workflows.triggers.section.actionInfo');
    case 'machine': return t(empty ? 'workflows.triggers.section.machineEmpty' : 'workflows.triggers.section.machineInfo');
    case 'environment': return t(empty ? 'workflows.triggers.section.environmentEmpty' : 'workflows.triggers.section.environmentInfo');
    case 'service': return t(empty ? 'workflows.triggers.section.serviceEmpty' : 'workflows.triggers.section.serviceInfo');
    case 'approvalProfile': return t('workflows.triggers.section.approvalProfileInfo');
    case 'database': return t('workflows.triggers.section.databaseInfo');
    case 'healthCheck': return t('workflows.triggers.section.healthCheckInfo');
    case 'project': return t('workflows.triggers.section.projectInfo');
    case 'app': return t('workflows.triggers.section.appInfo');
    case 'backup': return t('workflows.triggers.section.backupInfo');
    case 'session': return t('workflows.triggers.section.info');
    case 'plugin': return t('workflows.triggers.section.pluginInfo');
  }
}

type Opening =
  | Readonly<{ kind: 'scheduledJob' | 'deployOnPush'; anchor: React.RefObject<View | null> }>
  /** Add a check: the New trigger editor opened at the subject's own health form (the bound health-setup seed). */
  | Readonly<{ kind: 'check'; anchor: React.RefObject<View | null> }>
  /** Link workflow: an existing workflow, a When from this resource's starts, and the same-step share question (D8). */
  | Readonly<{ kind: 'link'; anchor: React.RefObject<View | null> }>
  /** Automate… and the sentence starters: the builder, seeded with this resource's place and the starter's When (D10). */
  | Readonly<{ kind: 'sentence'; anchor: React.RefObject<View | null>; intent: WorkflowSentenceEditorIntent;
      lifetime: ServerAccountScopeLifetime; key: number }>;

/** An Action detail page: its before/after attachments are selected by Action id, never a fabricated resource subject. */
export type ActionAutomationsSubject = Readonly<{ kind: 'action'; actionId: string }>;

export type SubjectTriggersSectionProps = Readonly<{
      /** A legacy page subject (Machine, Environment, service) keeps its starters; a canonical subject is read as itself. */
      subject: TriggerSubject | AutomationSubjectV1 | ActionAutomationsSubject;
      contextSubjects?: readonly AutomationSubjectV1[];
      /** The admitted host Machine for Action/event catalogs; does not imply an execution directory. */
      machineId?: string;
      executionContext?: WorkflowProjectTargetV1;
      serverId?: string;
      /** The host's mounted Account lifetime, when its read borrows one; explicit null makes no read. */
      accountLifetime?: ServerAccountScopeLifetime | null;
      /** The page's own name for its subject, used in the agent's prompt and the read-back. */
      subjectName: string;
      testID?: string;
      /**
       * A route's one-shot ask to add a trigger here (a Session's Work "+" › Add a trigger… lands on Info): each distinct
       * token opens the same sentence as the section's own Add action, once.
       */
      openNewToken?: string;
      exactTurnPrefill?: ExactTurnAutomationPrefill;
      /** A deep link to one of this resource's automations opens its editor once. */
      revealAutomationId?: string;
      /** A host-owned habit the sheet leads with, before its triggers (a Session's "Review my changes"). */
      leading?: React.ReactNode;
      /** Rows the host composes into the same sheet after the triggers (a Session's "writes here"). */
      children?: React.ReactNode;
      /** The host's own rows are held, so the section is neither pending nor empty without triggers. */
      hasRetainedContent?: boolean;
      /**
       * `widget`: a widget frame heads the section (lab automations-v-project). The frame's title is its title,
       * Automate… and Link workflow are the frame header's icon actions, and the description leads the body.
       */
      presentation?: 'section' | 'widget';
      deploymentEnvironment?: DeploymentEnvironmentRefV1;
      deploymentSourceName?: string;
      sourceAudience?: readonly PrincipalRefV1[];
      controllerMachineId?: string;
      pushSetup?: DeploymentPushSetupConfig;
      /** The page already says its subject is offline: starts it can't read then add no line and hold no Link place. */
      offlineStatedAbove?: boolean;
}>;

/** A selected resource's Automations, borrowing the physical host's Account and presentation demand. */
export const SubjectTriggersSection = React.memo(function SubjectTriggersSection(props: SubjectTriggersSectionProps
  & Readonly<{ subject: TriggerSubject | AutomationSubjectV1; automations?: ReturnType<typeof useResourceAutomationsSection> }>) {
  const { automations, ...section } = props;
  return automations
    ? <SubjectTriggersSectionContent {...section} automations={automations} />
    : <SubjectTriggersSectionReader {...section} />;
});

function SubjectTriggersSectionReader(props: SubjectTriggersSectionProps & Readonly<{ subject: TriggerSubject | AutomationSubjectV1 }>) {
  const automations = useResourceAutomationsSection(props);
  return <SubjectTriggersSectionContent {...props} automations={automations} />;
}

type SubjectTriggersReadStateProps = Readonly<{
  status: 'loading' | 'failed';
  onRetry?: () => void | Promise<unknown>;
  /** Why the read failed, when its host knows ("Its Machine isn't answering."): said after the failure, on its line. */
  reason?: string;
}>;

function describeReadState(props: SubjectTriggersReadStateProps) {
  if (props.status === 'loading') return { kind: 'loading' } as const;
  const failed = t('workflows.triggers.section.automationsLoadFailed');
  return { kind: 'failed', reason: props.reason ? `${failed} ${props.reason}` : failed, onRetry: props.onRetry } as const;
}

function WidgetFrameHeaderActions(props: Readonly<{ node: React.ReactNode }>) {
  useWidgetFrameBodyMeta(props.node);
  return null;
}

function SectionActionBar(props: Readonly<{ anchor?: React.RefObject<View | null>; children: React.ReactNode }>) {
  return <View {...(props.anchor ? { ref: props.anchor, collapsable: false } : {})} style={styles.actions}>{props.children}</View>;
}

const SECTION_BINDINGS = {
  // Read host components at render time, as the host did before extracting the section.
  get Group() { return ItemGroup; },
  get PagePresentation() { return ListPresentationProvider; },
  get RowDensity() { return PageRowDensityProvider; },
  get WidgetDescription() { return WidgetGlanceRow; },
  WidgetHeaderActions: WidgetFrameHeaderActions,
  ActionBar: SectionActionBar,
  get LoadStateRows() { return ItemLoadStateRows; },
  get StateLine() { return SurfaceStateCard; },
  get FreshnessLine() { return SurfaceFreshnessLine; },
  get MoreRow() { return Item; },
  get SectionButton() { return SectionActionButton; },
  get IconButton() { return IconButton; },
} satisfies HappierAutomationsSectionBindings;

/** A host whose subject read has not succeeded keeps the shared section without inventing an identity. */
export function SubjectTriggersSectionReadState(props: SubjectTriggersReadStateProps
  & Readonly<{ subjectKind: SubjectTriggersSectionProps['subject']['kind'] }>) {
  const page = useListPresentation() === 'page';
  return <HappierAutomationsSection bindings={SECTION_BINDINGS} page={page} title={t('workflows.triggers.section.title')}
    description={describeAutomationsSection(props.subjectKind, false)} readState={describeReadState(props)} />;
}

/** Hosts with destination children share one intake rather than acquiring a second Session watcher. */
export const SubjectTriggersSectionContent = React.memo(
  function SubjectTriggersSectionContent(props: SubjectTriggersSectionProps & Readonly<{
    /** An Action's selected read has no resource Link, placement or Session intake. */
    automations: SelectedAutomationsSectionRead & Partial<Pick<ResourceAutomationsSectionRead, 'machineId' | 'project' | 'link' | 'session'>>;
  }>) {
    const { accountLifetime, read, editor, rows, also, skippedNotSharedCount, machineId, project, link, session } = props.automations;
    const presented = useLayoutPresentationActive();
    const page = useListPresentation() === 'page';
    const linkAnchor = React.useRef<View>(null);
    const router = useRouter();
    const { status } = read;
    const legacy = 'serverId' in props.subject || props.subject.kind === 'action' ? null : props.subject;
    const actionId = props.subject.kind === 'action' ? props.subject.actionId : null;
    const starters = legacy ? SUBJECT_TRIGGER_STARTERS[legacy.kind] : NO_STARTERS;
    const persistentStarters = legacy ? SUBJECT_TRIGGER_PERSISTENT_STARTERS[legacy.kind] : NO_STARTERS;
    const addAnchor = React.useRef<View>(null);
    const [opening, setOpening] = React.useState<Opening | null>(null);
    const linkExpanded = opening?.kind === 'link';
    const setLinkOpen = link?.setOpen;
    React.useEffect(() => {
        if (!linkExpanded || !setLinkOpen) return;
        setLinkOpen(true);
        return () => setLinkOpen(false);
    }, [linkExpanded, setLinkOpen]);
    const starterAvailable = (starter: SubjectTriggerStarter) => starter === 'scheduledJob'
      ? props.deploymentEnvironment !== undefined : starter !== 'deployOnPush' || props.pushSetup !== undefined;
    const empty = rows.length === 0;
    const serverId = accountLifetime?.scope.serverId;
    // Another person's trigger and a broader one that also matches here are read here and changed in their
    // workflow: the row opens it (its trigger editor when it has no saved workflow).
    const openWorkflow = React.useCallback((workflowId: string) => {
      router.push({ pathname: '/workflows/[id]', params: { id: workflowId, ...(serverId ? { serverId } : {}) } } as never);
    }, [router, serverId]);
    const openReadOnly = React.useCallback((row: AccountTriggerRow, anchor: React.RefObject<View | null>) => {
      const workflowId = row.attachment?.workflowDefinitionId;
      if (workflowId) openWorkflow(workflowId);
      else void editor.open(row, anchor);
    }, [editor, openWorkflow]);
    const close = () => setOpening(null);
    const sentenceKey = React.useRef(0);
    const openSentence = React.useCallback((starter: SubjectSentenceStarter | null, anchor: React.RefObject<View | null>, options?: SessionWorkflowSentenceOptions) => {
      const lifetime = accountLifetime === undefined ? captureActiveServerAccountScopeLifetime() : accountLifetime;
      if (!lifetime?.isCurrent()) return false;
      const eventSeed = starter === null || !legacy ? undefined : subjectStarterEventSeed(starter, {
        subject: legacy, deploymentEnvironment: props.deploymentEnvironment, serverId: lifetime.scope.serverId,
        controllerMachineId: props.controllerMachineId,
      });
      // An Action page starts from "Before each ⟨Action⟩" (it waits for the result); the sentence can switch to After.
      const actionWhen = actionId === null ? null : createWorkflowTriggerStartWhen('action:before');
      const trigger = starter === 'nightly' ? buildTriggerDefinition({
        when: subjectStarterWhen('nightly'), enabled: true, sessionId: null,
      }) : actionWhen?.kind === 'action' ? buildTriggerDefinition({
        when: { ...actionWhen, actionIds: [actionId!] }, enabled: true, sessionId: null,
      }) : null;
      const intent = session ? session.createSentenceIntent(options) : { name: props.subjectName,
        ...(project ? { project } : {}), ...(eventSeed ? { eventSeed } : {}), ...(trigger ? { trigger } : {}) };
      if (!intent) return false;
      sentenceKey.current += 1;
      setOpening({ kind: 'sentence', anchor, lifetime, key: sentenceKey.current, intent });
      return true;
    }, [accountLifetime, legacy, actionId, props.deploymentEnvironment, props.controllerMachineId, props.subjectName, project, session]);
    const openAutomate = React.useCallback(() => openSentence(null, addAnchor), [openSentence]);
    const openLink = React.useCallback(() => setOpening({ kind: 'link', anchor: linkAnchor }), []);
    useCurrentUiContextLocalCommands([{
      key: 'automate', title: t('workflows.triggers.section.automate'), invoke: openAutomate,
    }], { contextKey: JSON.stringify(props.subject) });
    const consumedOpenNew = React.useRef<string | null>(null);
    React.useEffect(() => {
      const token = props.openNewToken;
      if (!presented || !token || consumedOpenNew.current === token) return;
      if (openSentence(null, addAnchor)) consumedOpenNew.current = token;
    }, [presented, props.openNewToken, openSentence]);
    const consumedExactTurn = React.useRef<ExactTurnAutomationPrefill | null>(null);
    React.useEffect(() => {
      const prefill = props.exactTurnPrefill;
      if (!presented || !prefill || !session
        || areExactTurnAutomationPrefillsEqual(consumedExactTurn.current, prefill)) return;
      if (openSentence(null, addAnchor, { exactTurnPrefill: prefill })) consumedExactTurn.current = prefill;
    }, [presented, props.exactTurnPrefill, session, openSentence]);
    const openStarter = (starter: SubjectTriggerStarter, anchor: React.RefObject<View | null>) => {
      if (starter === 'scheduledJob' || starter === 'deployOnPush') setOpening({ kind: starter, anchor });
      else if (starter === 'addCheck') setOpening({ kind: 'check', anchor });
      else openSentence(starter, anchor);
    };
    // Nothing known yet: the section keeps its place with its header and two placeholder rows, so the
    // page does not move when the rows land. With nothing retained, a failed read says so in place, with Retry.
    const held = !empty || props.hasRetainedContent === true;
    const unsettled = !held && status !== 'ready';
    // Settled with nothing to show (no rows, no starter, nothing broader): say what belongs here in one line, never a blank sheet.
    const nothingHere = !held && !unsettled && !starters.some(starterAvailable) && also.length === 0 && skippedNotSharedCount === 0;
    const widget = props.presentation === 'widget';
    const description = describeAutomationsSection(props.subject.kind, empty && !unsettled);
    const sectionRows = unsettled ? undefined : empty
      ? starters.filter(starterAvailable).map((starter) => (
          <StarterRow key={starter} starter={starter} onOpen={(anchor) => openStarter(starter, anchor)} />
        ))
      : rows.map((row) => row.readOnly ? (
          <ReadOnlyAutomationRow key={`${row.automationId}:${row.triggerId ?? 'manual'}`} row={row} onOpen={openReadOnly} />
        ) : (
          <SubjectTriggerRowView
            key={`${row.automationId}:${row.triggerId ?? 'manual'}`}
            row={row}
            pending={editor.pending.has(row.automationId)}
            reveal={row.automationId === props.revealAutomationId}
            onOpen={(anchor) => {
              void editor.open(row, anchor);
            }}
            onToggle={(next) => {
              void editor.toggle(row, next);
            }}
            onRemove={editor.remove}
            onOpenWorkflow={openWorkflow}
          />
        ));
    // An open editor owns its draft independently of the row read's availability.
    return (
      <>
        <HappierAutomationsSection bindings={SECTION_BINDINGS} testID={props.testID} page={page} widget={widget}
          title={t('workflows.triggers.section.title')} description={description}
          controls={{
            automateLabel: t('workflows.triggers.section.automate'), linkLabel: t('workflows.triggers.section.link'),
            addAnchor, linkAnchor, onAutomate: openAutomate,
            link: link && accountLifetime !== null ? { kind: 'offered', expanded: linkExpanded, onPress: openLink } : null,
          }}
          leading={props.leading}
          readState={unsettled ? describeReadState({ status: status === 'failed' ? 'failed' : 'loading',
            onRetry: read.retryable === false ? undefined : read.retry }) : undefined}
          rows={sectionRows}
          persistentStarters={empty ? null : persistentStarters.filter(starterAvailable).map((starter) => (
            <StarterRow key={starter} starter={starter} onOpen={(anchor) => openStarter(starter, anchor)} />
          ))}
          emptyTitle={nothingHere ? t('workflows.triggers.section.empty') : undefined}
          notSharedTitle={skippedNotSharedCount > 0 ? t('workflows.triggers.section.skippedNotShared', { count: skippedNotSharedCount }) : undefined}
          more={read.attachedPage?.nextCursor ? { label: t('workflows.triggers.section.showMore'), onPress: read.loadMore } : undefined}
          freshness={held && status === 'failed' ? { reason: t('workflows.triggers.section.accountLoadFailed'),
            action: read.retryable === false ? undefined : { label: t('workflows.triggers.popover.tryAgain'), onPress: read.retry } } : undefined}
          also={also.length === 0 ? undefined : {
            title: t('workflows.triggers.section.alsoRunsHere'),
            rows: also.map((row) => (
              <ReadOnlyAutomationRow key={`${row.automationId}:${row.triggerId ?? 'manual'}`} row={row} onOpen={openReadOnly} />
            )),
          }}>
          {props.children}
        </HappierAutomationsSection>
        {editor.popover}
        {opening?.kind === 'link' && link ? (
          <ResourceLinkWorkflowSheet anchorRef={opening.anchor} resourceName={props.subjectName} link={link}
            serverId={accountLifetime?.scope.serverId ?? props.serverId ?? null}
            machineId={machineId ?? null} accountLifetime={accountLifetime}
            onRequestClose={close} onLinked={() => { close(); read.retry(); }} />
        ) : null}
        {opening?.kind === 'check' ? (
          <NewAccountTriggerPopover
            anchorRef={opening.anchor}
            onRequestClose={close}
            {...(project ? { initialProject: project } : {})}
            accountLifetime={accountLifetime}
            deploymentEnvironment={props.deploymentEnvironment}
            eventSeed={legacy ? subjectStarterEventSeed('addCheck', { subject: legacy, controllerMachineId: props.controllerMachineId }) : undefined}
          />
        ) : null}
        {opening?.kind === 'sentence' ? (
          <WorkflowSentenceBuilder key={opening.key} anchorRef={opening.anchor} intent={opening.intent}
            resourceName={props.subjectName} accountLifetime={opening.lifetime} onRequestClose={close} />
        ) : null}
        {opening?.kind === 'deployOnPush' && props.pushSetup ? (
          <DeploymentPushTriggerSetup anchorRef={opening.anchor} onRequestClose={close}
            config={props.pushSetup} accountLifetime={accountLifetime} />
        ) : null}
        {opening?.kind === 'scheduledJob' && props.deploymentEnvironment && legacy && project ? (
          <ScheduledServiceJobSetup anchorRef={opening.anchor} onRequestClose={close}
            serverId={props.deploymentEnvironment.serverId} environmentId={props.deploymentEnvironment.environmentId}
            machineId={legacy.machineId} project={project} />
        ) : null}
      </>
    );
  },
);

/** A suggested entry opens a sentence draft or the subject's specialized setup. */
const StarterRow = React.memo(function StarterRow(
  props: Readonly<{
    starter: SubjectTriggerStarter;
    onOpen: (anchor: React.RefObject<View | null>) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const anchorRef = React.useRef<View>(null);
  return (
    <View ref={anchorRef} collapsable={false}>
      <Item
        testID={`subject-triggers-starter:${props.starter}`}
        title={props.starter === 'deployOnPush' ? t('workflows.examples.deployOnPush.title')
          : props.starter === 'scheduledJob' ? t('workflows.examples.runJobOnSchedule.title')
          : t(`workflows.triggers.guided.starter.${props.starter}`)}
        icon={
          <Icon
            name={SUBJECT_TRIGGER_STARTER_GLYPH[props.starter]}
            color={theme.colors.text.secondary}
          />
        }
        onPress={() => props.onOpen(anchorRef)}
      />
    </View>
  );
});

/** The last Run as every trigger row says it ("Passed 2h ago"), from the Run lifecycle owner's tone and word. */
function useAttachmentOutcome(row: AccountTriggerRow): TriggerRowOutcome | null {
  const lastRun = row.attachment?.lastRun;
  return React.useMemo(() => {
    if (!lastRun) return null;
    const status = resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(lastRun) });
    const atMs = Date.parse(lastRun.startedAt);
    return { text: status.word, tone: status.tone, relativeAge: { atMs, state: status.word } };
  }, [lastRun]);
}

/** Someone else's trigger, or a broader one that also runs here: who set it up and when it runs, no switch. */
const ReadOnlyAutomationRow = React.memo(function ReadOnlyAutomationRow(props: Readonly<{
  row: AccountTriggerRow;
  onOpen: (row: AccountTriggerRow, anchor: React.RefObject<View | null>) => void;
}>) {
  const { theme } = useUnistyles();
  const anchorRef = React.useRef<View>(null);
  const { row } = props;
  const author = row.yours ? null : t('workflows.triggers.section.setUpBy', {
    name: row.setUpBy?.displayName ?? resolveUnknownAccountActorName('sentence') });
  return (
    <View ref={anchorRef} collapsable={false}>
      <Item testID={`subject-triggers-read-only:${row.automationId}:${row.triggerId ?? 'manual'}`}
        title={row.subtitlePending ? WORKFLOW_NAME_PENDING_TITLE : row.subtitle} subtitle={joinHappierFacts(row.off ? t('workflows.triggers.row.off') : null, row.title, author)} dimmed={row.off}
        icon={<Icon name={row.glyph} color={theme.colors.text.secondary} />}
        onPress={() => props.onOpen(row, anchorRef)} />
    </View>
  );
});

/** A linked workflow's name still arriving holds the row's title slot with the loading bar, never "Run a workflow". */
const WORKFLOW_NAME_PENDING_TITLE = <SkeletonTitle lineHeight={Typography.variant('body').lineHeight as number} testID="subject-triggers-name-pending" />;

const SubjectTriggerRowView = React.memo(function SubjectTriggerRowView(
  props: Readonly<{
    row: AccountTriggerRow;
    pending: boolean;
    /** Deep-linked: the row opens its editor once it is shown. */
    reveal?: boolean;
    onOpen: (anchor: React.RefObject<View | null>) => void;
    onToggle: (next: boolean) => void;
    /** The editor's stable remover; the Action owns its confirmation. */
    onRemove: (row: AccountTriggerRow) => unknown;
    /** Opens the saved workflow this trigger runs (the row's ⋯ → Open workflow). */
    onOpenWorkflow: (workflowId: string) => void;
  }>,
) {
  const anchorRef = React.useRef<View>(null);
  const { row } = props;
  const { onRemove, onOpenWorkflow } = props;
  const openRef = React.useRef(props.onOpen);
  openRef.current = props.onOpen;
  React.useEffect(() => { if (props.reveal) openRef.current(anchorRef); }, [props.reveal]);
  // 05 S5: Open workflow, Edit trigger, then the destructive one. A saved workflow's trigger here is a link (Unlink keeps
  // the workflow); an inline one is the trigger itself.
  const workflowId = row.attachment?.workflowDefinitionId ?? null;
  const menuActions = React.useMemo(() => [
    ...(workflowId ? [{ id: 'open', title: t('workflows.triggers.row.openWorkflow'), icon: 'arrow-square-out' as const,
      onPress: () => onOpenWorkflow(workflowId) }] : []),
    { id: 'edit', title: t('workflows.triggers.row.editTrigger'), icon: 'pencil-simple' as const,
      onPress: () => openRef.current(anchorRef) },
    { id: 'remove', title: t(workflowId ? 'workflows.triggers.row.unlink' : 'workflows.triggers.row.removeTrigger'),
      icon: workflowId ? 'link-break' as const : 'trash' as const, destructive: true, onPress: () => { void onRemove(row); } },
  ], [onOpenWorkflow, onRemove, row, workflowId]);
  // A page sheet names a trigger by what it runs, its event the quiet line (the column leads with the event).
  const manual = row.triggerId === null;
  const outcome = useAttachmentOutcome(row);
  // A watcher that cannot observe (its typed source status) is said on its row, where a stuck start is looked for;
  // pressing the row opens the trigger to fix it (DEPLOY-AUDIT-1123).
  const sourceWarning = row.off ? null : formatAutomationSourceStatusWarning(row.attachment?.sourceStatus);
  return (
    <View ref={anchorRef} collapsable={false}>
      <TriggerRow
        testID={`subject-triggers:${row.automationId}${row.triggerId ? `:${row.triggerId}` : ''}`}
        title={row.legacy?.title ?? (manual ? row.title : row.subtitle)}
        {...(!manual && !row.legacy && row.subtitlePending ? { titleContent: WORKFLOW_NAME_PENDING_TITLE } : {})}
        qualifier={row.legacy?.qualifier ?? (manual ? row.subtitle : row.title)}
        enabled={!row.off}
        multiline={!!row.legacy}
        {...(row.attachment ? { outcome } : {})}
        {...(sourceWarning ? { attention: sourceWarning } : {})}
        glyph={row.sourceGone ? 'warning' : row.glyph}
        menuActions={row.sourceGone ? undefined : menuActions}
        toggleDisabled={props.pending || props.row.sourceGone === true}
        onToggle={props.onToggle}
        onPress={() => props.onOpen(anchorRef)}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
