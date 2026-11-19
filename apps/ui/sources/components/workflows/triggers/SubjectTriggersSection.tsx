import * as React from 'react';
import { useRouter } from 'expo-router';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentRefV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentRefV1';
import type { AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { useWidgetFrameBodyMeta } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { WidgetGlanceRow } from '@/components/widgets/glance/WidgetGlanceRow';
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
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
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

/** An external Work + intent opens the same sentence as the section's own Add action. */
export type SubjectTriggersSectionActions = Readonly<{
  openNewTrigger(anchor: React.RefObject<View | null>): void;
}>;

/** An Action detail page: its before/after attachments are selected by Action id, never a fabricated resource subject. */
export type ActionAutomationsSubject = Readonly<{ kind: 'action'; actionId: string }>;

export type SubjectTriggersSectionProps = Readonly<{
      /** A legacy page subject (Machine, Environment, service) keeps its starters; a canonical subject is read as itself. */
      subject: TriggerSubject | AutomationSubjectV1 | ActionAutomationsSubject;
      contextSubjects?: readonly AutomationSubjectV1[];
      executionContext?: Pick<WorkflowProjectTargetV1, 'machineId' | 'directory'>;
      serverId?: string;
      /** The host's mounted Account lifetime, when its read borrows one; explicit null makes no read. */
      accountLifetime?: ServerAccountScopeLifetime | null;
      /** The page's own name for its subject, used in the agent's prompt and the read-back. */
      subjectName: string;
      testID?: string;
      actionsRef?: React.Ref<SubjectTriggersSectionActions>;
      exactTurnPrefill?: ExactTurnAutomationPrefill;
      /** A deep link to one of this resource's automations opens its editor once. */
      revealAutomationId?: string;
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
  & Readonly<{ subject: TriggerSubject | AutomationSubjectV1 }>) {
  const automations = useResourceAutomationsSection(props);
  return <SubjectTriggersSectionContent {...props} automations={automations} />;
});

