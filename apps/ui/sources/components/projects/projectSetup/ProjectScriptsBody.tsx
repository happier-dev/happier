import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPageHeader, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
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

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  ItemGroupColumn,
  ItemGroupColumns,
} from '@/components/ui/lists/ItemGroupColumns';
import { ItemList } from '@/components/ui/lists/ItemList';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useLayoutMaxWidth, useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { renderPageHeaderText } from '@/components/ui/layout/PageHeader';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { useDeviceType } from '@/utils/platform/responsive';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';

import { ProjectCommandOutputHost, useProjectCommandOutputOpener } from '@/components/inbox/actionOperations/projectCommandOutputHost';
import { ProjectCommandOutputPane } from '@/components/inbox/actionOperations/ProjectCommandOutputPane';
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
import { ProjectSetupAuthoredLine } from './ProjectSetupReturn';
import { WorkspaceAdHocCommandsItem } from '@/components/projects/workers/WorkspaceAdHocCommandsItem';
import { ProjectAgentGuidanceDisclosure } from '@/components/projects/workers/ProjectAgentGuidanceDisclosure';
import {
  projectDefinitionInspectionKey,
  useProjectDefinitionInspection,
  type ProjectDefinitionInspection,
} from './useProjectDefinitionInspection';
import { useProjectScriptsController, type ProjectScriptsController } from './useProjectScriptsController';
import { useProjectSetupAuthoring } from './useProjectSetupAuthoring';
import type { ManagedMachineConfigurationContinuation } from '@/components/sessions/new/components/machineSelection/ManagedMachineSelectionOffers';

