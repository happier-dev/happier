import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPageHeader, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { WidgetFrameBodyRowsContext } from '@/components/widgets/frame/widgetFrameBody';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectExecutionChoiceV1, WorkspaceWorkerPreferenceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { resolveProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { resolveProjectMemoryDemandV1, type ProjectMemoryDemandV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectMemoryDemandV1';
import { isSameInputOptionValue } from '@happier-dev/protocol/inputs';
import type {
  ProjectDefinitionDetectionV1,
  ProjectManifestV1,
  ProjectNativeRefV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { SessionAuthoringOpenResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { WidgetGlanceRow } from '@/components/widgets/glance/WidgetGlanceRow';

import {
  ItemGroupColumn,
  ItemGroupColumns,
} from '@/components/ui/lists/ItemGroupColumns';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { CheckoutUnreachableState, useCheckoutReachability } from '@/components/workspaces/reachability/checkoutReachability';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useLayoutMaxWidth, useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { renderPageHeaderText } from '@/components/ui/layout/PageHeader';
import { projectSetupReadinessLine } from './projectSetupReadinessLine';
import { describeScriptEnvironmentRefusal, nativeEnvironmentNameFor } from './projectEnvironmentPresentation';
import { useDeviceType } from '@/utils/platform/responsive';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';

import { ProjectCommandOutputHost, useProjectCommandOutputOpener } from '@/components/inbox/actionOperations/projectCommandOutputHost';
import { ProjectCommandOutputPane } from '@/components/inbox/actionOperations/ProjectCommandOutputPane';
import { ProjectCommandOutputFrame } from '@/components/inbox/actionOperations/ProjectCommandOutputFrame';
import { ProjectManifestEditor } from './ProjectManifestEditor';
import { WorkspaceWorkerSettings, useWorkspaceWorkerPreference } from '@/components/projects/workers/WorkspaceWorkerSettings';
import { useWorkerDestinationLabel } from '@/components/projects/workers/useWorkerDestinationLabel';
import {
  describeProjectCommandSource,
  describeProjectEnvironment,
  describeProjectToolVersions,
  findProjectInvocation,
  describeProjectTool,
  joinProjectFiles,
  presentProjectRun,
} from './projectScriptPresentation';
import {
  projectScriptRowKey,
  useProjectScriptRun,
  useProjectSetupRun,
} from './projectScriptRuns';
import { ProjectScriptRow } from './ProjectScriptRow';
import { ProjectSetupReview } from './ProjectSetupReview';
import { ProjectSetupReviewPage, useProjectSetupReviewDecision } from './ProjectSetupReviewPage';
import { useRestoreFocusToTrigger, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { ProjectSetupAuthoredLine } from './ProjectSetupReturn';
import { WorkspaceAdHocCommandsItem } from '@/components/projects/workers/WorkspaceAdHocCommandsItem';
import { ProjectAgentGuidanceDisclosure } from '@/components/projects/workers/ProjectAgentGuidanceDisclosure';
import {
  projectDefinitionInspectionKey,
  useProjectDefinitionInspection,
  type ProjectDefinitionInspection,
} from './useProjectDefinitionInspection';
import { useProjectScriptsController, type ProjectScriptsController } from './useProjectScriptsController';
import { describeProjectAuthoringOpenFailure, useProjectSetupAuthoring } from './useProjectSetupAuthoring';
import type { ManagedMachineConfigurationContinuation } from '@/components/sessions/new/components/machineSelection/ManagedMachineSelectionOffers';

export type ProjectScriptsBodyProps = Readonly<{
  workspace: WorkspaceAddressV1;
  /** Exact Project/native selectors, when the caller has a controller-qualified handoff. */
  initialManagedConfiguration?: ManagedMachineConfigurationContinuation;
  /**
   * The Scripts page leads with its header and editor; the rail keeps the compact runnable list with
   * each script's source file beside its name. The Overview widget reads like its sibling widgets: one
   * glance row per script (its run mark, name and how it last went), with no sheet and no Run control.
   */
  presentation?: 'page' | 'rail' | 'widget';
  /** Services found here are reviewed on the Services page, never appended to the finite list. */
  onOpenServices?: () => void;
  /** The host's pane scope whose bottom terminal shows script output; absent where the host has none. */
  outputScopeId?: string | null;
  testID?: string;
}>;

/** The phone's way into the pushed review page: opens it, and hands back the entry that focus returns to. */
type PhoneSetupReview = Readonly<{ open: () => void; entryTarget: React.MutableRefObject<FocusReturnTarget> }>;

type EditorState = Readonly<{
  key: string;
  seed: boolean;
  mode: 'form' | 'raw';
}> | null;
type ScriptsController = ProjectScriptsController;

/**
 * The Scripts page, rail and widget body (plans 20 §8 / 21 §8, lab `s-scripts`): one component, two
 * hosts. It reads the passive definition owner (`projects.inspect`), runs through the one Project
 * Action client, and shows each run's status from the operation store.
 */
export function ProjectScriptsBody({
  workspace: workspaceInput,
  presentation = 'page',
  onOpenServices,
  outputScopeId,
  initialManagedConfiguration,
  testID = 'project-scripts',
}: ProjectScriptsBodyProps): React.ReactElement {
  const workspace = useStableWorkspace(workspaceInput);
  const serverId = resolveServerProfileScopeIdForIdentifier(workspace.serverId);
  const homes = React.useMemo(() => serverId ? [serverId] : [], [serverId]);
  const bindings = useServerCredentialAccountScopeBindings(homes);
  const binding = bindings.get(serverId) ?? null;
  const accountId = binding?.isCurrent() ? binding.accountId : null;
  const key = projectDefinitionInspectionKey(workspace);
  const { read, retry } = useProjectDefinitionInspection(workspace, binding);
  const runChoiceKeys = React.useMemo(() => {
    if (!read || !('value' in read)) return undefined;
    const document = read.value.definition.document;
    return document?.status === 'valid' ? Object.entries(document.manifest.scripts ?? {})
      .filter(([, declaration]) => declaration.execution === 'portable')
      .map(([name]) => projectScriptRowKey(workspace, name)) : [];
  }, [read, workspace]);
  const controller = useProjectScriptsController(workspace, retry, binding, { runChoiceKeys });
  const router = useRouter();
  const [editor, setEditor] = React.useState<EditorState>(null);
  // Workers settings open in place, like the editor: Scripts › Workers and Run on › Worker settings….
  const [workersKey, setWorkersKey] = React.useState<string | null>(null);
  const page = presentation === 'page';
  const glance = presentation === 'widget';
  const phone = useDeviceType() === 'phone';
  // On a phone the held setup review is a page of its own (lab SETUPp); the choice made there survives Back.
  const [reviewPageOpen, setReviewPageOpen] = React.useState(false);
  const reviewEntryTarget = React.useRef<FocusReturnTarget>(null);
  const reviewFocusPending = React.useRef(false);
  const restoreReviewEntryFocus = useRestoreFocusToTrigger(reviewEntryTarget);
  const setupRun = useProjectSetupRun(workspace, controller.accountId);
  const setupReview = useProjectSetupReviewDecision(workspace, controller, setupRun);
  const { setScope: setReviewScope } = setupReview;
  React.useLayoutEffect(() => {
    if (reviewPageOpen || !reviewFocusPending.current) return;
    reviewFocusPending.current = false;
    restoreReviewEntryFocus();
  }, [reviewPageOpen, restoreReviewEntryFocus]);
  // Back keeps the choice made on the page; a review that is decided (anywhere) ends it with the page.
  const closeReviewPage = React.useCallback(() => {
    reviewFocusPending.current = true;
    setReviewPageOpen(false);
  }, []);
  React.useEffect(() => {
    if (!setupReview.reviewing) { setReviewPageOpen(false); setReviewScope(null); }
  }, [setupReview.reviewing, setReviewScope]);
  // Scripts are read on the checkout's machine: while it isn't answering, the last-known list stays and
  // the read waits with it (said once by the page above) instead of failing on its own.
  const reachability = useCheckoutReachability(workspace);
  const waiting = reachability.unreachable ? (
    <CheckoutUnreachableState
      reachability={reachability}
      size={read && 'value' in read ? 'line' : undefined}
      testID={`${testID}-unreachable`}
    />
  ) : null;
  // Under a last-known list the page's line already says it; on its own the list keeps one line.
  const inspectionFailure = waiting ? (reachability.announced && read && 'value' in read ? null : waiting)
    : (read && 'error' in read && read.error ? (
    <SurfaceStateCard
      kind="unavailable"
      size={'value' in read ? 'line' : undefined}
      title={t('projects.widgets.scriptsUnavailable')}
      diagnosticCode={read.error}
      action={{ label: t('common.retry'), onPress: retry, busy: 'value' in read && read.refreshing === true }}
      testID={`${testID}.inspection`}
    />
  ) : null);

  let content: React.ReactNode;
  let ownsScroll = false;
  if (waiting && !(read && read.key === key && 'value' in read)) {
    content = waiting;
  } else if (!read || read.key !== key) {
    content = (
      <SurfaceStateCard
        kind="loading"
        title={t('projects.scripts.definition.inspecting')}
        testID={`${testID}.inspection`}
      />
    );
  } else if (!('value' in read)) {
    content = inspectionFailure;
  } else if (page && phone && reviewPageOpen && setupReview.reviewing && read.value.definition.document?.status === 'valid') {
    ownsScroll = true;
    content = (
      <ProjectSetupReviewPage
        testID={`${testID}.setup.reviewPage`}
        manifest={read.value.definition.document.manifest}
        review={setupReview}
        onBack={closeReviewPage}
        onViewFile={() => { closeReviewPage(); setEditor({ key, seed: false, mode: 'raw' }); }}
      />
    );
  } else if (page && workersKey === key) {
    const document = read.value.definition.document;
    const manifestScripts = document?.status === 'valid' ? Object.entries(document.manifest.scripts ?? {}) : [];
    content = (
      <WorkspaceWorkerSettings
        testID={`${testID}.workers`}
        workspace={workspace}
        scripts={manifestScripts.map(([name, declaration]) => ({ name, portable: declaration.execution === 'portable' }))}
        onBack={() => setWorkersKey(null)}
      />
    );
  } else if (page && editor?.key === key && accountId && controller.client) {
    // The editor is a page of its own on every layout: the JSON view fills it below its header.
    ownsScroll = true;
    content = (
      <ProjectManifestEditor
        key={`${key}:${accountId}`}
        workspace={workspace}
        accountId={accountId}
        client={controller.client!}
        definition={read.value.definition}
        detection={read.value.detection}
        importCandidates={read.value.importCandidates}
        commands={read.value.commands}
        tools={read.value.tools}
        seedFromDetection={editor.seed}
        initialMode={editor.mode}
        onBack={() => setEditor(null)}
        onSaved={retry}
      />
    );
  } else {
    const openEditor = (seed: boolean, mode: 'form' | 'raw' = 'form') =>
      setEditor({ key, seed, mode });
    content = (
      <ProjectScriptsContent
        workspace={workspace}
        initialManagedConfiguration={initialManagedConfiguration}
        inspection={read.value}
        controller={controller}
        page={page}
        glance={glance}
        testID={testID}
        onEdit={page ? openEditor : null}
        onOpenWorkers={page ? () => setWorkersKey(key) : null}
        phoneReview={page && phone ? { open: () => setReviewPageOpen(true), entryTarget: reviewEntryTarget } : null}
        onOpenServices={onOpenServices}
        onRetry={retry}
      />
    );
  }

  // What waits on the person, with its one way in: the same notice every Action-approval page carries.
  const approval = controller.approvalId && controller.approvalPending ? (
    <ActionApprovalPendingNotice
      presentation="banner"
      testID={`${testID}.approval`}
      message={t('approvals.waitingForYou')}
      description={controller.approvalSummary}
      onOpenApproval={() => router.push(buildApprovalHref(controller.approvalId!, workspace.serverId))}
    />
  ) : null;
  if (!page)
    return (
      <ProjectCommandOutputHost scopeId={outputScopeId}>
        <View testID={testID} style={styles.body}>
          {approval}
          {read && 'value' in read ? inspectionFailure : null}
          {content}
        </View>
      </ProjectCommandOutputHost>
    );
  if (ownsScroll) return (
    <ProjectCommandOutputHost scopeId={outputScopeId}>
      <View testID={testID} style={styles.phoneEditor}>
        {approval}
        {read && 'value' in read ? inspectionFailure : null}
        {content}
      </View>
    </ProjectCommandOutputHost>
  );
  return (
    <ProjectCommandOutputHost scopeId={outputScopeId}>
      <ItemList testID={testID}>
        {approval}
        {read && 'value' in read ? inspectionFailure : null}
        {content}
      </ItemList>
    </ProjectCommandOutputHost>
  );
}

function useStableWorkspace(workspace: WorkspaceAddressV1): WorkspaceAddressV1 {
  return React.useMemo(
    () => ({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      machineId: workspace.machineId,
      rootPath: workspace.rootPath,
    }),
    [
      workspace.serverId,
      workspace.workspaceId,
      workspace.machineId,
      workspace.rootPath,
    ],
  );
}

/** The body below its host chrome; also drawn by the dev specimen with fixture inspections. */
export function ProjectScriptsContent(
  props: Readonly<{
    initialManagedConfiguration?: ManagedMachineConfigurationContinuation;
    workspace: WorkspaceAddressV1;
    inspection: ProjectDefinitionInspection;
    controller: ScriptsController;
    page: boolean;
    /** The Overview widget: scripts as glance rows (name and status), not the runnable sheet. */
    glance?: boolean;
    testID: string;
    onEdit: ((seed: boolean, mode?: 'form' | 'raw') => void) | null;
    /** Opens this checkout's Workers settings; null where the host has no room for the page. */
    onOpenWorkers?: (() => void) | null;
    phoneReview?: PhoneSetupReview | null;
    onOpenServices?: () => void;
    onRetry: () => void;
  }>,
) {
  const { definition, detection } = props.inspection;
  const document = definition.document;
  // Nix/devenv definitions are read once the environment is evaluated; that is a fact about the
  // environment, not a failed read, and Retry cannot change it.
  const unreadable = detection.diagnostics.filter((diagnostic) => diagnostic.code !== 'unevaluated_nix');
  const unevaluated = unreadable.length < detection.diagnostics.length;
  const partial = detection.coverage === 'partial' ? (
    <>
      {unreadable.length > 0 || !unevaluated ? (
        <AttentionBanner
          testID={`${props.testID}.partial`}
          tone="warning"
          title={t('projects.scripts.definition.partial')}
          details={unreadable.map(
            (diagnostic) => `${diagnostic.file}: ${diagnostic.code}`,
          )}
          action={{ label: t('common.retry'), onPress: props.onRetry }}
        />
      ) : null}
      {unevaluated ? (
        <AttentionBanner
          testID={`${props.testID}.unevaluated`}
          tone="neutral"
          title={t('projects.scripts.environment.unevaluated')}
        />
      ) : null}
    </>
  ) : null;
  if (document === null) {
    return (
      <>
        <FirstRun {...props} />
        {partial}
      </>
    );
  }
  if (document.status === 'invalid') {
    const diagnostic = document.diagnostics[0];
    return (
      <>
        <AttentionBanner
          testID={`${props.testID}.invalid`}
          tone="danger"
          title={t('projects.scripts.definition.invalid')}
          description={diagnostic?.message}
          action={
            props.onEdit
              ? {
                  label: t('projects.scripts.definition.openInEditor'),
                  testID: `${props.testID}.openEditor`,
                  onPress: () => props.onEdit?.(false, 'raw'),
                }
              : null
          }
        />
        <DetectedGroups {...props} detection={detection} manifest={null} />
        {partial}
      </>
    );
  }
  return (
    <>
      {/* Found scripts and services continue the list; Workers and Agents (settings) follow them. */}
      <DeclaredScripts {...props} manifest={document.manifest}>
        {partial}
        <FoundMore
          {...props}
          manifest={document.manifest}
          detection={detection}
        />
        <ServicesFound
          testID={props.testID}
          detection={detection}
          manifest={document.manifest}
          onOpenServices={props.onOpenServices}
        />
      </DeclaredScripts>
    </>
  );
}

/** Declared scripts in declaration order, Setup first because it gates the rest (lab PAGE / RAIL). */
function DeclaredScripts(
  props: Readonly<{
    initialManagedConfiguration?: ManagedMachineConfigurationContinuation;
    workspace: WorkspaceAddressV1;
    manifest: ProjectManifestV1;
    inspection: ProjectDefinitionInspection;
    controller: ScriptsController;
    page: boolean;
    glance?: boolean;
    testID: string;
    onEdit: ((seed: boolean, mode?: 'form' | 'raw') => void) | null;
    onOpenWorkers?: (() => void) | null;
    phoneReview?: PhoneSetupReview | null;
    /** Sections that continue the list (found scripts and services), before the settings sections. */
    children?: React.ReactNode;
  }>,
) {
  const machine = useServerScopedMachine(
    props.workspace.serverId,
    props.workspace.machineId,
  );
  const machineName =
    (machine ? getMachineSentenceName(machine) : null) ??
    props.workspace.machineId;
  const scripts = Object.entries(props.manifest.scripts ?? {});
  const hasPortable = scripts.some(([, declaration]) => declaration.execution === 'portable');
  // One read of the checkout's worker preference serves the Workers row and every Run on check.
  // The page also shows the one setting agents have (Scripts › Agents), so it always reads it.
  const workers = useWorkspaceWorkerPreference(props.workspace, { enabled: hasPortable || props.page });
  const preference = workers.state.kind === 'ready' ? workers.state.value.preference : null;
  const hasSetup =
    (props.manifest.workspace?.setup?.length ?? 0) > 0 ||
    (props.manifest.environment !== undefined &&
      props.manifest.environment.kind !== 'host');
  const setupRun = useProjectSetupRun(props.workspace, props.controller.accountId);
  const setupPresentation = presentProjectRun(setupRun, machineName, '');
  const setupReadiness = setupPresentation.live || props.controller.consent || props.controller.pendingKeys.setup
    ? undefined : props.inspection.setupReadiness;
  const setupReady = !hasSetup || setupReadiness?.kind === 'current' || setupReadiness?.kind === 'notRequired';
  const project =
    props.workspace.rootPath.split(/[\\/]/).filter(Boolean).pop() ??
    props.workspace.rootPath;
  const { theme } = useUnistyles();
  const columnMaxWidth = useLayoutMaxWidth();
  const environment = describeProjectEnvironment(props.manifest.environment ?? { kind: 'host' });
  const managed = props.manifest.environment !== undefined && props.manifest.environment.kind !== 'host';
  // Installed versions are inspection facts; without them the configuration file names the source.
  const versions = describeProjectToolVersions(props.inspection.tools).join(' · ');
  const meta = React.useMemo(() => [
    { key: 'file', text: '.happier/project.json', icon: <Icon name="file-text" size={14} color={theme.colors.text.secondary} /> },
    ...(managed || versions ? [{ key: 'environment',
      text: [environment.title, versions || environment.config].filter(Boolean).join(' · '),
      icon: <Icon name="wrench" size={14} color={theme.colors.text.secondary} /> }] : []),
  ], [environment.config, environment.title, managed, versions, theme.colors.text.secondary]);
  const phone = useDeviceType() === 'phone';
  const editButton = props.onEdit ? (
    <RoundButton
      size="normal"
      display="secondary"
      title={t('projects.scripts.editProjectFile')}
      testID={`${props.testID}.edit`}
      leading={<Icon name="file-text" size={14} />}
      onPress={() => props.onEdit?.(false)}
    />
  ) : undefined;
  return (
    <>
    {props.page ? (
      <HappierPageHeader
        title=""
        showTitle={false}
        columnMaxWidthPx={columnMaxWidth}
        renderText={renderPageHeaderText}
        // Phones carry the project's identity in the navigation header (lab PAGEp): the page opens on the
        // file and environment line, with Edit project file under it instead of squeezing the purpose line.
        description={phone ? undefined : hasSetup
          ? t('projects.scripts.purposeSetup', { project, machine: machineName })
          : t('projects.scripts.purpose', { project, machine: machineName })}
        meta={meta}
        actions={!phone ? editButton : undefined}
        details={phone && editButton ? <View style={styles.phoneEdit}>{editButton}</View> : undefined}
        testID={`${props.testID}.header`}
      />
    ) : null}
    {/* After setup authoring: which Session last wrote the project file (lab `s-setup` RESULT). */}
    <ProjectSetupAuthoredLine workspace={props.workspace} compact={!props.page} />
    {props.glance ? (
      // The Overview widget: Setup keeps its own row (it gates the rest); scripts follow as glance rows.
      <>
        {hasSetup ? (
          <ItemGroup surface="none">
            <SetupRow
              workspace={props.workspace}
              manifest={props.manifest}
              controller={props.controller}
              operation={setupRun}
              readiness={setupReadiness}
              compact
              phoneReview={null}
              testID={`${props.testID}.setup`}
              onViewFile={null}
            />
          </ItemGroup>
        ) : null}
        {scripts.length === 0 ? (
          <WidgetGlanceRow variant="fact" title={t('projects.scripts.noScripts')} testID={`${props.testID}.empty`} />
        ) : scripts.map(([name, declaration]) => (
          <DeclaredScriptRow
            key={name}
            testID={`${props.testID}.script:${name}`}
            workspace={props.workspace}
            name={name}
            manifest={props.manifest}
            declaration={declaration}
            invocation={findProjectInvocation(props.inspection, declaration.source)}
            controller={props.controller}
            compact
            glance
            preference={preference}
            idleText={setupReady ? t('projects.scripts.run.notRun') : props.controller.consent ? t('projects.scripts.run.waitsForSetup') : ''}
            showDivider={false}
          />
        ))}
      </>
    ) : (
    <ItemGroup>
      {hasSetup ? (
        <SetupRow
          workspace={props.workspace}
          manifest={props.manifest}
          controller={props.controller}
          operation={setupRun}
          readiness={setupReadiness}
          compact={!props.page}
          phoneReview={props.phoneReview ?? null}
          testID={`${props.testID}.setup`}
          onViewFile={props.onEdit ? () => props.onEdit?.(false, 'raw') : null}
        />
      ) : null}
      {scripts.length === 0 ? (
        <Item
          mode="info"
          title={t('projects.scripts.noScripts')}
          showChevron={false}
          testID={`${props.testID}.empty`}
        />
      ) : (
        scripts.map(([name, declaration], index) => (
          <DeclaredScriptRow
            key={name}
            testID={`${props.testID}.script:${name}`}
            workspace={props.workspace}
            name={name}
            manifest={props.manifest}
            declaration={declaration}
            invocation={findProjectInvocation(props.inspection, declaration.source)}
            controller={props.controller}
            compact={!props.page}
            glance={false}
            preference={preference}
            memoryDemand={resolveProjectMemoryDemandV1(declaration.memoryDemand, props.manifest.workspace?.memoryDemand)}
            initialManagedConfiguration={props.initialManagedConfiguration}
            onOpenWorkerSettings={props.onOpenWorkers ?? undefined}
            idleText={setupReady ? t('projects.scripts.run.notRun') : props.controller.consent ? t('projects.scripts.run.waitsForSetup') : ''}
            showDivider={index < scripts.length - 1}
          />
        ))
      )}
    </ItemGroup>
    )}
    {props.children}
    {props.page && hasPortable && props.onOpenWorkers ? (
      <WorkersSummarySection
        testID={`${props.testID}.workers`}
        workspace={props.workspace}
        preference={preference}
        onOpen={props.onOpenWorkers}
      />
    ) : null}
    {props.page ? (
      // What agents in Sessions on this checkout may do here (lab `s-agent` GUIDE, plan 30s3).
      <ItemGroup title={t('projects.scripts.agentsTitle')} description={t('projects.scripts.agentsDescription')}>
        <WorkspaceAdHocCommandsItem
          testID={`${props.testID}.agents.adHoc`}
          preference={preference}
          disabled={workers.state.kind !== 'ready' || workers.busy}
          onSave={(next) => { void workers.save(next); }}
        />
        <ProjectAgentGuidanceDisclosure
          testID={`${props.testID}.agents.guide`}
          workspace={props.workspace}
          // Regenerated when the project file or this checkout's worker preferences change.
          factsKey={JSON.stringify([props.inspection.definition.basis,
            workers.state.kind === 'ready' ? workers.state.value.revision : workers.state.kind])}
        />
      </ItemGroup>
    ) : null}
    </>
  );
}

/** Scripts › Workers (lab `s-workers RUNON`): this checkout's default, one row into its settings. */
function WorkersSummarySection(
  props: Readonly<{
    testID: string;
    workspace: WorkspaceAddressV1;
    preference: WorkspaceWorkerPreferenceV1 | null;
    onOpen: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const choice: ProjectExecutionChoiceV1 | null = props.preference?.destination
    ? { kind: 'workers', destination: props.preference.destination } : null;
  const label = useWorkerDestinationLabel(props.workspace.serverId, choice, props.workspace.machineId);
  const destination = props.preference?.destination;
  const summary = !props.preference
    ? t('projectWorkers.loading')
    : !props.preference.enabled || !destination
      ? t('projectWorkers.scriptsRowOff')
      : t('projectWorkers.scriptsRowOn', {
          destination: destination.kind === 'pool'
            ? t(destination.selection === 'ask' ? 'projectWorkers.scriptsRowAsk' : 'projectWorkers.scriptsRowAutomatic', { pool: label.name ?? '' })
            : label.name ?? '',
        });
  // One navigation row names itself ("Workers"); a section title above it would only repeat the word.
  return (
    <ItemGroup>
      <Item
        testID={props.testID}
        icon={<Icon name="stack" size={18} color={theme.colors.text.secondary} />}
        title={t('projectWorkers.scriptsRow')}
        subtitle={summary}
        onPress={props.onOpen}
      />
    </ItemGroup>
  );
}

function DeclaredScriptRow(
  props: Readonly<{
    initialManagedConfiguration?: ManagedMachineConfigurationContinuation;
    testID: string;
    workspace: WorkspaceAddressV1;
    name: string;
    manifest: ProjectManifestV1;
    declaration: NonNullable<ProjectManifestV1['scripts']>[string];
    invocation: ReturnType<typeof findProjectInvocation>;
    controller: ScriptsController;
    compact: boolean;
    /** The Overview widget's glance row (name and status, no source and no Run control). */
    glance: boolean;
    idleText: string;
    showDivider: boolean;
    preference: WorkspaceWorkerPreferenceV1 | null;
    memoryDemand?: ProjectMemoryDemandV1;
    onOpenWorkerSettings?: () => void;
  }>,
) {
  const rowKey = projectScriptRowKey(props.workspace, props.name);
  const operation = useProjectScriptRun(props.workspace, { kind: 'named', name: props.name }, props.controller.accountId);
  const source = describeProjectCommandSource(props.declaration.source, props.invocation);
  const resolvedChoice = resolveProjectExecutionChoiceV1({
    execution: props.declaration.execution ?? 'primary',
    scriptName: props.name,
    sourceMachineId: props.workspace.machineId,
    preference: props.preference ? { status: 'ready', value: props.preference } : { status: 'unavailable' },
  });
  const failure =
    props.controller.failure?.key === rowKey
      ? props.controller.failure.code
      : null;
  return (
    <ProjectScriptRow
      testID={props.testID}
      workspace={props.workspace}
      name={props.name}
      badge={props.glance ? null : source.badge}
      glance={props.glance}
      command={source.command ?? (source.target === props.name ? null : source.target)}
      portable={props.declaration.execution === 'portable'}
      operation={operation}
      idleText={props.idleText}
      pending={props.controller.pendingKeys[rowKey] === true}
      failureCode={failure}
      failureText={describeScriptEnvironmentRefusal(failure, props.manifest, props.declaration.source)}
      environmentName={nativeEnvironmentNameFor(props.manifest)}
      compact={props.compact}
      showDivider={props.showDivider}
      defaultChoice={resolvedChoice.status === 'resolved' ? resolvedChoice.choice : null}
      runChoice={props.controller.runChoices[rowKey]}
      onRunChoiceChange={(choice) => props.controller.chooseRunDestination(rowKey, choice)}
      memoryDemand={props.memoryDemand}
      initialManagedConfiguration={props.initialManagedConfiguration}
      choiceRequired={props.controller.choiceRequired?.key === rowKey}
      onChooseForRun={(choice) => { void props.controller.chooseForRun(choice); }}
      onDismissChoice={props.controller.dismissChoice}
      onOpenWorkerSettings={props.onOpenWorkerSettings}
      workerRefusal={props.controller.failure?.key === rowKey ? props.controller.failure.workerRefusal ?? null : null}
      managedCreation={props.controller.managedCreations[rowKey] ?? null}
      onCancelManagedRun={() => props.controller.cancelRun(rowKey)}
      onResumeManagedRun={() => { void props.controller.resumeManagedRun(rowKey); }}
      onRun={(choice, managed) => {
        void props.controller.run(rowKey, { kind: 'named', name: props.name }, choice, managed);
      }}
    />
  );
}

/**
 * The Setup row: its last preparation, Run setup / Run again (Stop while it runs), the review it opens
 * into (D18) and, after a run, that run's output. Compact hosts open the same review in place.
 */
function SetupRow(
  props: Readonly<{
    testID: string;
    workspace: WorkspaceAddressV1;
    manifest: ProjectManifestV1;
    controller: ScriptsController;
    operation: ReturnType<typeof useProjectSetupRun>;
    readiness: ProjectDefinitionInspection['setupReadiness'];
    compact: boolean;
    phoneReview: PhoneSetupReview | null;
    onViewFile: (() => void) | null;
  }>,
) {
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  const steps = props.manifest.workspace?.setup?.length ?? 0;
  const review = useProjectSetupReviewDecision(props.workspace, props.controller, props.operation);
  const reviewMachine = review.machine;
  const stop = props.controller.setupStop;
  const output = useProjectCommandOutputOpener();
  const environmentName = nativeEnvironmentNameFor(props.manifest);
  const presentation = presentProjectRun(
    props.operation,
    reviewMachine.machineName,
    t('projects.scripts.setup.steps', { count: steps }),
    environmentName,
  );
  const reviewing = review.reviewing;
  const failed = props.operation?.snapshot.state === 'failed';
  const stopping = stop.pending || stop.stopRequested;
  const stepCount = t('projects.scripts.setup.steps', { count: steps });
  // The review is the approval prompt: while it is on screen, held or opened by the person, Setup waits for them.
  const [open, setOpen] = React.useState(false);
  const expanded = props.compact
    ? props.controller.setupReviewOpen
    : props.controller.setupReviewOpen || reviewing || open;
  const showsOutput = !reviewing && Boolean(props.operation) && !props.compact;
  // While the review is on screen it owns Run: the row keeps only its disclosure caret, never a second Run.
  const inReview = reviewing || (expanded && !showsOutput && !presentation.live);
  const subtitle = inReview
    ? environmentName
      ? t('projects.scripts.environment.pending')
      : t('projects.scripts.setup.pending')
    : stopping
      ? t('projects.scripts.run.stopping')
      : failed
        ? t('projects.scripts.setup.failed')
        : props.readiness?.kind === 'current'
          ? `${projectSetupReadinessLine(props.readiness)} · ${stepCount}`
          // Setup states once what the script rows below wait for; the rows themselves stay quiet.
          : projectSetupReadinessLine(props.readiness ?? null, environmentName) ?? presentation.text;
  const pending = review.pending;
  const attachment = props.operation?.snapshot.domainRef?.kind === 'projectCommand' ? props.operation.snapshot.domainRef : null;
  const openOutput = () => {
    if (props.operation)
      void output.open(props.operation, { title: `${t('projects.scripts.setup.title')} · ${reviewMachine.machineName}`,
        name: t('projects.scripts.setup.title') });
  };
  // The review opens from the row or from a preparation that needs consent; it never runs anything.
  // On a phone the held review is a page of its own: the card keeps the waiting line and one way in.
  const phoneReview = reviewing ? props.phoneReview : null;
  // Run and Stop share one slot: a live setup can be stopped from its own row (lab `s-scripts` PAGE).
  const control = presentation.live ? (
    <RoundButton
      size="small"
      display="secondary"
      testID={`${props.testID}.stop`}
      loading={stop.pending}
      disabled={stopping || props.operation?.snapshot.cancellation !== 'supported'}
      title={stopping ? t('projects.scripts.run.stopping') : t('projects.scripts.setup.stop')}
      onPress={stop.requestStop}
    />
  ) : (
    <RoundButton
      size="small"
      display="secondary"
      testID={`${props.testID}.run`}
      loading={pending}
      disabled={pending}
      title={
        props.operation || props.readiness?.kind === 'current'
          ? t('projects.scripts.setup.runAgain')
          : t('projects.scripts.setup.run')
      }
      onPress={() => {
        void props.controller.prepare();
      }}
    />
  );
  // After a run the row opens into that run's output; a pending review (or no run yet) opens the review.
  const header = (headerProps?: Readonly<Record<string, unknown>>) => (
    <Item
      {...headerProps}
      testID={props.testID}
      icon={
        <Icon
          name="wrench"
          size={18}
          color={
            inReview
              ? theme.colors.state.attention.foreground
              : theme.colors.text.secondary
          }
        />
      }
      title={t('projects.scripts.setup.title')}
      // Waiting for the person's approval: the row head carries the attention tint (lab SETUP).
      pressableStyle={inReview ? { backgroundColor: theme.colors.state.attention.background } : undefined}
      subtitle={subtitle}
      subtitleStyle={failed && !stopping ? { color: theme.colors.status.error } : undefined}
      // The approval line names the environment and must not be cut on a phone.
      subtitleLines={inReview ? 2 : 1}
      showChevron={false}
      rightElementOutsidePressable
      accessoryLayout="inline"
      rightElement={
        phoneReview ? (
          <RoundButton
            size="small"
            display="secondary"
            testID={`${props.testID}.reviewEntry`}
            title={t('projects.scripts.setup.review')}
            controlRef={(target) => { phoneReview.entryTarget.current = target; }}
            onPress={phoneReview.open}
          />
        ) : inReview ? (
          <Icon name={expanded ? 'caret-up' : 'caret-down'} size={14} color={theme.colors.text.tertiary} />
        ) : (
          <View style={styles.setupTail}>
            {props.compact ? null : <Icon name={expanded ? 'caret-down' : 'caret-right'} size={14} color={theme.colors.text.tertiary} />}
            {control}
          </View>
        )
      }
    />
  );
  if (phoneReview) return header({ onPress: phoneReview.open });
  return (
    <>
      <ExpandableItem
        testID={`${props.testID}.disclosure`}
        expanded={expanded}
        onExpandedChange={(next) => {
          setOpen(next);
          if (next && props.compact) props.controller.openSetupReview();
          if (!next) props.controller.dismissConsent();
        }}
        header={({ headerProps }) =>
          header(headerProps as Readonly<Record<string, unknown>>)
        }
      >
        {showsOutput && props.operation ? (
          <ProjectCommandOutputFrame>
            {attachment?.terminalId ? (
              <ProjectCommandOutputPane
                operation={props.operation}
                ownerStatesExit
                title={t('projects.scripts.setup.title')}
                {...(output.opensInTerminal ? { onOpenInTerminal: openOutput } : { onOpenDetail: openOutput })}
              />
            ) : (
              <SurfaceStateCard
                size="line"
                kind="empty"
                title={t('projects.scripts.output.empty')}
                testID={`${props.testID}.noOutput`}
              />
            )}
          </ProjectCommandOutputFrame>
        ) : (
          <ProjectSetupReview
            testID={`${props.testID}.review`}
            manifest={props.manifest}
            machineName={reviewMachine.machineName}
            sharedRunAs={reviewMachine.sharedRunAs}
            pending={pending}
            reviewedEffect={review.reviewedEffect}
            scope={review.scope}
            onScopeChange={review.setScope}
            onRun={review.run}
            onNotNow={() => {
              setOpen(false);
              review.dismiss();
            }}
            onViewFile={() => props.onViewFile?.()}
          />
        )}
      </ExpandableItem>
      {failed && !reviewing && props.operation ? (
        // Setup failure keeps its output one press away (lab `s-scripts` STATES 6).
        <View style={styles.setupBanner}>
          <AttentionBanner
            testID={`${props.testID}.failed`}
            tone="danger"
            title={t('projects.scripts.setup.failed')}
            action={{ label: t('projects.scripts.setup.openOutput'), testID: `${props.testID}.openOutput`, onPress: openOutput }}
          />
        </View>
      ) : null}
    </>
  );
}

function isDeclared(
  manifest: ProjectManifestV1 | null,
  source: ProjectNativeRefV1,
): boolean {
  if (!manifest) return false;
  return (
    [
      ...Object.values(manifest.scripts ?? {}),
      ...Object.values(manifest.services ?? {}),
    ].some((declaration) =>
      isSameInputOptionValue(declaration.source, source),
    ) ||
    (manifest.workspace?.setup ?? []).some((step) =>
      isSameInputOptionValue(step, source),
    )
  );
}

/** Scripts found in the repository but not in the project file: one quiet disclosure, each one Add away. */
function FoundMore(
  props: Readonly<{
    workspace: WorkspaceAddressV1;
    manifest: ProjectManifestV1;
    detection: ProjectDefinitionDetectionV1;
    inspection: ProjectDefinitionInspection;
    page: boolean;
    controller: ScriptsController;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);
  const found = props.detection.entries.filter(
    (entry) =>
      entry.usage === 'script' && !isDeclared(props.manifest, entry.source),
  );
  if (found.length === 0 || !props.page) return null;
  return (
    <ItemGroup surface="none">
      <ExpandableItem
        testID={`${props.testID}.found.disclosure`}
        expanded={expanded}
        onExpandedChange={setExpanded}
        header={({ headerProps }) => (
          <Item
            {...(headerProps as Readonly<Record<string, unknown>>)}
            testID={`${props.testID}.found.header`}
            showDivider={false}
            icon={
              <Icon
                name="magnifying-glass"
                size={18}
                color={theme.colors.text.secondary}
              />
            }
            title={(
              <Text numberOfLines={2} style={[styles.inlineTitle, { color: theme.colors.text.secondary }]}>
                <Text style={[styles.inlineTitle, styles.strong, { color: theme.colors.text.primary }]}>
                  {t('projects.scripts.foundMore', { count: found.length })}
                </Text>
                {' '}{t('projects.scripts.foundIn', { files: joinProjectFiles(found.map((entry) => entry.source.file)) })}
              </Text>
            )}
            rightElement={<Icon name={expanded ? 'caret-up' : 'caret-down'} size={14} color={theme.colors.text.tertiary} />}
            showChevron={false}
          />
        )}
      >
        {found.map((entry, index) => {
          const id = JSON.stringify(entry.source);
          return (
            <Item
              key={id}
              testID={`${props.testID}.detected:${index}`}
              mode="info"
              showChevron={false}
              showDivider={index < found.length - 1}
              icon={
                <Icon
                  name="circle"
                  size={18}
                  color={theme.colors.text.tertiary}
                />
              }
              title={entry.source.target}
              subtitle={(() => {
                const command = describeProjectCommandSource(entry.source, findProjectInvocation(props.inspection, entry.source)).command;
                return command ? (
                  <Text testID={`${props.testID}.detected:${index}.command`} numberOfLines={1} style={[styles.inlineMeta, styles.mono, { color: theme.colors.text.secondary }]}>{command}</Text>
                ) : undefined;
              })()}
              titleAccessory={
                <StatusPill
                  variant="neutral"
                  hideDot
                  label={describeProjectCommandSource(entry.source).badge ?? entry.source.file}
                  labelStyle={styles.mono}
                  style={styles.badge}
                />
              }
              rightElement={
                <RoundButton
                  size="small"
                  display="secondary"
                  title={t('projects.scripts.addToProjectFile')}
                  testID={`${props.testID}.detected:${index}.add`}
                  loading={props.controller.pendingKeys[`add:${id}`] === true}
                  disabled={Object.keys(props.controller.pendingKeys).length > 0}
                  onPress={() => {
                    void props.controller.add(`add:${id}`, props.inspection.definition, entry.source);
                  }}
                />
              }
              rightElementOutsidePressable
            />
          );
        })}
        <Text style={[styles.note, { color: theme.colors.text.tertiary }]}>
          {t('projects.scripts.foundNote')}
        </Text>
      </ExpandableItem>
    </ItemGroup>
  );
}

function ServicesFound(
  props: Readonly<{
    testID: string;
    detection: ProjectDefinitionDetectionV1;
    manifest: ProjectManifestV1 | null;
    onOpenServices?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const services = props.detection.entries.filter(
    (entry) =>
      entry.usage === 'service' && !isDeclared(props.manifest, entry.source),
  );
  if (services.length === 0 || !props.onOpenServices) return null;
  return (
    <ItemGroup surface="none">
      <Item
        testID={`${props.testID}.services.open`}
        showDivider={false}
        icon={
          <Icon
            name="hard-drives"
            size={18}
            color={theme.colors.text.secondary}
          />
        }
        title={(
          <Text numberOfLines={2} style={[styles.inlineTitle, { color: theme.colors.text.secondary }]}>
            <Text style={[styles.inlineTitle, styles.strong, { color: theme.colors.text.primary }]}>
              {t('projects.scripts.servicesFound', { count: services.length })}
            </Text>
            {' '}{t('projects.scripts.foundIn', { files: joinProjectFiles(services.map((entry) => entry.source.file)) })}
          </Text>
        )}
        detail={t('projects.scripts.reviewInServices')}
        onPress={props.onOpenServices}
      />
    </ItemGroup>
  );
}

/** No project file yet (lab FIRST): what can already run, grouped by the file it came from. */
function FirstRun(
  props: Readonly<{
    workspace: WorkspaceAddressV1;
    inspection: ProjectDefinitionInspection;
    controller: ScriptsController;
    page: boolean;
    testID: string;
    onEdit: ((seed: boolean, mode?: 'form' | 'raw') => void) | null;
    onOpenServices?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  // Phones recompose the hero (lab FIRSTp): mark above the title, both ways forward full width.
  const phone = useDeviceType() === 'phone';
  const authoring = useProjectSetupAuthoring({
    workspace: props.workspace,
    page: 'scripts',
  });
  const setup = useSetupOpening(
    authoring.onSetUpWithAgent,
    projectDefinitionInspectionKey(props.workspace),
  );
  const detected = props.inspection.detection.entries;
  const runnable = detected.filter((entry) => entry.usage === 'script');
  // The hero and groups share the page's reading column with every section below it.
  const column = useLayoutMaxWidthStyle();
  const columnMaxWidth = useLayoutMaxWidth();
  const files = joinProjectFiles(detected.map((entry) => entry.source.file));
  const setupButton = authoring.hasQualifiedCheckout ? (
    <RoundButton
      testID={`${props.testID}.setup`}
      size={phone && props.page ? 'normal' : 'small'}
      display={props.page ? 'secondary' : 'inverted'}
      title={
        setup.pending
          ? t('projects.authoring.opening')
          : t('projects.authoring.open')
      }
      leading={
        <Icon name="sparkle" size={14} color={theme.colors.text.primary} />
      }
      disabled={setup.pending}
      onPress={setup.open}
    />
  ) : null;
  // The refusal reads beside the button that failed, with the reason's own words (never one generic error).
  const setupFailure = setup.reason ? (
    <SurfaceStateCard
      testID={`${props.testID}.setup.failure`}
      size="line"
      kind="unavailable"
      title={t(describeProjectAuthoringOpenFailure(setup.kind, setup.reason).titleKey)}
      diagnosticCode={setup.reason}
    />
  ) : null;
  return (
    <View style={[styles.column, column]}>
      {props.page ? (
        <HappierPageHeader
          title={t('projects.widgets.noProjectFile')}
          description={t('projects.widgets.noProjectFileBody', { count: runnable.length })}
          // An identity-mark slot centres on the whole text block; on a phone that indents the hero
          // and floats the glyph mid-block, so the title leads at the column edge (lab FIRSTp) and the
          // selected Scripts tab carries the glyph.
          leading={phone ? undefined : <Icon name="play" size={22} color={theme.colors.text.secondary} />}
          details={(
            <>
            <View style={phone ? styles.actionsPhone : styles.actions}>
              {props.onEdit ? (
                <RoundButton
                  testID={`${props.testID}.create`}
                  size={phone ? 'normal' : 'small'}
                  title={t('projects.scripts.createProjectFile')}
                  onPress={() => props.onEdit?.(true)}
                />
              ) : null}
              {setupButton}
            </View>
            {setupFailure}
            </>
          )}
          columnMaxWidthPx={columnMaxWidth}
          renderText={renderPageHeaderText}
          testID={`${props.testID}.noProjectFile`}
        />
      ) : runnable.length > 0 ? (
        <View testID={`${props.testID}.found`} style={styles.found}>
          <Text
            style={[styles.foundText, { color: theme.colors.text.secondary }]}
          >
            {t('projects.widgets.scriptsFound', {
              count: runnable.length,
              files,
            })}
          </Text>
          <View style={styles.actions}>{setupButton}</View>
          {setupFailure}
        </View>
      ) : null}
      {detected.length === 0 ? (
        // On the page the hero above already says nothing was found and offers the next step.
        props.page ? null : (
          <SurfaceStateCard
            testID={`${props.testID}.empty`}
            kind="empty"
            title={t('projects.widgets.scriptsEmpty')}
          />
        )
      ) : (
        <DetectedGroups
          {...props}
          detection={props.inspection.detection}
          manifest={null}
        />
      )}
      {props.page && detected.length > 0 ? (
        <Text style={[styles.note, { color: theme.colors.text.tertiary }]}>
          {t('projects.widgets.scriptsFoundBy', { files })}
        </Text>
      ) : null}
    </View>
  );
}

/** The tool beside a file group ("1 · mise"); omitted when it would only repeat the file name. */
function groupToolLabel(source: ProjectNativeRefV1, file: string): string | null {
  const label = source.kind === 'native' ? describeProjectTool(source.tool) : source.adapter.localId;
  return label === file.split(/[\\/]/).pop() ? null : label;
}

/** Found references by declaring file; scripts run directly (native, no import), services point to Services. */
function DetectedGroups(
  props: Readonly<{
    workspace: WorkspaceAddressV1;
    inspection: ProjectDefinitionInspection;
    detection: ProjectDefinitionDetectionV1;
    manifest: ProjectManifestV1 | null;
    controller: ScriptsController;
    page: boolean;
    testID: string;
    onOpenServices?: () => void;
  }>,
) {
  const groups = React.useMemo(() => {
    const byFile = new Map<
      string,
      ProjectDefinitionDetectionV1['entries'][number][]
    >();
    for (const entry of props.detection.entries) {
      if (entry.usage === 'setup' || isDeclared(props.manifest, entry.source))
        continue;
      byFile.set(entry.source.file, [
        ...(byFile.get(entry.source.file) ?? []),
        entry,
      ]);
    }
    return [...byFile.entries()];
  }, [props.detection.entries, props.manifest]);
  const { theme } = useUnistyles();
  // A widget keeps its card's footprint (lab p-overview HOME: a few rows, never the whole list); the
  // Scripts page lists everything. The rest is counted once under the rows.
  const frameRows = React.useContext(WidgetFrameBodyRowsContext);
  const rowBudget = props.page ? Number.POSITIVE_INFINITY : Math.max(WIDGET_SCRIPT_ROWS, frameRows ?? 0);
  const total = groups.reduce((sum, [, entries]) => sum + entries.length, 0);
  let remaining = rowBudget;
  const shownGroups = groups.flatMap(([file, entries]) => {
    if (remaining <= 0) return [];
    const shown = entries.slice(0, remaining);
    remaining -= shown.length;
    return [[file, shown, entries.length] as const];
  });
  const hiddenCount = total - shownGroups.reduce((sum, [, shown]) => sum + shown.length, 0);
  let index = 0;
  const rendered = shownGroups.map(([file, entries, fileTotal]) => (
    <ItemGroupColumn key={file}>
      <ItemGroup
        title={
          <View style={styles.groupTitle}>
            <StatusPill
              variant="neutral"
              hideDot
              label={file}
              labelStyle={styles.mono}
            />
            <Text style={styles.groupMeta}>
              {groupToolLabel(entries[0]!.source, file)
                ? t('projects.scripts.foundCount', { count: fileTotal, tool: groupToolLabel(entries[0]!.source, file)! })
                : String(fileTotal)}
            </Text>
          </View>
        }
      >
        {entries.map((entry, position) => (
          <DetectedRow
            key={JSON.stringify(entry.source)}
            testID={`${props.testID}.detected:${index++}`}
            workspace={props.workspace}
            entry={entry}
            invocation={findProjectInvocation(props.inspection, entry.source)}
            controller={props.controller}
            compact={!props.page}
            onOpenServices={props.onOpenServices}
            showDivider={position < entries.length - 1}
          />
        ))}
      </ItemGroup>
    </ItemGroupColumn>
  ));
  return (
    <>
      <ItemGroupColumns columns={props.page ? 2 : 1} paddingHorizontal={0} paddingVertical={0}>{rendered}</ItemGroupColumns>
      {hiddenCount > 0 ? (
        <Text testID={`${props.testID}.detected.more`} style={[styles.note, { color: theme.colors.text.tertiary }]}>
          {t('projects.scripts.foundMore', { count: hiddenCount })}
        </Text>
      ) : null}
    </>
  );
}

/** The fewest rows a Scripts widget shows (lab p-overview HOME: three scripts), more when its frame has room. */
const WIDGET_SCRIPT_ROWS = 3;

function DetectedRow(
  props: Readonly<{
    testID: string;
    workspace: WorkspaceAddressV1;
    entry: ProjectDefinitionDetectionV1['entries'][number];
    invocation: ReturnType<typeof findProjectInvocation>;
    controller: ScriptsController;
    compact: boolean;
    showDivider: boolean;
    onOpenServices?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const rowKey = projectScriptRowKey(
    props.workspace,
    `native:${JSON.stringify(props.entry.source)}`,
  );
  const operation = useProjectScriptRun(props.workspace, { kind: 'native', source: props.entry.source }, props.controller.accountId);
  if (props.entry.usage === 'service') {
    return (
      <Item
        testID={props.testID}
        showDivider={props.showDivider}
        icon={
          <Icon
            name="hard-drives"
            size={18}
            color={theme.colors.text.secondary}
          />
        }
        title={props.entry.source.target}
        titleAccessory={
          <Text
            style={[
              styles.groupMeta,
              styles.badge,
              { color: theme.colors.text.tertiary },
            ]}
          >
            {t('projects.scripts.service')}
          </Text>
        }
        detail={
          props.onOpenServices ? t('projects.scripts.openServices') : undefined
        }
        mode={props.onOpenServices ? 'interactive' : 'info'}
        showChevron={Boolean(props.onOpenServices)}
        {...(props.onOpenServices ? { onPress: props.onOpenServices } : {})}
      />
    );
  }
  const failure =
    props.controller.failure?.key === rowKey
      ? props.controller.failure.code
      : null;
  return (
    <ProjectScriptRow
      testID={props.testID}
      workspace={props.workspace}
      name={props.entry.source.target}
      badge={null}
      command={describeProjectCommandSource(props.entry.source, props.invocation).command}
      portable={false}
      operation={operation}
      // Found-by-reading rows say nothing about runs; the page footnote says once that nothing has run.
      idleText=""
      pending={props.controller.pendingKeys[rowKey] === true}
      failureCode={failure}
      compact={props.compact}
      showDivider={props.showDivider}
      onRun={() => {
        void props.controller.run(rowKey, {
          kind: 'native',
          source: props.entry.source,
        });
      }}
    />
  );
}

/** One pending opening per checkout; its outcome stays with the checkout that asked. */
function useSetupOpening(
  onSetUpWithAgent: ReturnType<
    typeof useProjectSetupAuthoring
  >['onSetUpWithAgent'],
  key: string,
) {
  const currentKey = React.useRef<string | null>(key);
  currentKey.current = key;
  React.useEffect(() => {
    currentKey.current = key;
    return () => {
      currentKey.current = null;
    };
  }, [key]);
  const [opening, setOpening] = React.useState<Readonly<{
    key: string;
    pending: boolean;
    kind?: string;
    reason?: string;
  }> | null>(null);
  const mine = opening?.key === key ? opening : null;
  const open = async () => {
    if (mine?.pending) return;
    setOpening({ key, pending: true });
    try {
      const result = await onSetUpWithAgent();
      const acknowledgement = result.ok
        ? SessionAuthoringOpenResultV1Schema.safeParse(result.result)
        : null;
      const awaitingApproval = result.ok && ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success;
      const kind = awaitingApproval ? 'pending' : acknowledgement?.success && acknowledgement.data.kind !== 'opened'
        ? acknowledgement.data.kind : undefined;
      const reason = !result.ok
        ? result.errorCode
        : awaitingApproval ? 'approval_required' : !acknowledgement?.success
          ? 'project_authoring_invalid_result'
          : acknowledgement.data.kind === 'opened'
            ? undefined
            : acknowledgement.data.reason === 'aborted' ? undefined : acknowledgement.data.reason;
      if (currentKey.current === key)
        setOpening({ key, pending: false, ...(reason ? { kind, reason } : {}) });
    } catch {
      if (currentKey.current === key)
        setOpening({ key, pending: false, reason: 'project_authoring_failed' });
    }
  };
  return {
    pending: mine?.pending === true,
    kind: mine?.kind,
    reason: mine?.reason ?? null,
    open,
  };
}

const styles = StyleSheet.create((theme) => ({
  phoneEditor: { flex: 1, minHeight: 0 },
  body: { gap: theme.space.s12 },
  phoneEdit: { alignSelf: 'flex-start', marginTop: theme.space.s10, marginBottom: theme.space.s8 },
  setupTail: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s10 },
  setupBanner: { marginHorizontal: theme.space.s16, marginBottom: theme.space.s12 },
  inlineTitle: { ...Typography.default(), ...happierPageTextMetrics('rowTitle') },
  inlineMeta: { ...Typography.default(), ...happierPageTextMetrics('rowDescription') },
  strong: { ...Typography.default('semiBold') },
  column: { width: '100%', alignSelf: 'center' },
  groupTitle: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8, marginTop: theme.space.s8 },
  actionsPhone: { gap: theme.space.s8, marginTop: theme.space.s8 },
  found: { gap: theme.space.s4 },
  foundText: {
    ...Typography.default(),
    ...happierPageTextMetrics('sectionDescription'),
  },
  note: {
    ...Typography.default(),
    ...happierPageTextMetrics('sectionDescription'),
    paddingHorizontal: PAGE_LIST_METRICS.pageTextInsetPx,
    paddingVertical: theme.space.s8,
  },
  mono: { ...Typography.mono() },
  badge: { marginLeft: theme.space.s8 },
  groupMeta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    marginLeft: theme.space.s8,
  },
}));
