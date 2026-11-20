import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS, HappierPageHeader, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type {
  ProjectManifestFileSnapshot,
  ProjectManifestDiagnostic,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import type {
  ProjectDefinitionDetectionV1,
  ProjectDefinitionImportCandidateV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { showTextComparison } from '@/components/ui/code/diff/TextComparisonModal';
import { CodeEditor } from '@/components/ui/code/editor/CodeEditor';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { KeyboardAwareScreen } from '@/components/ui/keyboardAvoidance/KeyboardAwareScreen';
import { ItemList } from '@/components/ui/lists/ItemList';
import { renderPageHeaderText } from '@/components/ui/layout/PageHeader';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { useProjectPageBack } from '@/components/projects/detail/projectPageBack';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { PagePinnedBar } from '@/components/ui/layout/PagePinnedBar';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { EnvVarRequirement } from '@happier-dev/protocol/profiles/environmentVariables';
import { Typography } from '@/constants/Typography';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

import type { ProjectManifestEditorModel } from './projectManifestEditorModel';
import type { ProjectManifestActionClient } from './projectManifestActionClient';
import { getProjectManifestImportSelection } from './projectManifestImportSelection';
import { ProjectManifestForm, type ProjectManifestFormSection } from './ProjectManifestForm';
import type { ProjectDefinitionInspection } from './useProjectDefinitionInspection';
import { useProjectManifestEditorSnapshot } from './useProjectManifestEditorSnapshot';
import { useProjectManifestDocument } from './useProjectManifestDocument';
import { useProjectSetupRow } from './useProjectSetupRow';

// These are unrequested picker choices, never evidence that discovery completed or found nothing.
const UNREQUESTED_DETECTION: ProjectDefinitionDetectionV1 = {
  entries: [], toolchains: [], devcontainers: [], coverage: 'partial', diagnostics: [],
};

export type ProjectManifestEditorProps = Readonly<{
  workspace: WorkspaceAddressV1;
  accountId: string;
  client: ProjectManifestActionClient;
  definition: ProjectManifestFileSnapshot;
  detection: ProjectDefinitionDetectionV1;
  importCandidates: readonly ProjectDefinitionImportCandidateV1[];
  /** Inspection's previewed native commands and observed tools (B1b); absent when not inspected. */
  commands?: ProjectDefinitionInspection['commands'];
  tools?: ProjectDefinitionInspection['tools'];
  /** Create project file: the draft starts from the available, unambiguous found references. */
  seedFromDetection: boolean;
  initialMode: 'form' | 'raw';
  /** Requirements the effective setup already declares; an import never shadows them. */
  inheritedRequirements?: readonly EnvVarRequirement[];
  onBack: () => void;
  onSaved: () => void;
}>;

/**
 * The project file editor (plan 20s2, lab `s-scripts` EDIT): Form and JSON are two views of one
 * draft; every save is the one guarded `projects.manifest.update`. The model is owned here so typing
 * never updates the Scripts shell.
 */
export function ProjectManifestEditor(props: ProjectManifestEditorProps) {
  // One document per mounted editor; the host keys the editor by checkout and Account, and newer reads
  // arrive through receiveDefinition rather than recreating the draft. The document owns which target
  // (repository file or personal setup) is edited; each target's model owns its draft and CAS save.
  // The selected Account's Project row; without one, only the repository file can be edited.
  const row = useProjectSetupRow(props.workspace);
  const personal = React.useMemo(() => row
    ? { projectRef: row.projectRef, revision: row.expectedRevision, organization: row.organization } : null, [row]);
  const document = useProjectManifestDocument({
    workspace: props.workspace,
    accountId: props.accountId,
    client: props.client,
    repositoryDefinition: props.definition,
    personal,
    inheritedRequirements: props.inheritedRequirements,
  });
  const repository = document.target === 'repository' ? document.model : null;
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (!repository || !props.seedFromDetection || seeded.current) return;
    seeded.current = true;
    const draft = repository.getSnapshot().draft;
    if (
      draft.status !== 'valid' ||
      Object.keys(draft.manifest.scripts ?? {}).length > 0
    )
      return;
    for (const candidate of getProjectManifestImportSelection(
      props.importCandidates,
    ).selected) {
      repository.importNative({
        usage: candidate.usage,
        ...(candidate.usage === 'setup'
          ? {}
          : { name: candidate.source.target }),
        source: candidate.source,
      });
    }
  }, [repository, props.importCandidates, props.seedFromDetection]);
  const initialMode = React.useRef(false);
  React.useEffect(() => {
    if (!repository || initialMode.current) return;
    initialMode.current = true;
    if (props.initialMode === 'raw') repository.setMode('raw');
  }, [repository, props.initialMode]);
  return document.model
    ? <ProjectManifestEditorLeaf {...props} model={document.model} document={document} />
    : <ProjectManifestEditorPendingTarget {...props} document={document} />;
}

