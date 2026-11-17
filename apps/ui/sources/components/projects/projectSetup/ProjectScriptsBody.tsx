import * as React from 'react';
import type { ProjectDefinitionInspectRead } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ProjectManifestFileSnapshotSchema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPageHeader, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { WidgetFrameBodyRowsContext } from '@/components/widgets/frame/widgetFrameBody';
import { NearViewportWindow } from '@/components/widgets/NearViewportWindow';
import { PAGE_ROW_TOUCH_MIN_HEIGHT_PX } from '@/components/ui/lists/pageRowMetrics';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectExecutionChoiceV1, WorkspaceWorkerPreferenceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { resolveProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { resolveProjectMemoryDemandV1, type ProjectMemoryDemandV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectMemoryDemandV1';
import type {
  ProjectDefinitionDetectionV1,
  ProjectManifestV1,
  ProjectNativeRefV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { SessionAuthoringOpenResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
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
import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useLayoutMaxWidth, useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { renderPageHeaderText } from '@/components/ui/layout/PageHeader';
import { projectSetupReadinessLine } from './projectSetupReadinessLine';
import { describeScriptToolchainRefusal, nativeToolchainNameFor } from './projectToolchainPresentation';
import { useDeviceType } from '@/utils/platform/responsive';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useServerCredentialAccountScopeBindings, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ProjectEffectiveDefinitionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectDefinitionCompositionV1';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { readProjectEffectiveDefinition } from './projectEffectiveDefinition';
import { readProjectSetupLayers } from './projectSetupLayers';
import { openProjectSharedSetupUpdate } from './ProjectSharedSetupUpdateSheet';
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
  describeProjectToolchain,
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
import { ProjectEnvironmentBindings } from './ProjectEnvironmentBindings';
import { DetectedRow, FoundScriptReferenceRow } from './ProjectDetectedScriptRow';
import { ProjectSetupReview } from './ProjectSetupReview';
import { ProjectSetupReviewPage, useProjectSetupReviewDecision } from './ProjectSetupReviewPage';
import { useRestoreFocusToTrigger, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { ProjectSetupAuthoredLine } from './ProjectSetupReturn';
import { InlineCode } from '@/components/ui/text/InlineCode';
import { WorkspaceAdHocCommandsItem } from '@/components/projects/workers/WorkspaceAdHocCommandsItem';
import { ProjectAgentGuidanceDisclosure, PROJECT_SCRIPT_RUN_COMMAND } from '@/components/projects/workers/ProjectAgentGuidanceDisclosure';
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
  /** The Overview widget's Review: opens the Scripts page, where found scripts are read and run. */
  onOpenScripts?: () => void;
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
  onOpenScripts,
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
  const [editor, setEditor] = React.useState<EditorState>(null);
  const frameRows = React.useContext(WidgetFrameBodyRowsContext);
  const detectedRows = Math.max(WIDGET_SCRIPT_ROWS, frameRows ?? 0);
  const selection = React.useMemo<ProjectDefinitionInspectRead>(() => presentation === 'page'
    ? { kind: editor?.key === key ? editor.seed ? 'create' : 'editor' : 'scripts' }
    : { kind: presentation === 'widget' ? 'overview' : 'rail', detectedRows }, [detectedRows, editor?.key, editor?.seed, key, presentation]);
  const { read, retry } = useProjectDefinitionInspection(workspace, binding, selection);
  const runChoiceKeys = React.useMemo(() => {
    if (!read || !('value' in read)) return undefined;
    const document = read.value.definition.document;
    return document?.status === 'valid' ? Object.entries(document.manifest.scripts ?? {})
      .filter(([, declaration]) => declaration.execution === 'portable')
      .map(([name]) => projectScriptRowKey(workspace, name)) : [];
  }, [read, workspace]);
  const controller = useProjectScriptsController(workspace, retry, binding, { runChoiceKeys, environmentBindingsEnabled: presentation !== 'widget' });
  const router = useRouter();
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
    content = page ? <ConstrainedScreenContent>{waiting}</ConstrainedScreenContent> : waiting;
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
        definition={ProjectManifestFileSnapshotSchema.parse(read.value.definition)}
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
        binding={binding}
        controller={controller}
        page={page}
        glance={glance}
        testID={testID}
        onEdit={page ? openEditor : null}
        onOpenWorkers={page ? () => setWorkersKey(key) : null}
        phoneReview={page && phone ? { open: () => setReviewPageOpen(true), entryTarget: reviewEntryTarget } : null}
        onOpenServices={onOpenServices}
        onOpenScripts={glance ? onOpenScripts : undefined}
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
    /** The Account reading this checkout; names a shared setup's Source. Absent in the dev specimen. */
    binding?: ServerCredentialAccountScopeBinding | null;
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
    onOpenScripts?: () => void;
    onRetry: () => void;
  }>,
) {
  const { definition, detection } = props.inspection;
  const document = definition.document;
  const effective = readProjectEffectiveDefinition(props.inspection);
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
          title={t('projects.scripts.toolchain.unevaluated')}
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
        <DetectedGroups {...props} detection={detection} />
        {props.page ? <ServicesFound testID={props.testID} detection={detection}
          summary={props.inspection.detectionSummary} onOpenServices={props.onOpenServices} /> : null}
        {partial}
      </>
    );
  }
  return (
    <>
      {/* Found scripts and services continue the list; Workers and Agents (settings) follow them. */}
      {/* The Machine runs the composed definition (repository, shared setup, changes just for you), so the
          page lists that; the repository's own bytes belong to the editor. */}
      <DeclaredScripts {...props} manifest={effective.kind === 'available' && effective.value.effectiveManifest
        ? effective.value.effectiveManifest : document.manifest}
        layersDefinition={effective.kind === 'available' ? effective.value : null}>
        {partial}
        <FoundMore
          {...props}
          detection={detection}
        />
        <ServicesFound
          testID={props.testID}
          detection={detection}
          summary={props.page ? props.inspection.detectionSummary : undefined}
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
    /** The composed definition's origins and shared basis, when the Machine sent them. */
    layersDefinition?: ProjectEffectiveDefinitionV1 | null;
    binding?: ServerCredentialAccountScopeBinding | null;
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
    (props.manifest.toolchain !== undefined &&
      props.manifest.toolchain.kind !== 'host');
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
  const toolchain = describeProjectToolchain(props.manifest.toolchain ?? { kind: 'host' });
  const managed = props.manifest.toolchain !== undefined && props.manifest.toolchain.kind !== 'host';
  // Installed versions are inspection facts; without them the configuration file names the source.
  const versions = describeProjectToolVersions(props.inspection.tools).join(' · ');
  const sharedSourceId = props.layersDefinition?.sharedBasis?.sourceId ?? null;
  const sharedSource = useProjectSource(props.page ? props.binding ?? null : null, sharedSourceId);
  const sharedName = sharedSource.source?.source.name ?? null;
  const layers = React.useMemo(() => readProjectSetupLayers(props.layersDefinition ?? null, sharedName),
    [props.layersDefinition, sharedName]);
  const meta = React.useMemo(() => [
    { key: 'file', text: '.happier/project.json', icon: <Icon name="file-text" size={14} color={theme.colors.text.secondary} /> },
    ...(managed || versions ? [{ key: 'toolchain',
      text: [toolchain.title, versions || toolchain.config].filter(Boolean).join(' · '),
      icon: <Icon name="wrench" size={14} color={theme.colors.text.secondary} /> }] : []),
    // One fact per layer that isn't the repository's own (lab L6 header meta).
    ...(layers.sharedSourceId ? [{ key: 'shared', text: sharedName
      ? t('projects.scripts.layers.shared', { name: sharedName }) : t('projects.scripts.layers.sharedUnnamed'),
      icon: <Icon name="users" size={14} color={theme.colors.text.secondary} /> }] : []),
    ...(layers.personalChanges > 0 ? [{ key: 'personal',
      text: t('projects.scripts.layers.personal', { count: layers.personalChanges }),
      icon: <Icon name="user-circle" size={14} color={theme.colors.text.secondary} /> }] : []),
  ], [toolchain.config, toolchain.title, managed, versions, theme.colors.text.secondary, layers, sharedName]);
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
  const binding = props.binding ?? null;
  const decideSharedSetupUpdate = props.controller.decideSharedSetupUpdate;
  const sharedMenu = props.page && sharedSourceId && binding ? (
    <ProjectSetupHeaderMenu testID={`${props.testID}.more`} onCheckShared={() => openProjectSharedSetupUpdate({
      workspace: props.workspace, binding, sourceId: sharedSourceId, sourceName: sharedName, machineName,
      decide: decideSharedSetupUpdate })} />
  ) : null;
  // Without a shared setup the header keeps its one action; the "…" joins it only when there is something to offer.
  const headerActions = sharedMenu ? <View style={styles.headerActions}>{editButton}{sharedMenu}</View> : editButton;
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
        actions={!phone ? headerActions : undefined}
        details={phone && headerActions ? <View style={styles.phoneEdit}>{headerActions}</View> : undefined}
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
            invocation={props.glance ? findProjectInvocation(props.inspection, declaration.source) : undefined}
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
          layerOf={layers.sharedSourceId || layers.personalChanges > 0 ? layers.layerOf : null}
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
            invocation={props.glance ? findProjectInvocation(props.inspection, declaration.source) : undefined}
            origin={layers.originOf(['scripts', name])}
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
    {props.page ? <ProjectEnvironmentBindings testID={`${props.testID}.environment`}
      manifest={props.manifest} controller={props.controller.environmentBindings} /> : null}
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
      <ItemGroup title={t('projects.scripts.agentsTitle')} description={(
        <>
          {t('projects.scripts.agentsDescriptionBefore')}
          <InlineCode>{PROJECT_SCRIPT_RUN_COMMAND}</InlineCode>
          {t('projects.scripts.agentsDescriptionAfter')}
        </>
      )}>
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
    origin?: string | null;
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
    <>
    <ProjectScriptRow
      testID={props.testID}
      workspace={props.workspace}
      name={props.name}
      badge={props.glance ? null : source.badge}
      glance={props.glance}
      command={source.command ?? (source.target === props.name ? null : source.target)}
      origin={props.origin ?? null}
      nativeSource={props.declaration.source.kind === 'command' ? undefined : props.declaration.source}
      accountId={props.controller.accountId}
      portable={props.declaration.execution === 'portable'}
      operation={operation}
      idleText={props.idleText}
      pending={props.controller.pendingKeys[rowKey] === true}
      failureCode={failure}
      failureText={failure === 'project_environment_binding_unavailable' ? t('projects.scripts.environment.refused')
        : describeScriptToolchainRefusal(failure, props.manifest, props.declaration.source)}
      toolchainName={nativeToolchainNameFor(props.manifest)}
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
    {!props.glance && (failure === 'project_environment_binding_unavailable'
      || operation?.snapshot.error?.errorCode === 'project_environment_binding_unavailable') ? (
      <ProjectEnvironmentBindings recovery testID={`${props.testID}.environment`}
        manifest={props.manifest} controller={props.controller.environmentBindings} />
    ) : null}
    </>
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
    /** Each effect line's layer, when the project's setup has more than the repository file. */
    layerOf?: ((path: readonly string[]) => string | null) | null;
  }>,
) {
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  const steps = props.manifest.workspace?.setup?.length ?? 0;
  const review = useProjectSetupReviewDecision(props.workspace, props.controller, props.operation);
  const reviewMachine = review.machine;
  const stop = props.controller.setupStop;
  const output = useProjectCommandOutputOpener(props.operation);
  const toolchainName = nativeToolchainNameFor(props.manifest);
  const presentation = presentProjectRun(
    props.operation,
    reviewMachine.machineName,
    t('projects.scripts.setup.steps', { count: steps }),
    toolchainName,
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
    ? toolchainName
      ? t('projects.scripts.toolchain.pending')
      : t('projects.scripts.setup.pending')
    : stopping
      ? t('projects.scripts.run.stopping')
      : failed
        ? t('projects.scripts.setup.failed')
        : props.readiness?.kind === 'current'
          ? `${projectSetupReadinessLine(props.readiness)} · ${stepCount}`
          // Setup states once what the script rows below wait for; the rows themselves stay quiet.
          : projectSetupReadinessLine(props.readiness ?? null, toolchainName) ?? presentation.text;
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
          <DisclosureCaret expanded={expanded} size={14} />
        ) : (
          <View style={styles.setupTail}>
            {props.compact || phone ? null : <DisclosureCaret expanded={expanded} size={14} />}
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
            sharedTrustDetail={reviewMachine.sharedTrustDetail}
            pending={pending}
            reviewedEffect={review.reviewedEffect}
            layerOf={props.layerOf ?? null}
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

/** Scripts found in the repository but not in the project file: one quiet disclosure, each one Add away. */
function FoundMore(
  props: Readonly<{
    workspace: WorkspaceAddressV1;
    detection: ProjectDefinitionDetectionV1;
    inspection: ProjectDefinitionInspection;
    page: boolean;
    controller: ScriptsController;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);
  const page = useFoundRowPage();
  const found = React.useMemo(() => {
    const rows = props.detection.entries.filter(entry => entry.usage === 'script')
      .map(entry => ({ source: entry.source, id: JSON.stringify(entry.source) }));
    return { rows, files: joinProjectFiles(rows.map(row => row.source.file)) };
  }, [props.detection.entries]);
  const disabled = Object.keys(props.controller.pendingKeys).length > 0;
  if (found.rows.length === 0 || !props.page) return null;
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
                  {t('projects.scripts.foundMore', { count: found.rows.length })}
                </Text>
                {' '}{t('projects.scripts.foundIn', { files: found.files })}
              </Text>
            )}
          />
        )}
      >
        {found.rows.slice(0, page.rows).map((row, index, shown) => (
            <FoundScriptReferenceRow
              key={row.id}
              workspace={props.workspace}
              accountId={props.controller.accountId}
              source={row.source}
              id={row.id}
              testID={`${props.testID}.detected:${index}`}
              showDivider={index < shown.length - 1}
              pending={props.controller.pendingKeys[`add:${row.id}`] === true}
              disabled={disabled}
              add={props.controller.add}
            />
        ))}
        {found.rows.length > page.rows ? (
          <FoundShowMore testID={`${props.testID}.found.showMore`} hidden={found.rows.length - page.rows} onPress={page.more} />
        ) : null}
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
    summary?: ProjectDefinitionInspection['detectionSummary'];
    onOpenServices?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { count, files } = React.useMemo(() => {
    if (props.summary) return {
      count: props.summary.services,
      files: joinProjectFiles(props.summary.files.filter(file => file.services > 0).map(file => file.file)),
    };
    const services = props.detection.entries.filter(entry => entry.usage === 'service');
    return { count: services.length, files: joinProjectFiles(services.map(entry => entry.source.file)) };
  }, [props.detection.entries, props.summary]);
  if (count === 0 || !props.onOpenServices) return null;
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
              {t('projects.scripts.servicesFound', { count })}
            </Text>
            {' '}{t('projects.scripts.foundIn', { files })}
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
    /** The Overview widget: a summary of what was found and the ways forward, never the runnable list. */
    glance?: boolean;
    testID: string;
    onEdit: ((seed: boolean, mode?: 'form' | 'raw') => void) | null;
    onOpenServices?: () => void;
    onOpenScripts?: () => void;
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
  const summary = props.inspection.detectionSummary;
  const { runnableCount, hasDetected, files } = React.useMemo(() => ({
    runnableCount: summary?.scripts ?? detected.filter(entry => entry.usage === 'script').length,
    hasDetected: summary ? summary.total > 0 || (summary.sourceFiles?.length ?? summary.files.length) > 0 : detected.length > 0,
    files: joinProjectFiles(summary ? summary.sourceFiles ?? summary.files.map(file => file.file) : detected.map(entry => entry.source.file)),
  }), [detected, summary]);
  // The hero and groups share the page's reading column with every section below it.
  const column = useLayoutMaxWidthStyle();
  const columnMaxWidth = useLayoutMaxWidth();
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
  // The widget reads like its siblings (lab p-overview HIDDEN): what was found, Review, Set up with an agent.
  const reviewButton = props.glance && props.onOpenScripts ? (
    <RoundButton
      testID={`${props.testID}.review`}
      size="small"
      display="secondary"
      title={t('projects.widgets.scriptsReview')}
      onPress={props.onOpenScripts}
    />
  ) : null;
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
          description={t('projects.widgets.noProjectFileBody', { count: runnableCount })}
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
      ) : runnableCount > 0 || (props.glance && hasDetected) ? (
        <View testID={`${props.testID}.found`} style={styles.found}>
          {runnableCount > 0 ? (
            <Text
              style={[styles.foundText, { color: theme.colors.text.secondary }]}
            >
              {t('projects.widgets.scriptsFound', {
                count: runnableCount,
                files,
              })}
            </Text>
          ) : null}
          <View style={styles.actions}>{reviewButton}{setupButton}</View>
          {setupFailure}
        </View>
      ) : null}
      {/* Provenance only: which Session last wrote toward this checkout. It never says the setup is ready. */}
      <ProjectSetupAuthoredLine workspace={props.workspace} compact={!props.page} />
      {!hasDetected ? (
        // On the page the hero above already says nothing was found and offers the next step.
        props.page ? null : (
          <SurfaceStateCard
            testID={`${props.testID}.empty`}
            kind="empty"
            title={t('projects.widgets.scriptsEmpty')}
          />
        )
      ) : props.glance ? null : (
        <DetectedGroups
          {...props}
          detection={props.inspection.detection}
        />
      )}
      {props.page && hasDetected ? (
        <Text style={[styles.note, { color: theme.colors.text.tertiary }]}>
          {t('projects.widgets.scriptsFoundBy', { files })}
        </Text>
      ) : null}
      {props.page ? <ServicesFound testID={props.testID} detection={props.inspection.detection}
        summary={props.inspection.detectionSummary} onOpenServices={props.onOpenServices} /> : null}
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
      if (entry.usage === 'setup')
        continue;
      const group = byFile.get(entry.source.file);
      if (group) group.push(entry);
      else byFile.set(entry.source.file, [entry]);
    }
    let index = 0;
    return [...byFile.entries()].map(([file, entries]) => [file, entries.map(entry => ({
      entry,
      service: entry.usage === 'service',
      id: JSON.stringify(entry.source),
      index: index++,
      rowKey: projectScriptRowKey(props.workspace, `native:${JSON.stringify(entry.source)}`),
    }))] as const);
  }, [props.detection.entries, props.workspace]);
  const listed = React.useMemo(() => groups.reduce((sum, [, entries]) => sum + entries.length, 0), [groups]);
  const { theme } = useUnistyles();
  // A widget keeps its card's footprint (lab p-overview HOME: a few rows, never the whole list); the
  // Scripts page lists everything. The rest is counted once under the rows.
  const frameRows = React.useContext(WidgetFrameBodyRowsContext);
  const page = useFoundRowPage();
  const rowBudget = props.page ? page.rows : Math.max(WIDGET_SCRIPT_ROWS, frameRows ?? 0);
  const summary = props.inspection.detectionSummary;
  const fileTotals = React.useMemo(
    () => new Map((summary?.files ?? []).map(group => [group.file, group.total] as const)),
    [summary],
  );
  // The page holds every found reference and mounts them a page at a time; a widget's read is already narrowed,
  // so its count comes from the summary.
  const total = props.page ? listed : summary?.total ?? listed;
  let remaining = rowBudget;
  const shownGroups = groups.flatMap(([file, entries]) => {
    if (remaining <= 0) return [];
    const shown = entries.slice(0, remaining);
    remaining -= shown.length;
    return [[file, shown, fileTotals.get(file) ?? entries.length] as const];
  });
  const hiddenCount = total - shownGroups.reduce((sum, [, shown]) => sum + shown.length, 0);
  const columns = props.page && shownGroups.length > 1 ? 2 : 1;
  // The page builds only the file groups near its viewport (QA-BREADTH B6: 120 rows mounted ~11.5k
  // components per visit); the rest hold a lower-bound height. Groups fill `columns` per line, so a
  // group's lower-bound top is the sum of each earlier line's tallest group at the row minimum height.
  let lineTop = 0;
  let lineHeight = 0;
  const groupBounds = shownGroups.map(([, entries], index) => {
    if (index > 0 && index % columns === 0) { lineTop += lineHeight; lineHeight = 0; }
    const height = entries.length * PAGE_ROW_TOUCH_MIN_HEIGHT_PX;
    lineHeight = Math.max(lineHeight, height);
    return { top: lineTop, height };
  });
  const rendered = shownGroups.map(([file, entries, fileTotal], groupIndex) => {
    const group = (
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
              {groupToolLabel(entries[0]!.entry.source, file)
                ? t('projects.scripts.foundCount', { count: fileTotal, tool: groupToolLabel(entries[0]!.entry.source, file)! })
                : String(fileTotal)}
            </Text>
          </View>
        }
      >
        {entries.map((row, position) => (
          <DetectedRow
            key={row.id}
            testID={`${props.testID}.detected:${row.index}`}
            workspace={props.workspace}
            entry={row.entry}
            rowKey={row.rowKey}
            accountId={props.controller.accountId}
            pending={props.controller.pendingKeys[row.rowKey] === true}
            failureCode={props.controller.failure?.key === row.rowKey ? props.controller.failure.code : null}
            run={props.controller.run}
            compact={!props.page}
            onOpenServices={row.service ? props.onOpenServices : undefined}
            showDivider={position < entries.length - 1}
          />
        ))}
      </ItemGroup>
    );
    return (
      <ItemGroupColumn key={file}>
        {props.page ? (
          <NearViewportWindow id={file} testID={`${props.testID}.detected.group:${groupIndex}`}
            // A Run in flight or its refusal keeps its rows built so their row-local state and status stay.
            pinned={entries.some(row => props.controller.pendingKeys[row.rowKey] === true || props.controller.failure?.key === row.rowKey)}
            estimatedTop={groupBounds[groupIndex]!.top} estimatedHeight={groupBounds[groupIndex]!.height}>
            {group}
          </NearViewportWindow>
        ) : group}
      </ItemGroupColumn>
    );
  });
  return (
    <>
      {/* Files sit side by side on the page (lab s-scripts FIRST); one file takes the whole column rather than leaving the second empty. */}
      <ItemGroupColumns columns={columns} paddingHorizontal={0} paddingVertical={0}>{rendered}</ItemGroupColumns>
      {hiddenCount > 0 && props.page ? (
        <FoundShowMore testID={`${props.testID}.detected.showMore`} hidden={hiddenCount} onPress={page.more} />
      ) : hiddenCount > 0 ? (
        <Text testID={`${props.testID}.detected.more`} style={[styles.note, { color: theme.colors.text.tertiary }]}>
          {t('projects.scripts.foundMore', { count: hiddenCount })}
        </Text>
      ) : null}
    </>
  );
}

