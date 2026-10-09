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
  ProjectEnvironmentSelectionV1,
  ProjectManifestV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { showWorkspaceFileEditorComparison } from '@/components/workspaces/files/details/workspaceFileDetails/WorkspaceFileEditorComparison';
import { CodeEditor } from '@/components/ui/code/editor/CodeEditor';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { renderPageHeaderText } from '@/components/ui/layout/PageHeader';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { StatusPill } from '@/components/ui/status/StatusPill';
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
import { describeProjectCommandSource, describeProjectEnvironment, findProjectInvocation } from './projectScriptPresentation';
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

function environmentId(selection: ProjectEnvironmentSelectionV1): string {
  return JSON.stringify(selection);
}

function describeEnvironment(
  selection: ProjectEnvironmentSelectionV1,
): Readonly<{ title: string; subtitle?: string }> {
  const { title, config } = describeProjectEnvironment(selection);
  return config ? { title, subtitle: config } : { title };
}

function formatMemoryDemand(bytes: number): string {
  return t('projects.scripts.editor.needsAbout', {
    size: `${Math.max(1, Math.round(bytes / 2 ** 30))} GB`,
  });
}

/** The Form view: Environment, Setup, Scripts and Services over the same draft. */
function ProjectManifestForm(
  props: Readonly<{
    model: ProjectManifestEditorModel;
    manifest: ProjectManifestV1;
    detection: ProjectDefinitionDetectionV1;
    importCandidates: readonly ProjectDefinitionImportCandidateV1[];
    commands: ProjectDefinitionInspection['commands'];
    tools: ProjectDefinitionInspection['tools'];
    machineName: string;
  }>,
) {
  const { model, manifest } = props;
  const previews = { commands: props.commands, importCandidates: props.importCandidates };
  const { theme } = useUnistyles();
  const [environmentOpen, setEnvironmentOpen] = React.useState(false);
  const environment = manifest.environment ?? { kind: 'host' as const };
  const environmentItems = React.useMemo<DropdownMenuItem[]>(() => {
    const choices = [
      { kind: 'host' as const },
      ...props.detection.environments,
    ];
    if (
      !choices.some(
        (choice) => environmentId(choice) === environmentId(environment),
      )
    )
      choices.push(environment);
    return choices.map((choice) => ({
      id: environmentId(choice),
      ...describeEnvironment(choice),
    }));
  }, [environment, props.detection.environments]);
  const offers = getProjectManifestImportSelection(
    props.importCandidates,
  ).rows.filter((row) => row.enabled);
  const scripts = Object.entries(manifest.scripts ?? {});
  const services = Object.entries(manifest.services ?? {});
  const setup = manifest.workspace?.setup ?? [];
  const scriptOffers = offers.filter(
    (row) =>
      row.candidate.usage === 'script' &&
      !Object.hasOwn(manifest.scripts ?? {}, row.candidate.source.target),
  );
  const setupOffers = offers.filter(
    (row) =>
      row.candidate.usage === 'setup' &&
      !setup.some(
        (source) =>
          source.kind === 'native' &&
          source.file === row.candidate.source.file &&
          source.target === row.candidate.source.target,
      ),
  );
  const executionTabs = React.useMemo(() => [
    { id: 'primary' as const, label: t('projects.scripts.editor.thisCheckout') },
    { id: 'portable' as const, label: t('projects.scripts.anyWorker') },
  ], []);
  const otherEnvironments = props.detection.environments.filter(
    (choice) => environmentId(choice) !== environmentId(environment),
  );
  return (
    <View style={styles.form}>
      <ItemGroup
        title={t('projects.scripts.editor.environment')}
        description={t('projects.scripts.editor.environmentBody')}
      >
        <DropdownMenu
          open={environmentOpen}
          onOpenChange={setEnvironmentOpen}
          items={environmentItems}
          selectedId={environmentId(environment)}
          onSelect={(id) => {
            const selection = environmentItems.find((item) => item.id === id)
              ? (JSON.parse(id) as ProjectEnvironmentSelectionV1)
              : null;
            if (selection) model.importEnvironment(selection);
          }}
          itemTrigger={{
            title: t('projects.scripts.editor.toolsFrom'),
            showSelectedSubtitle: false,
            subtitle:
              [
                describeEnvironment(environment).title,
                describeEnvironment(environment).subtitle,
                otherEnvironments.length
                  ? t('projects.scripts.editor.alsoFound', {
                      names: otherEnvironments
                        .map((choice) => describeEnvironment(choice).subtitle ?? describeEnvironment(choice).title)
                        .join(', '),
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ') || undefined,
          }}
        />
        {(props.tools ?? []).map((tool) => (
          <Item
            key={`${tool.tool}:${tool.file}`}
            testID={`project-manifest-editor.tool:${tool.tool}`}
            mode="info"
            density="compact"
            showChevron={false}
            title={tool.tool}
            titleAccessory={tool.version ? (
              <Text
                testID={`project-manifest-editor.tool:${tool.tool}.version`}
                style={[styles.toolVersion, { color: theme.colors.text.secondary }]}
              >
                {tool.version}
              </Text>
            ) : undefined}
            // The requested version is intent; it is named as such and never shown as installed.
            subtitle={!tool.version && tool.requestedVersion
              ? t('projects.scripts.editor.toolRequested', { version: tool.requestedVersion, file: tool.file })
              : undefined}
            detail={tool.availability === 'available'
              ? t('projects.scripts.editor.toolAvailable', { machine: props.machineName })
              : tool.availability === 'unavailable'
                ? t('projects.scripts.editor.toolUnavailable', { machine: props.machineName })
                : t('projects.scripts.editor.toolUnresolved', { machine: props.machineName })}
          />
        ))}
      </ItemGroup>
      <ItemGroup
        title={t('projects.scripts.editor.setup')}
        description={t('projects.scripts.editor.setupBody')}
      >
        {setup.map((source, index) => (
          <Item
            key={index}
            testID={`project-manifest-editor.step:${index}`}
            mode="info"
            density="compact"
            showChevron={false}
            title={t('projects.scripts.setup.step', { n: index + 1 })}
            rightElement={<CodeChip text={describeProjectCommandSource(source, findProjectInvocation(previews, source)).command ?? describeProjectCommandSource(source).reference} />}
          />
        ))}
        <AddMenu
          testID="project-manifest-editor.addStep"
          label={t('projects.scripts.editor.addStep')}
          presentation="row"
          items={setupOffers.map((row) => ({
            id: String(row.index),
            title: describeProjectCommandSource(row.candidate.source).reference,
          }))}
          onSelect={(id) => {
            const row = setupOffers.find((entry) => String(entry.index) === id);
            if (row) model.importNative({ usage: 'setup', source: row.candidate.source });
          }}
          onWrite={() => model.setMode('raw')}
        />
      </ItemGroup>
      <ItemGroup
        title={t('projects.scripts.editor.scripts')}
        description={t('projects.scripts.editor.scriptsBody')}
        action={
          <AddMenu
            testID="project-manifest-editor.addScript"
            label={t('projects.scripts.editor.addScript')}
            presentation="action"
            onWrite={() => model.setMode('raw')}
            items={scriptOffers.map((row) => ({
              id: String(row.index),
              title: row.candidate.source.target,
              subtitle: describeProjectCommandSource(row.candidate.source)
                .reference,
            }))}
            onSelect={(id) => {
              const row = scriptOffers.find(
                (entry) => String(entry.index) === id,
              );
              if (row)
                model.importNative({
                  usage: 'script',
                  name: row.candidate.source.target,
                  source: row.candidate.source,
                });
            }}
          />
        }
      >
        {scripts.length === 0 ? (
          <Item
            mode="info"
            title={t('projects.scripts.editor.noScripts')}
            showChevron={false}
          />
        ) : (
          scripts.map(([name, declaration]) => (
            <Item
              key={name}
              testID={`project-manifest-editor.script:${name}`}
              mode="info"
              showChevron={false}
              title={name}
              subtitle={describeProjectCommandSource(declaration.source).reference}
              subtitleStyle={styles.mono}
              accessoryLayout="adaptive"
              rightElementOutsidePressable
              rightElement={
                <View style={styles.scriptControls}>
                  {declaration.memoryDemand ? <CodeChip text={formatMemoryDemand(declaration.memoryDemand.bytes)} sans /> : null}
                  <SegmentedTabBar
                    role="radiogroup"
                    compact
                    segmentSizing="content"
                    accessibilityLabel={t('projects.scripts.editor.runsOn', { name })}
                    testIDPrefix={`project-manifest-editor.script:${name}.execution`}
                    tabs={executionTabs}
                    activeTabId={declaration.execution ?? 'primary'}
                    onSelectTab={(execution) => {
                      model.edit([{ kind: 'set', path: ['scripts', name, 'execution'], value: execution }]);
                    }}
                  />
                </View>
              }
            />
          ))
        )}
      </ItemGroup>
      {services.length > 0 ? (
        <ItemGroup
          title={t('projects.scripts.editor.services')}
          description={t('projects.scripts.editor.servicesBody')}
        >
          {services.map(([name, declaration]) => (
            <Item
              key={name}
              testID={`project-manifest-editor.service:${name}`}
              mode="info"
              showChevron={false}
              icon={
                <Icon
                  name="hard-drives"
                  size={18}
                  color={theme.colors.text.secondary}
                />
              }
              title={name}
              subtitle={[
                describeProjectCommandSource(declaration.source).reference,
                declaration.port
                  ? t('projects.scripts.editor.port', {
                      port: declaration.port,
                    })
                  : t('projects.scripts.editor.noAddress'),
              ].join(' · ')}
            />
          ))}
        </ItemGroup>
      ) : null}
    </View>
  );
}

/**
 * A section's "+ Add": found references edit the draft only and never run anything. With nothing
 * found to add, it opens JSON so a literal command can be written there.
 */
function AddMenu(
  props: Readonly<{
    testID: string;
    label: string;
    presentation: 'action' | 'row';
    items: readonly DropdownMenuItem[];
    onSelect: (id: string) => void;
    onWrite: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const render = (onPress: () => void) => props.presentation === 'row' ? (
    // The plus sits inside the title so the step titles above keep their own alignment (lab).
    <Item
      testID={props.testID}
      density="compact"
      title={(
        <View style={styles.addRow}>
          <Icon name="plus" size={16} color={theme.colors.text.secondary} />
          <Text style={[styles.addLabel, { color: theme.colors.text.secondary }]}>{props.label}</Text>
        </View>
      )}
      showChevron={false}
      onPress={onPress}
    />
  ) : (
    <RoundButton size="small" display="secondary" testID={props.testID} title={props.label}
      leading={<Icon name="plus" size={14} />} onPress={onPress} />
  );
  if (props.items.length === 0) return render(props.onWrite);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      items={props.items}
      onSelect={props.onSelect}
      trigger={({ toggle }) => render(toggle)}
    />
  );
}

/** A command or size in the shared neutral chip (lab code chips). */
function CodeChip(props: Readonly<{ text: string; sans?: boolean }>) {
  return <StatusPill variant="neutral" hideDot label={props.text} labelVariant="phrase" labelStyle={props.sans ? undefined : styles.mono} />;
}

const styles = StyleSheet.create(() => ({
  editor: { gap: 16 },
  headerNote: { ...Typography.default(), ...happierPageTextMetrics('pageDescription') },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  addLabel: { ...Typography.default(), ...happierPageTextMetrics('rowTitle') },
  scriptControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  form: { gap: 8 },
  raw: { minHeight: 420, borderRadius: 14, overflow: 'hidden' },
  mono: { ...Typography.mono(), ...happierPageTextMetrics('rowDescription') },
  badge: { marginLeft: 8 },
  toolVersion: { ...Typography.mono(), ...happierPageTextMetrics('rowDescription'), marginLeft: 8 },
}));