type ProjectManifestDocument = ReturnType<typeof useProjectManifestDocument>;

/** Where saves go: the repository file everyone gets, or a setup only this Account uses (plan A U2). */
function ProjectManifestEditorTarget(props: Readonly<{ document: ProjectManifestDocument; disabled?: boolean }>) {
  const { document } = props;
  const options = React.useMemo(() => [
    { id: 'repository' as const, label: t('projects.scripts.editor.target.repository'),
      description: t('projects.scripts.editor.target.repositoryBody') },
    { id: 'personal' as const, label: t('projects.scripts.editor.target.personal'),
      description: t('projects.scripts.editor.target.personalBody'),
      ...(document.canEditPersonal ? {} : { unavailableReason: t('projects.scripts.editor.target.personalUnavailable') }) },
  ], [document.canEditPersonal]);
  return (
    <ItemGroup>
      <SegmentedChoiceItem
        title={t('projects.scripts.editor.target.title')}
        options={options}
        value={document.target}
        disabled={props.disabled}
        onChange={(next) => { document.selectTarget(next); }}
        testIDPrefix="project-manifest-editor.target"
      />
    </ItemGroup>
  );
}

/**
 * The names a setup needs (plan A §4): imported from `.env.example` as names only, never values.
 * Values stay on this computer and are bound where the launch resolves them.
 */
function ProjectManifestEnvironmentSection(props: Readonly<{
  document: ProjectManifestDocument;
  requirements: readonly EnvVarRequirement[];
  disabled: boolean;
}>) {
  const { document } = props;
  const none = document.environmentImportChecked && document.environmentImport === null;
  return (
    <ItemGroup
      title={t('projects.scripts.editor.environment.title')}
      description={t('projects.scripts.editor.environment.body')}
      action={
        <RoundButton
          size="small"
          display="inverted"
          title={t('projects.scripts.editor.environment.action')}
          testID="project-manifest-editor.environment.import"
          loading={document.importing}
          disabled={props.disabled || document.importing}
          onPress={() => { void document.importEnvironmentNames(); }}
        />
      }
    >
      {document.error && !document.loading ? (
        <SurfaceStateCard size="line" kind="unavailable" title={t('projects.scripts.editor.environment.failed')}
          diagnosticCode={document.error} testID="project-manifest-editor.environment.error" />
      ) : null}
      {props.requirements.length === 0 ? (
        <Item
          testID="project-manifest-editor.environment.empty"
          title={none ? t('projects.scripts.editor.environment.none') : t('projects.scripts.editor.environment.empty')}
          showChevron={false}
        />
      ) : props.requirements.map((requirement) => (
        <Item
          key={requirement.name}
          testID={`project-manifest-editor.environment:${requirement.name}`}
          title={requirement.name}
          titleStyle={styles.mono}
          subtitle={[
            requirement.kind === 'secret' ? t('projects.scripts.editor.environment.secret') : t('projects.scripts.editor.environment.value'),
            requirement.required ? t('projects.scripts.environment.required') : t('projects.scripts.environment.optional'),
          ].join(' · ')}
          showChevron={false}
        />
      ))}
    </ItemGroup>
  );
}