/** The fewest rows a Scripts widget shows (lab p-overview HOME: three scripts), more when its frame has room. */
const WIDGET_SCRIPT_ROWS = 3;

/**
 * Found references mount a page at a time: a checkout can declare thousands (happier-dev: 6,230), and mounting
 * them all froze the tab. A page is a few screens of rows; every reference stays one Show more away.
 */
const FOUND_PAGE_ROWS = 120;

function useFoundRowPage() {
  const [rows, setRows] = React.useState(FOUND_PAGE_ROWS);
  const more = React.useCallback(() => setRows((current) => current + FOUND_PAGE_ROWS), []);
  return { rows, more };
}

/** The way to the next page of found references, under the rows it continues. */
function FoundShowMore(props: Readonly<{ testID: string; hidden: number; onPress: () => void }>) {
  return (
    <View style={styles.showMore}>
      <RoundButton
        testID={props.testID}
        size="small"
        display="secondary"
        title={t('projects.scripts.showMore', { count: Math.min(props.hidden, FOUND_PAGE_ROWS) })}
        onPress={props.onPress}
      />
    </View>
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

/** The header's "…" beside Edit project file (lab L6 menu): what you can do with a shared setup. */
const ProjectSetupHeaderMenu = React.memo(function ProjectSetupHeaderMenu(
  props: Readonly<{ testID: string; onCheckShared: () => void }>,
) {
  const [open, setOpen] = React.useState(false);
  const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => [
    { id: 'checkShared', testID: `${props.testID}:checkShared`, title: t('projects.scripts.sharedUpdate.check'),
      icon: <Icon name="arrows-clockwise" size={16} /> },
  ], [props.testID]);
  const { onCheckShared } = props;
  const select = React.useCallback((id: string) => {
    setOpen(false);
    if (id === 'checkShared') onCheckShared();
  }, [onCheckShared]);
  return (
    <DropdownMenu
      testID={`${props.testID}:menu`}
      open={open}
      onOpenChange={setOpen}
      items={items}
      onSelect={select}
      placement="bottom"
      popoverAnchorAlign="end"
      matchTriggerWidth={false}
      maxWidthCap={320}
      showCategoryTitles={false}
      popoverPortalWebTarget="body"
      trigger={({ toggle }) => (
        <IconButton
          testID={props.testID}
          iconName="dots-three"
          variant="plain"
          accessibilityLabel={t('projects.scripts.moreActions')}
          tooltip={t('projects.scripts.moreActions')}
          tooltipHidden={open}
          hasPopup="menu"
          expanded={open}
          onPress={toggle}
        />
      )}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
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
  showMore: { flexDirection: 'row', paddingHorizontal: PAGE_LIST_METRICS.pageTextInsetPx, paddingTop: theme.space.s8 },
  groupMeta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    marginLeft: theme.space.s8,
  },
}));