export type ProjectScriptsBodyProps = Readonly<{
  workspace: WorkspaceAddressV1;
  /** Exact Project/native selectors, when the caller has a controller-qualified handoff. */
  initialManagedConfiguration?: ManagedMachineConfigurationContinuation;
  /** The Scripts page leads with its header and editor; the rail and widget keep the compact list. */
  presentation?: 'page' | 'widget';
  /** Services found here are reviewed on the Services page, never appended to the finite list. */
  onOpenServices?: () => void;
  /** The host's pane scope whose bottom terminal shows script output; absent where the host has none. */
  outputScopeId?: string | null;
  testID?: string;
}>;

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
  const controller = useProjectScriptsController(workspace, retry, binding);
  const [editor, setEditor] = React.useState<EditorState>(null);
  // Workers settings open in place, like the editor: Scripts › Workers and Run on › Worker settings….
  const [workersKey, setWorkersKey] = React.useState<string | null>(null);
  const page = presentation === 'page';
  const phone = useDeviceType() === 'phone';
  const inspectionFailure = read && 'error' in read && read.error ? (
    <SurfaceStateCard
      kind="unavailable"
      size={'value' in read ? 'line' : undefined}
      title={t('projects.widgets.scriptsUnavailable')}
      diagnosticCode={read.error}
      action={{ label: t('common.retry'), onPress: retry, busy: 'value' in read && read.refreshing === true }}
      testID={`${testID}.inspection`}
    />
  ) : null;

  let content: React.ReactNode;
  let ownsPhoneScroll = false;
  if (!read || read.key !== key) {
    content = (
      <SurfaceStateCard
        kind="loading"
        title={t('projects.scripts.definition.inspecting')}
        testID={`${testID}.inspection`}
      />
    );
  } else if (!('value' in read)) {
    content = inspectionFailure;
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
    ownsPhoneScroll = phone;
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
        testID={testID}
        onEdit={page ? openEditor : null}
        onOpenWorkers={page ? () => setWorkersKey(key) : null}
        onOpenServices={onOpenServices}
        onRetry={retry}
      />
    );
  }

  const approval = controller.approvalId ? (
    <AttentionBanner
      testID={`${testID}.approval`}
      tone="neutral"
      title={t('approvals.title')}
      description={t('approvals.status.open')}
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
  if (ownsPhoneScroll) return (
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
    testID: string;
    onEdit: ((seed: boolean, mode?: 'form' | 'raw') => void) | null;
    /** Opens this checkout's Workers settings; null where the host has no room for the page. */
    onOpenWorkers?: (() => void) | null;
    onOpenServices?: () => void;
    onRetry: () => void;
  }>,
) {
  const { definition, detection } = props.inspection;
  const document = definition.document;
  const partial =
    detection.coverage === 'partial' ? (
      <AttentionBanner
        testID={`${props.testID}.partial`}
        tone="warning"
        title={t('projects.scripts.definition.partial')}
        details={detection.diagnostics.map(
          (diagnostic) => `${diagnostic.file}: ${diagnostic.code}`,
        )}
        action={{ label: t('common.retry'), onPress: props.onRetry }}
      />
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
      <DeclaredScripts {...props} manifest={document.manifest} />
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
    testID: string;
    onEdit: ((seed: boolean, mode?: 'form' | 'raw') => void) | null;
    onOpenWorkers?: (() => void) | null;
  }>,
) {
  const machine = useServerScopedMachine(
    props.workspace.serverId,
    props.workspace.machineId,
  );
  const machineName =
    (machine ? getMachineDisplayName(machine) : null) ??
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
  const setupReadiness = setupPresentation.live || props.controller.consent || props.controller.pendingKey === 'setup'
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
  return (
    <>
    {props.page ? (
      <HappierPageHeader
        title=""
        showTitle={false}
        columnMaxWidthPx={columnMaxWidth}
        renderText={renderPageHeaderText}
        description={hasSetup
          ? t('projects.scripts.purposeSetup', { project, machine: machineName })
          : t('projects.scripts.purpose', { project, machine: machineName })}
        meta={meta}
        actions={props.onEdit ? (
          <RoundButton
            size="small"
            display="secondary"
            title={t('projects.scripts.editProjectFile')}
            testID={`${props.testID}.edit`}
            leading={<Icon name="file-text" size={14} />}
            onPress={() => props.onEdit?.(false)}
          />
        ) : undefined}
        testID={`${props.testID}.header`}
      />
    ) : null}
    {/* After setup authoring: which Session last wrote the project file (lab `s-setup` RESULT). */}
    <ProjectSetupAuthoredLine workspace={props.workspace} compact={!props.page} />
    <ItemGroup>
      {hasSetup ? (
        <SetupRow
          workspace={props.workspace}
          manifest={props.manifest}
          machineName={machineName}
          sharedRunAs={
            machine?.isShared ? (machine.metadata?.username ?? null) : null
          }
          controller={props.controller}
          operation={setupRun}
          readiness={setupReadiness}
          compact={!props.page}
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
            declaration={declaration}
            invocation={findProjectInvocation(props.inspection, declaration.source)}
            controller={props.controller}
            compact={!props.page}
            preference={preference}
            memoryDemand={resolveProjectMemoryDemandV1(declaration.memoryDemand, props.manifest.workspace?.memoryDemand)}
            initialManagedConfiguration={props.initialManagedConfiguration}
            onOpenWorkerSettings={props.onOpenWorkers ?? undefined}
            idleText={
              setupReady
                ? t('projects.scripts.run.notRun')
                : t('projects.scripts.run.waitsForSetup')
            }
            showDivider={index < scripts.length - 1}
          />
        ))
      )}
    </ItemGroup>
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
  return (
    <ItemGroup title={t('projectWorkers.title')}>
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
    declaration: NonNullable<ProjectManifestV1['scripts']>[string];
    invocation: ReturnType<typeof findProjectInvocation>;
    controller: ScriptsController;
    compact: boolean;
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
    execution: props.declaration.execution,
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
      badge={source.badge}
      command={source.command ?? (source.target === props.name ? null : source.target)}
      portable={props.declaration.execution === 'portable'}
      operation={operation}
      idleText={props.idleText}
      pending={props.controller.pendingKey === rowKey}
      failureCode={failure}
      compact={props.compact}
      showDivider={props.showDivider}
      defaultChoice={resolvedChoice.status === 'resolved' ? resolvedChoice.choice : null}
      memoryDemand={props.memoryDemand}
      initialManagedConfiguration={props.initialManagedConfiguration}
      choiceRequired={props.controller.choiceRequired?.key === rowKey}
      onChooseForRun={(choice) => { void props.controller.chooseForRun(choice); }}
      onDismissChoice={props.controller.dismissChoice}
      onOpenWorkerSettings={props.onOpenWorkerSettings}
      workerRefusal={props.controller.failure?.key === rowKey ? props.controller.failure.workerRefusal ?? null : null}
      managedCreation={props.controller.managedCreation?.key === rowKey ? props.controller.managedCreation : null}
      onCancelManagedRun={props.controller.cancelRun}
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
    machineName: string;
    sharedRunAs: string | null;
    controller: ScriptsController;
    operation: ReturnType<typeof useProjectSetupRun>;
    readiness: ProjectDefinitionInspection['setupReadiness'];
    compact: boolean;
    onViewFile: (() => void) | null;
  }>,
) {
  const { theme } = useUnistyles();
  const steps = props.manifest.workspace?.setup?.length ?? 0;
  const consent = props.controller.consent;
  const stop = props.controller.setupStop;
  const output = useProjectCommandOutputOpener();
  const presentation = presentProjectRun(
    props.operation,
    props.machineName,
    t('projects.scripts.setup.steps', { count: steps }),
  );
  const reviewing =
    consent !== null || Boolean(props.operation?.snapshot.setupReview);
  const failed = props.operation?.snapshot.state === 'failed';
  const stopping = stop.pending || stop.stopRequested;
  const stepCount = t('projects.scripts.setup.steps', { count: steps });
  const subtitle = reviewing
    ? t('projects.scripts.setup.pending')
    : stopping
      ? t('projects.scripts.run.stopping')
      : failed
        ? t('projects.scripts.setup.failed')
        : props.readiness?.kind === 'current'
          ? `${t('projects.scripts.setup.readySince', { time: formatAsOfTime(props.readiness.completedAtMs) })} · ${stepCount}`
          : presentation.text;
  const pending = props.controller.pendingKey === 'setup';
  const attachment = props.operation?.snapshot.domainRef?.kind === 'projectCommand' ? props.operation.snapshot.domainRef : null;
  const openOutput = () => {
    if (props.operation)
      void output.open(props.operation, { title: `${t('projects.scripts.setup.title')} · ${props.machineName}` });
  };
  // The review opens from the row or from a preparation that needs consent; it never runs anything.
  const [open, setOpen] = React.useState(false);
  const expanded = props.compact
    ? props.controller.setupReviewOpen
    : props.controller.setupReviewOpen || reviewing || open;
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
        props.operation
          ? t('projects.scripts.setup.runAgain')
          : t('projects.scripts.setup.run')
      }
      onPress={() => {
        void props.controller.prepare();
      }}
    />
  );
  const header = (headerProps?: Readonly<Record<string, unknown>>) => (
    <Item
      {...headerProps}
      testID={props.testID}
      icon={
        <Icon
          name="wrench"
          size={18}
          color={
            reviewing
              ? theme.colors.state.attention.foreground
              : theme.colors.text.secondary
          }
        />
      }
      title={t('projects.scripts.setup.title')}
      subtitle={subtitle}
      subtitleStyle={failed && !stopping ? { color: theme.colors.status.error } : undefined}
      subtitleLines={1}
      showChevron={false}
      rightElementOutsidePressable
      accessoryLayout="inline"
      rightElement={
        reviewing ? (
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
  // After a run the row opens into that run's output; a pending review (or no run yet) opens the review.
  const showsOutput = !reviewing && Boolean(props.operation) && !props.compact;
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
          <View style={[styles.setupOutput, { borderColor: theme.colors.border.subtle }]}>
            {attachment?.terminalId ? (
              <ProjectCommandOutputPane
                operation={props.operation}
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
          </View>
        ) : (
          <ProjectSetupReview
            testID={`${props.testID}.review`}
            manifest={props.manifest}
            machineName={props.machineName}
            sharedRunAs={props.sharedRunAs}
            pending={pending}
            reviewedEffect={consent?.reviewedEffect ?? props.operation?.snapshot.setupReview?.reviewedEffect}
            initialScope={consent?.consentScope ?? props.operation?.snapshot.setupReview?.consentScope}
            onRun={(scope) => {
              void props.controller.prepare(
                consent?.reviewedEffectDigest ??
                  props.operation?.snapshot.setupReview?.reviewedEffectDigest,
                scope,
              );
            }}
            onNotNow={() => {
              setOpen(false);
              props.controller.dismissConsent();
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
  const [expanded, setExpanded] = React.useState(true);
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
            icon={
              <Icon
                name="magnifying-glass"
                size={18}
                color={theme.colors.text.secondary}
              />
            }
            title={(
              <Text numberOfLines={1} style={[styles.inlineTitle, { color: theme.colors.text.secondary }]}>
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
                  loading={props.controller.pendingKey === `add:${id}`}
                  disabled={props.controller.pendingKey !== null}
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
        icon={
          <Icon
            name="hard-drives"
            size={18}
            color={theme.colors.text.secondary}
          />
        }
        title={(
          <Text numberOfLines={1} style={[styles.inlineTitle, { color: theme.colors.text.secondary }]}>
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
  const files = joinProjectFiles(detected.map((entry) => entry.source.file));
  const setupButton = authoring.hasQualifiedCheckout ? (
    <RoundButton
      testID={`${props.testID}.setup`}
      size="small"
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
  return (
    <View style={[styles.column, column]}>
      {props.page ? (
        <View
          testID={`${props.testID}.noProjectFile`}
          style={[
            styles.hero,
            { borderBottomColor: theme.colors.border.subtle },
          ]}
        >
          <Icon name="play" size={22} color={theme.colors.text.secondary} />
          <View style={styles.heroText}>
            <Text
              accessibilityRole="header"
              style={[styles.heroTitle, { color: theme.colors.text.primary }]}
            >
              {t('projects.widgets.noProjectFile')}
            </Text>
            <Text
              style={[styles.heroBody, { color: theme.colors.text.secondary }]}
            >
              {t('projects.widgets.noProjectFileBody', {
                count: runnable.length,
              })}
            </Text>
            <View style={styles.actions}>
              {props.onEdit ? (
                <RoundButton
                  testID={`${props.testID}.create`}
                  size="small"
                  title={t('projects.scripts.createProjectFile')}
                  onPress={() => props.onEdit?.(true)}
                />
              ) : null}
              {setupButton}
            </View>
          </View>
        </View>
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
        </View>
      ) : null}
      {detected.length === 0 ? (
        <SurfaceStateCard
          kind="empty"
          title={t('projects.widgets.scriptsEmpty')}
        />
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
      {setup.reason ? (
        <SurfaceStateCard
          kind="unavailable"
          title={t('projects.authoring.error')}
          diagnosticCode={setup.reason}
        />
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
  let index = 0;
  const rendered = groups.map(([file, entries]) => (
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
                ? t('projects.scripts.foundCount', { count: entries.length, tool: groupToolLabel(entries[0]!.source, file)! })
                : String(entries.length)}
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
    <ItemGroupColumns columns={props.page ? 2 : 1}>{rendered}</ItemGroupColumns>
  );
}

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
      idleText={t('projects.scripts.run.notRun')}
      pending={props.controller.pendingKey === rowKey}
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
      const reason = !result.ok
        ? result.errorCode
        : !acknowledgement?.success
          ? 'project_authoring_invalid_result'
          : acknowledgement.data.kind === 'opened'
            ? undefined
            : acknowledgement.data.kind;
      if (currentKey.current === key)
        setOpening({ key, pending: false, ...(reason ? { reason } : {}) });
    } catch {
      if (currentKey.current === key)
        setOpening({ key, pending: false, reason: 'project_authoring_failed' });
    }
  };
  return {
    pending: mine?.pending === true,
    reason: mine?.reason ?? null,
    open,
  };
}

const styles = StyleSheet.create((theme) => ({
  phoneEditor: { flex: 1, minHeight: 0 },
  body: { gap: 12 },
  setupTail: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  setupOutput: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    overflow: 'hidden',
  },
  setupBanner: { marginHorizontal: 16, marginBottom: 12 },
  inlineTitle: { ...Typography.default(), ...happierPageTextMetrics('rowTitle') },
  inlineMeta: { ...Typography.default(), ...happierPageTextMetrics('rowDescription') },
  strong: { ...Typography.default('semiBold') },
  column: { width: '100%', alignSelf: 'center' },
  groupTitle: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  hero: {
    flexDirection: 'row',
    gap: 16,
    paddingBottom: 20,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  heroText: { flex: 1, minWidth: 0, gap: 6 },
  heroTitle: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('pageTitle'),
  },
  heroBody: {
    ...Typography.default(),
    ...happierPageTextMetrics('pageDescription'),
    maxWidth: 560,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  found: { gap: 4 },
  foundText: {
    ...Typography.default(),
    ...happierPageTextMetrics('sectionDescription'),
  },
  note: {
    ...Typography.default(),
    ...happierPageTextMetrics('sectionDescription'),
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  mono: { ...Typography.mono() },
  badge: { marginLeft: 8 },
  groupMeta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    marginLeft: 8,
  },
}));
