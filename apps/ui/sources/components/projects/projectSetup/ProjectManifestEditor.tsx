import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPageHeader, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type {
  ProjectManifestFileSnapshot,
  ProjectManifestDiagnostic,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import type {
  ProjectDefinitionDetectionV1,
  ProjectDefinitionImportCandidateV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { showWorkspaceFileEditorComparison } from '@/components/workspaces/files/details/workspaceFileDetails/WorkspaceFileEditorComparison';
import { CodeEditor } from '@/components/ui/code/editor/CodeEditor';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { renderPageHeaderText } from '@/components/ui/layout/PageHeader';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { t } from '@/text';

import {
  createProjectManifestEditorModel,
  type ProjectManifestEditorModel,
} from './projectManifestEditorModel';
import type { ProjectManifestActionClient } from './projectManifestActionClient';
import { getProjectManifestImportSelection } from './projectManifestImportSelection';
import { ProjectManifestForm } from './ProjectManifestForm';
import type { ProjectDefinitionInspection } from './useProjectDefinitionInspection';
import { useProjectManifestEditorSnapshot } from './useProjectManifestEditorSnapshot';

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
  onBack: () => void;
  onSaved: () => void;
}>;

/**
 * The project file editor (plan 20s2, lab `s-scripts` EDIT): Form and JSON are two views of one
 * draft; every save is the one guarded `projects.manifest.update`. The model is owned here so typing
 * never updates the Scripts shell.
 */
export function ProjectManifestEditor(props: ProjectManifestEditorProps) {
  const { client, definition } = props;
  // One model per mounted editor; the host keys the editor by checkout and Account, and newer reads
  // arrive through receiveDefinition rather than recreating the draft.
  const [model] = React.useState(() =>
    createProjectManifestEditorModel({
      workspace: props.workspace,
      expectedAccountId: props.accountId,
      definition,
      actions: {
        update: (request) =>
          client.update({
            expectedBasis: request.expectedBasis,
            bytes: request.bytes,
          }),
      },
    }),
  );
  React.useEffect(() => {
    model.receiveDefinition(definition);
  }, [model, definition]);
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (!props.seedFromDetection || seeded.current) return;
    seeded.current = true;
    const draft = model.getSnapshot().draft;
    if (
      draft.status !== 'valid' ||
      Object.keys(draft.manifest.scripts ?? {}).length > 0
    )
      return;
    for (const candidate of getProjectManifestImportSelection(
      props.importCandidates,
    ).selected) {
      model.importNative({
        usage: candidate.usage,
        ...(candidate.usage === 'setup'
          ? {}
          : { name: candidate.source.target }),
        source: candidate.source,
      });
    }
  }, [model, props.importCandidates, props.seedFromDetection]);
  React.useEffect(() => {
    if (props.initialMode === 'raw') model.setMode('raw');
  }, [model, props.initialMode]);
  return <ProjectManifestEditorLeaf {...props} model={model} />;
}

function ProjectManifestEditorLeaf(
  props: ProjectManifestEditorProps &
    Readonly<{ model: ProjectManifestEditorModel }>,
) {
  const { model } = props;
  const snapshot = useProjectManifestEditorSnapshot(model);
  const columnMaxWidth = useLayoutMaxWidth();
  const machine = useServerScopedMachine(props.workspace.serverId, props.workspace.machineId);
  const machineName = (machine ? getMachineDisplayName(machine) : null) ?? props.workspace.machineId;
  const { theme } = useUnistyles();
  const [rawResetKey, setRawResetKey] = React.useState(0);
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
  return (
    <View testID="project-manifest-editor" style={styles.editor}>
      <HappierPageHeader
        title={t('projects.scripts.editor.title')}
        description={
          <Text style={[styles.headerNote, { color: theme.colors.text.secondary }]}>
            <Text style={[styles.headerNote, styles.mono]}>.happier/project.json</Text>
            {' · '}
            {snapshot.dirty ? t('projects.scripts.editor.unsavedNote') : t('projects.scripts.editor.fileNote')}
          </Text>
        }
        // The editor lives inside the Scripts page, so its back and actions stay in the body on
        // every host (never moved into the navigation title chrome).
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
        actions={
          <View style={styles.headerActions}>
            <SegmentedTabBar
              tabs={tabs}
              activeTabId={snapshot.mode}
              compact
              segmentSizing="content"
              accessibilityLabel={t('projects.scripts.editor.view')}
              testIDPrefix="project-manifest-editor.mode"
              onSelectTab={(mode) => {
                model.setMode(mode);
              }}
            />
            <RoundButton
              size="small"
              display="secondary"
              title={t('projects.scripts.editor.discard')}
              testID="project-manifest-editor.discard"
              disabled={!snapshot.dirty || snapshot.saving}
              onPress={discard}
            />
            <RoundButton
              size="small"
              title={
                snapshot.saving
                  ? t('projects.scripts.editor.saving')
                  : t('projects.scripts.editor.save')
              }
              testID="project-manifest-editor.save"
              loading={snapshot.saving}
              disabled={
                !snapshot.dirty ||
                !snapshot.formEnabled ||
                snapshot.saving ||
                conflict !== null
              }
              onPress={() => {
                void save();
              }}
            />
          </View>
        }
      />
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
              showWorkspaceFileEditorComparison({
                oldText: conflict.document?.bytes ?? '',
                newText: snapshot.draft.bytes,
                filePath: '.happier/project.json',
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
      {snapshot.mode === 'raw' || snapshot.draft.status !== 'valid' ? (
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
      ) : (
        <ProjectManifestForm
          model={model}
          manifest={snapshot.draft.manifest}
          detection={props.detection}
          importCandidates={props.importCandidates}
          commands={props.commands}
          tools={props.tools}
          machineName={machineName}
        />
      )}
    </View>
  );
}

function describeDiagnostic(
  diagnostic: ProjectManifestDiagnostic,
  bytes: string,
): string {
  if (diagnostic.offset === undefined)
    return diagnostic.path.length
      ? `${diagnostic.path.join('.')}: ${diagnostic.message}`
      : diagnostic.message;
  const line = bytes.slice(0, diagnostic.offset).split('\n').length;
  return t('projects.scripts.editor.lineError', {
    line,
    message: diagnostic.message,
  });
}

const styles = StyleSheet.create(() => ({
  editor: { gap: 16 },
  headerNote: { ...Typography.default(), ...happierPageTextMetrics('pageDescription') },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  raw: { minHeight: 420, borderRadius: 14, overflow: 'hidden' },
  mono: { ...Typography.mono(), ...happierPageTextMetrics('rowDescription') },
}));