/** The personal target before its setup is read, or when it can't be: the same page, with its state. */
function ProjectManifestEditorPendingTarget(
  props: ProjectManifestEditorProps & Readonly<{ document: ProjectManifestDocument }>,
) {
  const { document } = props;
  const { theme } = useUnistyles();
  const columnMaxWidth = useLayoutMaxWidth();
  return (
    <View style={styles.page}>
      <ItemList testID="project-manifest-editor.scroll">
        <View testID="project-manifest-editor">
          <HappierPageHeader
            title={t('projects.scripts.editor.title')}
            description={
              <Text style={[styles.headerNote, { color: theme.colors.text.secondary }]}>
                {t('projects.scripts.editor.target.personalNote')}
              </Text>
            }
            showTitle
            columnMaxWidthPx={columnMaxWidth}
            renderText={renderPageHeaderText}
            renderBack={(style) => (
              <View style={style as StyleProp<ViewStyle>}>
                <IconButton
                  testID="project-manifest-editor.back"
                  iconName="caret-left"
                  variant="plain"
                  accessibilityLabel={t('projects.scripts.editor.back')}
                  onPress={props.onBack}
                />
              </View>
            )}
          />
          <ProjectManifestEditorTarget document={document} />
          {document.loading ? (
            <SurfaceStateCard kind="loading" title={t('projects.scripts.definition.inspecting')}
              testID="project-manifest-editor.personal.loading" />
          ) : (
            <SurfaceStateCard kind="unavailable" title={t('projects.scripts.editor.target.personalFailed')}
              diagnosticCode={document.error ?? undefined}
              action={{ label: t('common.retry'), onPress: document.reloadPersonal }}
              testID="project-manifest-editor.personal.error" />
          )}
        </View>
      </ItemList>
    </View>
  );
}