/** Hosts with destination children share one intake rather than acquiring a second Session watcher. */
export const SubjectTriggersSectionContent = React.memo(
  function SubjectTriggersSectionContent(props: SubjectTriggersSectionProps & Readonly<{
    /** An Action's selected read has no resource Link, placement or Session intake. */
    automations: SelectedAutomationsSectionRead & Partial<Pick<ResourceAutomationsSectionRead, 'project' | 'link' | 'session'>>;
  }>) {
    const { accountLifetime, read, editor, rows, also, skippedNotSharedCount, project, link, session } = props.automations;
    const presented = useLayoutPresentationActive();
    const linkAnchor = React.useRef<View>(null);
    // Link is decided by this resource's settled starts: offered when some can start a linked workflow, never a form that
    // cannot succeed. While they load its place is held unseen, so the common case (starts exist) lands without moving
    // Automate…; none settles it away, and starts that could not be read say so in the section.
    const linkSlot = !link ? 'none' : link.whenStatus === 'ready' ? link.whenOptions.length > 0 ? 'offered' : 'none'
      : link.whenStatus === 'loading' ? 'pending' : link.whenStatus === 'unavailable' ? 'unavailable' : 'none';
    const router = useRouter();
    const { status } = read;
    const legacy = 'serverId' in props.subject || props.subject.kind === 'action' ? null : props.subject;
    const actionId = props.subject.kind === 'action' ? props.subject.actionId : null;
    const starters = legacy ? SUBJECT_TRIGGER_STARTERS[legacy.kind] : NO_STARTERS;
    const persistentStarters = legacy ? SUBJECT_TRIGGER_PERSISTENT_STARTERS[legacy.kind] : NO_STARTERS;
    const addAnchor = React.useRef<View>(null);
    const [opening, setOpening] = React.useState<Opening | null>(null);
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
        subject: legacy, deploymentEnvironment: props.deploymentEnvironment,
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
    React.useImperativeHandle(props.actionsRef, () => ({ openNewTrigger: (anchor) => { openSentence(null, anchor); } }), [openSentence]);
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
    const linkExpanded = opening?.kind === 'link';
    // Offline, unread starts are the page's one offline fact: Retry can't answer until the subject is back.
    const linkHeld = linkSlot === 'pending' || (linkSlot === 'unavailable' && props.offlineStatedAbove !== true);
    // In a widget frame the same two actions are its header's icon controls, under the same anchors and rule.
    const frameActions = React.useMemo(() => !widget ? null : (
      <View style={styles.actions}>
        {linkSlot === 'offered' ? (
          <View ref={linkAnchor} collapsable={false}>
            <IconButton testID="subject-triggers-link" iconName="link" variant="plain" expanded={linkExpanded}
              accessibilityLabel={t('workflows.triggers.section.link')} tooltip={t('workflows.triggers.section.link')}
              onPress={() => setOpening({ kind: 'link', anchor: linkAnchor })} />
          </View>
        ) : linkHeld ? (
          <View testID="subject-triggers-link-pending" style={styles.heldSlot} pointerEvents="none"
            aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <IconButton iconName="link" variant="plain" accessibilityLabel={t('workflows.triggers.section.link')} disabled onPress={() => {}} />
          </View>
        ) : null}
        <View ref={addAnchor} collapsable={false}>
          <IconButton testID="subject-triggers-add" iconName="plus" variant="plain"
            accessibilityLabel={t('workflows.triggers.section.automate')} tooltip={t('workflows.triggers.section.automate')}
            onPress={() => openSentence(null, addAnchor)} />
        </View>
      </View>
    ), [widget, linkSlot, linkHeld, linkExpanded, openSentence]);
    const sectionActions = widget ? null : (
      <View ref={addAnchor} collapsable={false} style={styles.actions}>
        <SectionActionButton
          testID="subject-triggers-add"
          icon="plus"
          title={t('workflows.triggers.section.automate')}
          onPress={() => openSentence(null, addAnchor)}
        />
        {linkSlot === 'offered' ? (
          <View ref={linkAnchor} collapsable={false}>
            <SectionActionButton
              testID="subject-triggers-link"
              icon="link"
              title={t('workflows.triggers.section.link')}
              expanded={opening?.kind === 'link'}
              onPress={() => setOpening({ kind: 'link', anchor: linkAnchor })}
            />
          </View>
        ) : linkHeld ? (
          <View testID="subject-triggers-link-pending" style={styles.heldSlot} pointerEvents="none"
            aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <SectionActionButton icon="link" title={t('workflows.triggers.section.link')} disabled onPress={() => {}} />
          </View>
        ) : null}
      </View>
    );
    const section = (
      <ItemGroup
        testID={props.testID ?? 'subject-triggers'}
        {...(widget ? { surface: 'none' as const } : { title: t('workflows.triggers.section.title'), description, action: sectionActions })}
      >
        {widget ? <WidgetGlanceRow variant="fact" title={description} testID="subject-triggers-description" /> : null}
        {unsettled ? (
          <ItemLoadStateRows testID="subject-triggers-read" rows={2} accessibilityLabel={t('workflows.triggers.section.title')}
            // Nothing held: the whole section failed, said once with its Retry.
            state={status === 'failed' ? { kind: 'failed', reason: t('workflows.triggers.section.automationsLoadFailed'), onRetry: read.retry }
              : { kind: 'loading' }} />
        ) : empty
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
            ))}
        {/* Starts that could not be read say so under the rows they belong to, before the host's own rows. */}
        {linkSlot === 'unavailable' && !unsettled && status !== 'failed' && props.offlineStatedAbove !== true ? (
          <SurfaceStateCard testID="subject-triggers-starts-unavailable" size="line" kind="unavailable"
            title={t('workflows.triggers.section.startsUnavailable')}
            action={link ? { label: t('common.retry'), onPress: link.retryWhen } : undefined} />
        ) : null}
        {props.children}
        {empty ? null : persistentStarters.filter(starterAvailable).map((starter) => (
          <StarterRow key={starter} starter={starter} onOpen={(anchor) => openStarter(starter, anchor)} />
        ))}
        {nothingHere ? (
          <SurfaceStateCard testID="subject-triggers-empty" size="line" kind="empty" title={t('workflows.triggers.section.empty')} />
        ) : null}
        {skippedNotSharedCount > 0 ? (
          <SurfaceStateCard testID="subject-triggers-not-shared" size="line" kind="unavailable"
            title={t('workflows.triggers.section.skippedNotShared', { count: skippedNotSharedCount })} />
        ) : null}
        {read.attachedPage?.nextCursor ? (
          <Item testID="subject-triggers-more" title={t('workflows.triggers.section.showMore')} showChevron={false}
            onPress={read.loadMore} />
        ) : null}
        {held && status === 'failed' ? (
          <SurfaceFreshnessLine
            testID="subject-triggers-read"
            tone="warning"
            reason={t('workflows.triggers.section.accountLoadFailed')}
            action={{
              label: t('workflows.triggers.popover.tryAgain'),
              onPress: read.retry,
            }}
          />
        ) : null}
      </ItemGroup>
    );
    // Broader triggers that also match this resource (a whole App, any Environment): read-only, opening their workflow.
    const alsoSection = also.length === 0 ? null : (
      <ItemGroup testID="subject-triggers-also" titleRole="label" title={t('workflows.triggers.section.alsoRunsHere')}>
        {also.map((row) => (
          <ReadOnlyAutomationRow key={`${row.automationId}:${row.triggerId ?? 'manual'}`} row={row} onOpen={openReadOnly} />
        ))}
      </ItemGroup>
    );
    // An open editor owns its draft independently of the row read's availability.
    return (
      <>
        {frameActions ? <WidgetFrameHeaderActions node={frameActions} /> : null}
        {section}
        {alsoSection}
        {editor.popover}
        {opening?.kind === 'link' && link ? (
          <ResourceLinkWorkflowSheet anchorRef={opening.anchor} resourceName={props.subjectName} link={link}
            serverId={accountLifetime?.scope.serverId ?? props.serverId ?? null}
            machineId={project?.machineId ?? (legacy ? legacy.machineId : null)} accountLifetime={accountLifetime}
            onRequestClose={close} onLinked={() => { close(); read.retry(); }} />
        ) : null}
        {opening?.kind === 'check' ? (
          <NewAccountTriggerPopover
            anchorRef={opening.anchor}
            onRequestClose={close}
            {...(project ? { initialProject: project } : {})}
            accountLifetime={accountLifetime}
            eventSeed={legacy ? subjectStarterEventSeed('healthFailed', { subject: legacy, controllerMachineId: props.controllerMachineId }) : undefined}
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

/** Lends the section's actions to the widget frame that heads it; mounted only in that presentation. */
function WidgetFrameHeaderActions(props: Readonly<{ node: React.ReactNode }>) {
  useWidgetFrameBodyMeta(props.node);
  return null;
}

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
        title={row.subtitlePending ? WORKFLOW_NAME_PENDING_TITLE : row.subtitle} subtitle={joinHappierFacts(row.title, author)} dimmed={row.off}
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
  /** Link's place while this resource's starts load or could not be read: held, not drawn, so Automate… never moves. */
  heldSlot: { opacity: 0 },
}));