function ProjectManifestEditorLeaf(
  props: ProjectManifestEditorProps &
    Readonly<{ model: ProjectManifestEditorModel; document: ProjectManifestDocument }>,
) {
  const { model, document } = props;
  const personal = document.target === 'personal';
  const phone = useDeviceType() === 'phone';
  const snapshot = useProjectManifestEditorSnapshot(model);
  const columnMaxWidth = useLayoutMaxWidth();
  const machine = useServerScopedMachine(props.workspace.serverId, props.workspace.machineId);
  const machineName = (machine ? getMachineSentenceName(machine) : null) ?? props.workspace.machineId;
  const { theme } = useUnistyles();
  const [rawResetKey, setRawResetKey] = React.useState(0);
  // Phone (lab EDITp): the Form lists its sections and pushes one in place; Back keeps the draft.
  const [section, setSection] = React.useState<ProjectManifestFormSection | null>(null);
  const raw = snapshot.mode === 'raw' || snapshot.draft.status !== 'valid';
  // Inside a Project the phone bar owns Back: it closes a pushed section first, then the editor. Elsewhere
  // (and on wider layouts, where the header keeps its own arrow) the editor draws its own way back.
  const barHostsBack = useProjectPageBack(phone, () => {
    if (!raw && section) setSection(null);
    else props.onBack();
  }) && phone;
  const tabs = React.useMemo(
    () => [
      {
        id: 'form' as const,
        label: t('projects.scripts.editor.form'),
        ...(snapshot.formEnabled
          ? {}
          : {
              unavailableReason: t('projects.scripts.editor.formUnavailable'),
            }),
      },
      { id: 'raw' as const, label: t('projects.scripts.editor.json') },
    ],
    [snapshot.formEnabled],
  );
  const save = async () => {
    const result = await model.save();
    if (result?.status === 'saved') props.onSaved();
  };
  const discard = () => {
    model.reloadCurrent();
    setRawResetKey((value) => value + 1);
  };
  const conflict = snapshot.conflict;
  const invalid =
    snapshot.draft.status === 'invalid'
      ? (snapshot.draft.diagnostics[0] ?? null)
      : null;
  const unknownKeys = snapshot.draft.diagnostics.filter(
    (diagnostic) => diagnostic.code === 'unrecognized_key',
  );
  const actions = (
    <View style={styles.headerActions}>
      <RoundButton
        size="normal"
        display="inverted"
        title={t('projects.scripts.editor.discard')}
        testID="project-manifest-editor.discard"
        disabled={!snapshot.dirty || snapshot.saving}
        onPress={discard}
      />
      <RoundButton
        size="normal"
        title={snapshot.saving ? t('projects.scripts.editor.saving') : t('projects.scripts.editor.save')}
        testID="project-manifest-editor.save"
        loading={snapshot.saving}
        disabled={!snapshot.dirty || !snapshot.formEnabled || snapshot.saving || conflict !== null}
        onPress={() => { void save(); }}
      />
    </View>
  );
  const content = (
    // Every block on the page (banner, section) starts its own section gap below the one before it.
    <View testID="project-manifest-editor" style={raw ? styles.fill : null}>
      <HappierPageHeader
        title={t('projects.scripts.editor.title')}
        description={
          <Text style={[styles.headerNote, { color: theme.colors.text.secondary }]}>
            {personal ? t('projects.scripts.editor.target.personalNote') : (
              <Text style={[styles.headerNote, styles.mono]}>.happier/project.json</Text>
            )}
            {personal && !snapshot.dirty ? null : ' · '}
            {snapshot.dirty ? t('projects.scripts.editor.unsavedNote') : personal ? null : t('projects.scripts.editor.fileNote')}
          </Text>
        }
        // The editor lives inside the Scripts page, so its back and actions stay in the body on
        // every host (never moved into the navigation title chrome).
        showTitle
        columnMaxWidthPx={columnMaxWidth}
        renderText={renderPageHeaderText}
        renderBack={barHostsBack ? undefined : (style) => (
          <View style={style as StyleProp<ViewStyle>}>
            <IconButton
              testID="project-manifest-editor.back"
              iconName="caret-left"
              variant="plain"
              accessibilityLabel={t('projects.scripts.editor.back')}
              onPress={props.onBack}
            />
          </View>
        )}
        actions={
          <View style={styles.headerActions}>
            <SegmentedTabBar
              tabs={tabs}
              activeTabId={snapshot.mode}
              segmentSizing="content"
              accessibilityLabel={t('projects.scripts.editor.view')}
              testIDPrefix="project-manifest-editor.mode"
              onSelectTab={(mode) => {
                model.setMode(mode);
              }}
            />
            {!phone ? actions : null}
          </View>
        }
      />
      <ProjectManifestEditorTarget document={document} disabled={snapshot.saving} />
      {conflict ? (
        <AttentionBanner
          testID="project-manifest-editor.conflict"
          tone="warning"
          title={t('projects.scripts.definition.conflict')}
          description={t('projects.scripts.definition.conflictBody')}
          action={{
            label: t('projects.scripts.definition.keepMine'),
            testID: 'project-manifest-editor.keepMine',
            onPress: () => model.reviewCurrentBasis(),
          }}
          secondaryAction={{
            label: t('projects.scripts.definition.compare'),
            testID: 'project-manifest-editor.compare',
            onPress: () =>
              showTextComparison({
                oldText: conflict.document?.bytes ?? '',
                newText: snapshot.draft.bytes,
                filePath: '.happier/project.json',
                subtitle: t('files.externalFileChange'),
              }),
          }}
          moreActions={[
            {
              label: t('projects.scripts.definition.reload'),
              testID: 'project-manifest-editor.reload',
              onPress: () => {
                model.reloadCurrent();
                setRawResetKey((value) => value + 1);
              },
            },
          ]}
        />
      ) : null}
      {invalid ? (
        <AttentionBanner
          testID="project-manifest-editor.invalid"
          tone="danger"
          title={t('projects.scripts.definition.invalid')}
          description={describeDiagnostic(invalid, snapshot.draft.bytes)}
        />
      ) : null}
      {unknownKeys.length > 0 ? (
        <AttentionBanner
          testID="project-manifest-editor.unknownKeys"
          tone="neutral"
          title={t('projects.scripts.editor.unknownKeys')}
          description={t('projects.scripts.editor.unknownKeysBody', {
            keys: unknownKeys
              .map((diagnostic) => diagnostic.path.join('.'))
              .join(', '),
          })}
        />
      ) : null}
      {snapshot.error ? (
        <AttentionBanner
          testID="project-manifest-editor.error"
          tone="danger"
          title={t('projects.scripts.editor.saveFailed')}
          details={[
            snapshot.error.code,
            ...(snapshot.error.message ? [snapshot.error.message] : []),
          ]}
        />
      ) : null}
      {raw ? (
        // The code sits in the page column with the sheets' edge and fills the page below the header;
        // it scrolls itself.
        <PageContentColumn testID="project-manifest-editor.rawColumn" style={styles.rawColumn}>
        <View testID="project-manifest-editor.raw" style={styles.raw}>
          <CodeEditor
            resetKey={`${rawResetKey}`}
            value={snapshot.draft.bytes}
            language="json"
            showLineNumbers
            wrapLines
            testID="project-manifest-editor.code"
            onChange={(bytes) => model.setRaw(bytes)}
          />
        </View>
        </PageContentColumn>
      ) : (
        <ProjectManifestForm
          workspace={props.workspace}
          accountId={props.accountId}
          model={model}
          manifest={snapshot.draft.manifest}
          detection={props.seedFromDetection ? props.detection : UNREQUESTED_DETECTION}
          importCandidates={props.seedFromDetection ? props.importCandidates : []}
          commands={props.seedFromDetection ? props.commands : undefined}
          tools={props.seedFromDetection ? props.tools : undefined}
          machineName={machineName}
          section={section}
          onSectionChange={setSection}
          sectionBack={!barHostsBack}
        />
      )}
      {raw || (phone && section) ? null : (
        <ProjectManifestEnvironmentSection
          document={document}
          requirements={snapshot.draft.status === 'valid' ? snapshot.draft.manifest.environmentVariables ?? NO_REQUIREMENTS : NO_REQUIREMENTS}
          disabled={snapshot.saving}
        />
      )}
    </View>
  );
  // The editor is a page of its own on every host: the JSON view fills it, the Form scrolls in it. On a
  // phone the screen resizes above the native keyboard and the actions are siblings of the scroll, never
  // scrolled off with the focused section; both views retain the same model/draft.
  const page = (
    <ItemList fill={raw} keyboardAware={phone} keyboardShouldPersistTaps="handled" testID="project-manifest-editor.scroll">
      {content}
    </ItemList>
  );
  return phone ? (
    <KeyboardAwareScreen style={styles.page}>
      {page}
      <PagePinnedBar testID="project-manifest-editor.phoneActions" style={styles.phoneActions}>
        {actions}
      </PagePinnedBar>
    </KeyboardAwareScreen>
  ) : <View style={styles.page}>{page}</View>;
}

function describeDiagnostic(
  diagnostic: ProjectManifestDiagnostic,
  bytes: string,
): string {
  if (diagnostic.offset === undefined)
    return diagnostic.path.length && !diagnostic.message.startsWith(`${diagnostic.path.join('.')}:`)
      ? `${diagnostic.path.join('.')}: ${diagnostic.message}`
      : diagnostic.message;
  const line = bytes.slice(0, diagnostic.offset).split('\n').length;
  return t('projects.scripts.editor.lineError', {
    line,
    message: diagnostic.message,
  });
}

const NO_REQUIREMENTS: readonly EnvVarRequirement[] = Object.freeze([]);

const styles = StyleSheet.create(() => ({
  fill: { flexGrow: 1 },
  page: { flex: 1, minHeight: 0 },
  phoneActions: { alignItems: 'flex-end' },
  headerNote: { ...Typography.default(), ...happierPageTextMetrics('pageDescription') },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  rawColumn: { flexGrow: 1, paddingTop: HAPPIER_PAGE_METRICS.sectionGapPx, paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
  // Below the header the code fills the page (the code surface draws its own frame); a short window still
  // shows a readable block of it.
  raw: { flexGrow: 1, minHeight: HAPPIER_PAGE_METRICS.readingClipHeightPx },
  mono: { ...Typography.mono(), ...happierPageTextMetrics('rowDescription') },
}));
