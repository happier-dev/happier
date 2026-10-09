import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { isSameInputOptionValue } from '@happier-dev/protocol/inputs';
import type {
  ProjectCommandSourceV1,
  ProjectDefinitionDetectionV1,
  ProjectDefinitionImportCandidateV1,
  ProjectDevcontainerSelectionV1,
  ProjectEnvironmentSelectionV1,
  ProjectManifestV1,
  ProjectNativeRefV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Icon } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

import type { ProjectManifestEditorModel } from './projectManifestEditorModel';
import { getProjectManifestImportSelection } from './projectManifestImportSelection';
import {
  describeProjectCommandSource,
  describeProjectEnvironment,
  findProjectInvocation,
} from './projectScriptPresentation';
import type { ProjectDefinitionInspection } from './useProjectDefinitionInspection';

type Collection = 'scripts' | 'services';
type Declaration =
  | NonNullable<ProjectManifestV1['scripts']>[string]
  | NonNullable<ProjectManifestV1['services']>[string];
type Previews = Readonly<{
  commands: ProjectDefinitionInspection['commands'];
  importCandidates: readonly ProjectDefinitionImportCandidateV1[];
}>;

const GIB = 2 ** 30;
const ID = 'project-manifest-editor';

export type ProjectManifestFormProps = Readonly<{
  model: ProjectManifestEditorModel;
  manifest: ProjectManifestV1;
  detection: ProjectDefinitionDetectionV1;
  importCandidates: readonly ProjectDefinitionImportCandidateV1[];
  commands: ProjectDefinitionInspection['commands'];
  tools: ProjectDefinitionInspection['tools'];
  machineName: string;
}>;

/**
 * The Form view of the project file (plan 20 §2/§8, lab `s-scripts` EDIT): Environment, Setup,
 * Scripts, Services and what was found in the repository. Every control is one structured edit of the
 * model's single draft; nothing here writes the file, runs a command or copies a native body.
 */
type FormSection = 'environment' | 'setup' | 'scripts' | 'services' | 'found';

export function ProjectManifestForm(props: ProjectManifestFormProps) {
  const previews: Previews = {
    commands: props.commands,
    importCandidates: props.importCandidates,
  };
  // Phone (lab EDITp): the Form lists its sections and each one pushes in place; Back keeps the draft.
  const phone = useDeviceType() === 'phone';
  const [section, setSection] = React.useState<FormSection | null>(null);
  const sections: Readonly<Record<FormSection, React.ReactNode>> = {
    environment: <EnvironmentSection {...props} />,
    setup: <SetupSection model={props.model} manifest={props.manifest} detection={props.detection} previews={previews} />,
    scripts: <DeclarationSection collection="scripts" model={props.model} manifest={props.manifest} detection={props.detection} previews={previews} />,
    services: <DeclarationSection collection="services" model={props.model} manifest={props.manifest} detection={props.detection} previews={previews} />,
    found: <FoundSection model={props.model} manifest={props.manifest} importCandidates={props.importCandidates} previews={previews} machineName={props.machineName} />,
  };
  if (!phone) {
    return (
      <View style={styles.form}>
        {sections.environment}
        {sections.setup}
        {sections.scripts}
        {sections.services}
        {sections.found}
      </View>
    );
  }
  if (section) {
    return (
      <View style={styles.form}>
        <ItemGroup>
          <Item
            testID={`${ID}.sectionBack`}
            icon={<Icon name="caret-left" size={18} />}
            title={t('projects.scripts.editor.title')}
            showChevron={false}
            onPress={() => setSection(null)}
          />
        </ItemGroup>
        {sections[section]}
      </View>
    );
  }
  return <PhoneFormSections {...props} onOpen={setSection} />;
}

/** The phone Form's section list (lab EDITp): each row summarises its section and pushes it. */
function PhoneFormSections(props: ProjectManifestFormProps & Readonly<{ onOpen: (section: FormSection) => void }>) {
  const { manifest } = props;
  const environment = describeEnvironment(manifest.environment ?? { kind: 'host' });
  const setup = manifest.workspace?.setup ?? [];
  const scripts = Object.entries(declarationsOf(manifest, 'scripts'));
  const services = Object.entries(declarationsOf(manifest, 'services'));
  const describeScript = (declaration: Declaration) => [
    describeProjectCommandSource(declaration.source).badge ?? describeProjectCommandSource(declaration.source).reference,
    declaration.execution === 'portable' ? t('projects.scripts.anyWorker') : t('projects.scripts.editor.thisCheckout'),
    'memoryDemand' in declaration && declaration.memoryDemand
      ? t('projects.scripts.editor.needsAbout', { size: `${Math.max(1, Math.round(declaration.memoryDemand.bytes / GIB))} GB` })
      : null,
  ].filter(Boolean).join(' · ');
  return (
    <View style={styles.form}>
      <ItemGroup title={t('projects.scripts.editor.environment')}>
        <Item testID={`${ID}.section:environment`} title={t('projects.scripts.editor.toolsFrom')}
          subtitle={[environment.title, environment.subtitle].filter(Boolean).join(' · ')} onPress={() => props.onOpen('environment')} />
      </ItemGroup>
      <ItemGroup title={t('projects.scripts.editor.setup')}>
        <Item testID={`${ID}.section:setup`} title={t('projects.scripts.setup.steps', { count: setup.length })}
          subtitle={setup.map((source) => describeProjectCommandSource(source).target).join(' · ') || undefined}
          onPress={() => props.onOpen('setup')} />
      </ItemGroup>
      <ItemGroup title={t('projects.scripts.editor.scripts')}>
        {scripts.length === 0 ? (
          <Item testID={`${ID}.section:scripts`} title={t('projects.scripts.editor.noScripts')} onPress={() => props.onOpen('scripts')} />
        ) : scripts.map(([name, declaration]) => (
          <Item key={name} testID={`${ID}.section:scripts:${name}`} title={name} subtitle={describeScript(declaration)} onPress={() => props.onOpen('scripts')} />
        ))}
      </ItemGroup>
      <ItemGroup title={t('projects.scripts.editor.services')}>
        {services.length === 0 ? (
          <Item testID={`${ID}.section:services`} title={t('projects.scripts.editor.noServices')} onPress={() => props.onOpen('services')} />
        ) : services.map(([name, declaration]) => (
          <Item key={name} testID={`${ID}.section:services:${name}`} title={name}
            subtitle={describeProjectCommandSource(declaration.source).reference} onPress={() => props.onOpen('services')} />
        ))}
      </ItemGroup>
      {props.importCandidates.length > 0 ? (
        <ItemGroup>
          <Item testID={`${ID}.section:found`} title={t('projects.scripts.editor.found')} onPress={() => props.onOpen('found')} />
        </ItemGroup>
      ) : null}
    </View>
  );
}

function selectionId(selection: unknown): string {
  return JSON.stringify(selection);
}

function describeEnvironment(
  selection: ProjectEnvironmentSelectionV1,
): Readonly<{ title: string; subtitle?: string }> {
  const { title, config } = describeProjectEnvironment(selection);
  return config ? { title, subtitle: config } : { title };
}

function devcontainerPath(selection: ProjectDevcontainerSelectionV1): string {
  return selection.configPath ?? '.devcontainer/devcontainer.json';
}

/** Tools from (toolchain) and Devcontainer (namespace): two independent choices (plan 24 §5). */
function EnvironmentSection(props: ProjectManifestFormProps) {
  const { model, manifest } = props;
  const { theme } = useUnistyles();
  const [toolsOpen, setToolsOpen] = React.useState(false);
  const [namespaceOpen, setNamespaceOpen] = React.useState(false);
  const environment = manifest.environment ?? { kind: 'host' as const };
  const environmentItems = React.useMemo<DropdownMenuItem[]>(() => {
    const choices: ProjectEnvironmentSelectionV1[] = [
      { kind: 'host' },
      ...props.detection.environments,
    ];
    if (
      !choices.some(
        (choice) => selectionId(choice) === selectionId(environment),
      )
    )
      choices.push(environment);
    return choices.map((choice) => ({
      id: selectionId(choice),
      ...describeEnvironment(choice),
    }));
  }, [environment, props.detection.environments]);
  const otherEnvironments = props.detection.environments.filter(
    (choice) => selectionId(choice) !== selectionId(environment),
  );
  const namespaceItems = React.useMemo<DropdownMenuItem[]>(() => {
    const choices = [...props.detection.devcontainers];
    if (
      manifest.devcontainer &&
      !choices.some(
        (choice) => selectionId(choice) === selectionId(manifest.devcontainer),
      )
    )
      choices.push(manifest.devcontainer);
    return [
      {
        id: 'none',
        testID: `${ID}.devcontainer:none`,
        title: t('projects.scripts.editor.devcontainerNone'),
        subtitle: t('projects.scripts.editor.devcontainerNoneDetail'),
      },
      ...choices.map((choice, index) => ({
        id: selectionId(choice),
        testID: `${ID}.devcontainer:${index}`,
        title: devcontainerPath(choice),
      })),
    ];
  }, [manifest.devcontainer, props.detection.devcontainers]);
  const showNamespace =
    props.detection.devcontainers.length > 0 ||
    manifest.devcontainer !== undefined;
  const environmentTitle = describeEnvironment(environment);
  return (
    <ItemGroup
      title={t('projects.scripts.editor.environment')}
      description={t('projects.scripts.editor.environmentBody')}
    >
      <DropdownMenu
        testID={`${ID}.environment`}
        open={toolsOpen}
        onOpenChange={setToolsOpen}
        items={environmentItems}
        selectedId={selectionId(environment)}
        onSelect={(id) => {
          if (environmentItems.some((item) => item.id === id))
            model.importEnvironment(
              JSON.parse(id) as ProjectEnvironmentSelectionV1,
            );
        }}
        itemTrigger={{
          title: t('projects.scripts.editor.toolsFrom'),
          showSelectedSubtitle: false,
          subtitle:
            [
              environmentTitle.title,
              environmentTitle.subtitle,
              otherEnvironments.length
                ? t('projects.scripts.editor.alsoFound', {
                    names: otherEnvironments
                      .map(
                        (choice) =>
                          describeEnvironment(choice).subtitle ??
                          describeEnvironment(choice).title,
                      )
                      .join(', '),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || undefined,
        }}
      />
      {showNamespace ? (
        <DropdownMenu
          testID={`${ID}.devcontainer`}
          open={namespaceOpen}
          onOpenChange={setNamespaceOpen}
          items={namespaceItems}
          selectedId={
            manifest.devcontainer ? selectionId(manifest.devcontainer) : 'none'
          }
          onSelect={(id) => {
            if (id === 'none') model.selectDevcontainer(null);
            else if (namespaceItems.some((item) => item.id === id))
              model.selectDevcontainer(
                JSON.parse(id) as ProjectDevcontainerSelectionV1,
              );
          }}
          itemTrigger={{
            title: t('projects.scripts.editor.devcontainer'),
            showSelectedSubtitle: false,
            subtitle: manifest.devcontainer
              ? devcontainerPath(manifest.devcontainer)
              : t('projects.scripts.editor.devcontainerNoneDetail'),
          }}
        />
      ) : null}
      {(props.tools ?? []).map((tool) => (
        <Item
          key={`${tool.tool}:${tool.file}`}
          testID={`${ID}.tool:${tool.tool}`}
          mode="info"
          density="compact"
          showChevron={false}
          title={tool.tool}
          titleAccessory={
            tool.version ? (
              <Text
                testID={`${ID}.tool:${tool.tool}.version`}
                style={[
                  styles.toolVersion,
                  { color: theme.colors.text.secondary },
                ]}
              >
                {tool.version}
              </Text>
            ) : undefined
          }
          // The requested version is intent; it is named as such and never shown as installed.
          subtitle={
            !tool.version && tool.requestedVersion
              ? t('projects.scripts.editor.toolRequested', {
                  version: tool.requestedVersion,
                  file: tool.file,
                })
              : undefined
          }
          detail={
            tool.availability === 'available'
              ? t('projects.scripts.editor.toolAvailable', {
                  machine: props.machineName,
                })
              : tool.availability === 'unavailable'
                ? t('projects.scripts.editor.toolUnavailable', {
                    machine: props.machineName,
                  })
                : t('projects.scripts.editor.toolUnresolved', {
                    machine: props.machineName,
                  })
          }
        />
      ))}
    </ItemGroup>
  );
}

function moved<T>(values: readonly T[], from: number, to: number): T[] {
  const next = [...values];
  const [value] = next.splice(from, 1);
  next.splice(to, 0, value!);
  return next;
}

function SetupSection(
  props: Readonly<{
    model: ProjectManifestEditorModel;
    manifest: ProjectManifestV1;
    detection: ProjectDefinitionDetectionV1;
    previews: Previews;
  }>,
) {
  const { model } = props;
  const setup = props.manifest.workspace?.setup ?? [];
  const choices = props.detection.entries
    .filter((entry) => entry.usage === 'setup')
    .map((entry) => entry.source);
  // Row identities follow each step through edits and moves, so an open step stays open (like
  // StringListField); a change from elsewhere (JSON, reload) starts fresh identities.
  const keysRef = React.useRef<string[]>([]);
  const nextKeyRef = React.useRef(0);
  if (keysRef.current.length !== setup.length)
    keysRef.current = setup.map((_, index) => keysRef.current[index] ?? `step-${nextKeyRef.current++}`);
  const keys = keysRef.current;
  const positions = setup.map((_, index) => index);
  return (
    <ItemGroup
      title={t('projects.scripts.editor.setup')}
      description={t('projects.scripts.editor.setupBody')}
    >
      {setup.map((source, index) => (
        <EditableRow
          key={keys[index]}
          testID={`${ID}.step:${index}`}
          title={t('projects.scripts.setup.step', { n: index + 1 })}
          density="compact"
          rightElement={
            <CodeChip
              text={
                describeProjectCommandSource(
                  source,
                  findProjectInvocation(props.previews, source),
                ).command ?? describeProjectCommandSource(source).reference
              }
            />
          }
          position={index}
          count={setup.length}
          onMove={(to) => {
            if (model.reorderSetupSteps(moved(positions, index, to))) keysRef.current = moved(keys, index, to);
          }}
          onRemove={() => {
            if (model.removeSetupStep(index)) keysRef.current = keys.filter((_, position) => position !== index);
          }}
        >
          <SourceField
            testID={`${ID}.step:${index}`}
            source={source}
            choices={choices}
            onChange={(next) =>
              model.edit([
                {
                  kind: 'set',
                  path: ['workspace', 'setup', index],
                  value: next,
                },
              ])
            }
          />
        </EditableRow>
      ))}
      <AddCommand
        testID={`${ID}.addStep`}
        label={t('projects.scripts.editor.addStep')}
        presentation="row"
        named={false}
        onAdd={(command) =>
          model.edit([
            {
              kind: 'set',
              path: ['workspace', 'setup', setup.length],
              value: { kind: 'command', command },
            },
          ])
        }
      />
    </ItemGroup>
  );
}

function DeclarationSection(
  props: Readonly<{
    collection: Collection;
    model: ProjectManifestEditorModel;
    manifest: ProjectManifestV1;
    detection: ProjectDefinitionDetectionV1;
    previews: Previews;
  }>,
) {
  const { collection, model } = props;
  const declarations = Object.entries(declarationsOf(props.manifest, collection));
  const names = declarations.map(([name]) => name);
  const usage = collection === 'scripts' ? 'script' : 'service';
  const choices = props.detection.entries
    .filter((entry) => entry.usage === usage)
    .map((entry) => entry.source);
  const scripts = collection === 'scripts';
  return (
    <ItemGroup
      title={t(
        scripts
          ? 'projects.scripts.editor.scripts'
          : 'projects.scripts.editor.services',
      )}
      description={t(
        scripts
          ? 'projects.scripts.editor.scriptsBody'
          : 'projects.scripts.editor.servicesBody',
      )}
    >
      {declarations.length === 0 ? (
        <Item
          mode="info"
          title={t(
            scripts
              ? 'projects.scripts.editor.noScripts'
              : 'projects.scripts.editor.noServices',
          )}
          showChevron={false}
        />
      ) : (
        declarations.map(([name, declaration], index) => (
          <DeclarationRow
            key={name}
            collection={collection}
            model={model}
            name={name}
            declaration={declaration}
            previews={props.previews}
            choices={choices}
            position={index}
            count={declarations.length}
            onMove={(to) =>
              model.reorderDeclarations(collection, moved(names, index, to))
            }
          />
        ))
      )}
      <AddCommand
        testID={`${ID}.${scripts ? 'addScript' : 'addService'}`}
        label={t(
          scripts
            ? 'projects.scripts.editor.addScript'
            : 'projects.scripts.editor.addService',
        )}
        presentation="row"
        named
        isNameTaken={(name) =>
          Object.hasOwn(props.manifest[collection] ?? {}, name)
        }
        onAdd={(command, name) =>
          model.edit([
            {
              kind: 'set',
              path: [collection, name!],
              value: { source: { kind: 'command', command } },
            },
          ])
        }
      />
    </ItemGroup>
  );
}

function DeclarationRow(
  props: Readonly<{
    collection: Collection;
    model: ProjectManifestEditorModel;
    name: string;
    declaration: Declaration;
    previews: Previews;
    choices: readonly ProjectNativeRefV1[];
    position: number;
    count: number;
    onMove: (to: number) => void;
  }>,
) {
  const { model, name, declaration, collection } = props;
  const testID = `${ID}.${collection === 'scripts' ? 'script' : 'service'}:${name}`;
  const reference = describeProjectCommandSource(declaration.source).reference;
  const port = 'port' in declaration ? declaration.port : undefined;
  const memory =
    'memoryDemand' in declaration ? declaration.memoryDemand : undefined;
  const executionTabs = React.useMemo(
    () => [
      {
        id: 'primary' as const,
        label: t('projects.scripts.editor.thisCheckout'),
      },
      { id: 'portable' as const, label: t('projects.scripts.anyWorker') },
    ],
    [],
  );
  const path = [collection, name];
  return (
    <EditableRow
      testID={testID}
      title={name}
      subtitle={
        collection === 'services'
          ? [
              reference,
              port
                ? t('projects.scripts.editor.port', { port })
                : t('projects.scripts.editor.noAddress'),
            ].join(' · ')
          : reference
      }
      monoSubtitle={collection === 'scripts'}
      icon={collection === 'services' ? <ServiceMark /> : undefined}
      rightElement={
        collection === 'scripts' ? (
          <View style={styles.inline}>
            {memory ? (
              <CodeChip
                text={t('projects.scripts.editor.needsAbout', {
                  size: `${Math.max(1, Math.round(memory.bytes / GIB))} GB`,
                })}
                sans
              />
            ) : null}
            <SegmentedTabBar
              role="radiogroup"
              compact
              segmentSizing="content"
              accessibilityLabel={t('projects.scripts.editor.runsOn', { name })}
              testIDPrefix={`${testID}.execution`}
              tabs={executionTabs}
              activeTabId={declaration.execution ?? 'primary'}
              onSelectTab={(execution) => {
                model.edit([
                  {
                    kind: 'set',
                    path: [...path, 'execution'],
                    value: execution,
                  },
                ]);
              }}
            />
          </View>
        ) : undefined
      }
      position={props.position}
      count={props.count}
      onMove={props.onMove}
      onRemove={() => model.removeDeclaration(collection, name)}
    >
      <FieldValueItem
        title={t('projects.scripts.editor.name')}
        value={name}
        fieldTestID={`${testID}.name`}
        autoCapitalize="none"
        // A taken or empty name is refused and the field shows the saved name again.
        onCommit={(draft) =>
          model.renameDeclaration(collection, name, draft) ? draft.trim() : name
        }
      />
      <SourceField
        testID={testID}
        source={declaration.source}
        choices={props.choices}
        onChange={(source) =>
          model.edit([
            { kind: 'set', path: [...path, 'source'], value: source },
          ])
        }
      />
      {collection === 'scripts' ? (
        <FieldValueItem
          title={t('projects.scripts.editor.needsAboutField')}
          subtitle={t('projects.scripts.editor.needsAboutHint')}
          value={
            memory ? String(Math.max(1, Math.round(memory.bytes / GIB))) : ''
          }
          unit="GB"
          kind="integer"
          allowEmpty
          fieldTestID={`${testID}.memory`}
          onCommit={(draft) => {
            const size = Number(draft);
            if (!draft)
              model.edit([{ kind: 'remove', path: [...path, 'memoryDemand'] }]);
            else if (Number.isSafeInteger(size) && size > 0)
              model.edit([
                {
                  kind: 'set',
                  path: [...path, 'memoryDemand', 'bytes'],
                  value: size * GIB,
                },
              ]);
            else return memory ? String(Math.round(memory.bytes / GIB)) : '';
          }}
        />
      ) : (
        <FieldValueItem
          title={t('projects.scripts.editor.portField')}
          value={port ? String(port) : ''}
          kind="integer"
          allowEmpty
          fieldTestID={`${testID}.port`}
          onCommit={(draft) => {
            const value = Number(draft);
            if (!draft)
              model.edit([{ kind: 'remove', path: [...path, 'port'] }]);
            else if (Number.isInteger(value) && value >= 1 && value <= 65535)
              model.edit([{ kind: 'set', path: [...path, 'port'], value }]);
            else return port ? String(port) : '';
          }}
        />
      )}
    </EditableRow>
  );
}

/**
 * What runs: a literal command is typed in place; a native reference is chosen among the references
 * the inspector found (its command stays in its own file).
 */
function SourceField(
  props: Readonly<{
    testID: string;
    source: ProjectCommandSourceV1;
    choices: readonly ProjectNativeRefV1[];
    onChange: (source: ProjectCommandSourceV1) => void;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const { source } = props;
  const items = React.useMemo<DropdownMenuItem[]>(() => {
    if (source.kind === 'command') return [];
    const choices = props.choices.some((choice) =>
      isSameInputOptionValue(choice, source),
    )
      ? props.choices
      : [source, ...props.choices];
    return choices.map((choice) => ({
      id: selectionId(choice),
      title: describeProjectCommandSource(choice).reference,
    }));
  }, [props.choices, source]);
  if (source.kind === 'command') {
    return (
      <FieldValueItem
        title={t('projects.scripts.editor.command')}
        value={source.command}
        monospace
        autoCapitalize="none"
        fieldTestID={`${props.testID}.command`}
        // A command can't be empty: an empty draft returns to the saved command.
        onCommit={(draft) => {
          if (!draft.trim()) return source.command;
          props.onChange({ ...source, command: draft });
        }}
      />
    );
  }
  return (
    <DropdownMenu
      testID={`${props.testID}.source`}
      open={open}
      onOpenChange={setOpen}
      items={items}
      selectedId={selectionId(source)}
      onSelect={(id) => {
        const next = props.choices.find((choice) => selectionId(choice) === id);
        if (next) props.onChange(next);
      }}
      itemTrigger={{
        title: t('projects.scripts.editor.source'),
        showSelectedSubtitle: false,
        subtitle: describeProjectCommandSource(source).reference,
      }}
    />
  );
}

/**
 * One editable declaration or step: its lab row as the header, its fields below. Move and Remove
 * reorder or drop the declaration in the draft; they never stop running work.
 */
function EditableRow(
  props: Readonly<{
    testID: string;
    title: string;
    subtitle?: string;
    monoSubtitle?: boolean;
    icon?: React.ReactNode;
    density?: 'compact';
    rightElement?: React.ReactNode;
    position: number;
    count: number;
    onMove: (to: number) => void;
    onRemove: () => void;
    children: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);
  return (
    <ExpandableItem
      testID={`${props.testID}.disclosure`}
      expanded={expanded}
      onExpandedChange={setExpanded}
      header={({ headerProps }) => (
        <Item
          {...(headerProps as Readonly<Record<string, unknown>>)}
          testID={props.testID}
          title={props.title}
          subtitle={props.subtitle}
          subtitleStyle={props.monoSubtitle ? styles.mono : undefined}
          icon={props.icon}
          density={props.density}
          showChevron={false}
          accessoryLayout="adaptive"
          rightElementOutsidePressable
          rightElement={
            <View style={styles.inline}>
              {props.rightElement}
              <Icon
                name={expanded ? 'caret-up' : 'caret-down'}
                size={14}
                color={theme.colors.text.tertiary}
              />
            </View>
          }
        />
      )}
    >
      {props.children}
      <View style={styles.rowActions}>
        <RoundButton
          size="small"
          display="secondary"
          testID={`${props.testID}.moveUp`}
          title={t('common.moveUp')}
          leading={<Icon name="arrow-up" size={14} />}
          disabled={props.position === 0}
          onPress={() => props.onMove(props.position - 1)}
        />
        <RoundButton
          size="small"
          display="secondary"
          testID={`${props.testID}.moveDown`}
          title={t('common.moveDown')}
          leading={<Icon name="arrow-down" size={14} />}
          disabled={props.position >= props.count - 1}
          onPress={() => props.onMove(props.position + 1)}
        />
        <RoundButton
          size="small"
          display="destructive"
          testID={`${props.testID}.remove`}
          title={t('common.remove')}
          leading={<Icon name="trash" size={14} />}
          onPress={props.onRemove}
        />
      </View>
    </ExpandableItem>
  );
}

/** "+ Add": a literal command (and, for a declaration, its name) written into the draft, never run. */
function AddCommand(
  props: Readonly<{
    testID: string;
    label: string;
    presentation: 'row';
    named: boolean;
    isNameTaken?: (name: string) => boolean;
    onAdd: (command: string, name?: string) => boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [command, setCommand] = React.useState('');
  const trimmedName = name.trim();
  const taken =
    props.named &&
    trimmedName !== '' &&
    (props.isNameTaken?.(trimmedName) ?? false);
  const close = () => {
    setOpen(false);
    setName('');
    setCommand('');
  };
  return (
    <InlineAddExpander
      isOpen={open}
      onOpenChange={setOpen}
      title={props.label}
      trigger={
        <Item
          testID={props.testID}
          density="compact"
          title={
            <View style={styles.addRow}>
              <Icon name="plus" size={16} color={theme.colors.text.secondary} />
              <Text
                style={[
                  styles.addLabel,
                  { color: theme.colors.text.secondary },
                ]}
              >
                {props.label}
              </Text>
            </View>
          }
          showChevron={false}
          onPress={() => setOpen(!open)}
        />
      }
      onCancel={close}
      onSave={() => {
        if (props.onAdd(command.trim(), props.named ? trimmedName : undefined))
          close();
      }}
      saveDisabled={!command.trim() || (props.named && (!trimmedName || taken))}
      cancelLabel={t('common.cancel')}
      saveLabel={t('projects.scripts.editor.add')}
      cancelTestID={`${props.testID}.cancel`}
      saveTestID={`${props.testID}.save`}
    >
      <View style={styles.addFields}>
        {props.named ? (
          <FieldTextInput
            testID={`${props.testID}.name`}
            value={name}
            onChangeText={setName}
            accessibilityLabel={t('projects.scripts.editor.name')}
            placeholder={t('projects.scripts.editor.name')}
            autoCapitalize="none"
            error={
              taken
                ? t('projects.scripts.editor.nameTaken', { name: trimmedName })
                : null
            }
          />
        ) : null}
        <FieldTextInput
          testID={`${props.testID}.command`}
          value={command}
          onChangeText={setCommand}
          accessibilityLabel={t('projects.scripts.editor.command')}
          placeholder={t('projects.scripts.editor.commandPlaceholder')}
          autoCapitalize="none"
          monospace
        />
      </View>
    </InlineAddExpander>
  );
}

function declarationsOf(manifest: ProjectManifestV1, collection: Collection): Readonly<Record<string, Declaration>> {
  return manifest[collection] ?? {};
}

function declaredName(
  manifest: ProjectManifestV1,
  collection: Collection,
  source: ProjectNativeRefV1,
): string | null {
  return (
    Object.entries(declarationsOf(manifest, collection)).find(([, declaration]) =>
      isSameInputOptionValue(declaration.source, source),
    )?.[0] ?? null
  );
}

/**
 * Found in the repository (plan 20 §2 detected-source selection): every inspector offer stays
 * visible. Checking one adds its reference to the draft, unchecking removes it; a missing or unproved
 * tool stays visible and excluded, and a name already used in the file is named, never overwritten.
 */
function FoundSection(
  props: Readonly<{
    model: ProjectManifestEditorModel;
    manifest: ProjectManifestV1;
    importCandidates: readonly ProjectDefinitionImportCandidateV1[];
    previews: Previews;
    machineName: string;
  }>,
) {
  const { model, manifest } = props;
  const { theme } = useUnistyles();
  const rows = getProjectManifestImportSelection(props.importCandidates).rows;
  if (rows.length === 0) return null;
  const setup = manifest.workspace?.setup ?? [];
  return (
    <ItemGroup
      title={t('projects.scripts.editor.found')}
      description={t('projects.scripts.editor.foundBody')}
    >
      {rows.map(({ index, candidate, enabled }) => {
        const { source, usage } = candidate;
        const collection: Collection | null =
          usage === 'setup'
            ? null
            : usage === 'script'
              ? 'scripts'
              : 'services';
        const name = collection
          ? declaredName(manifest, collection, source)
          : null;
        const step = collection
          ? -1
          : setup.findIndex((entry) => isSameInputOptionValue(entry, source));
        const checked = collection ? name !== null : step >= 0;
        const taken =
          collection !== null &&
          !checked &&
          Object.hasOwn(manifest[collection] ?? {}, source.target);
        const reason = !enabled
          ? candidate.availability === 'unavailable'
            ? t('projects.scripts.editor.foundUnavailable', {
                machine: props.machineName,
              })
            : t('projects.scripts.editor.toolUnresolved', {
                machine: props.machineName,
              })
          : taken
            ? t('projects.scripts.editor.nameTaken', { name: source.target })
            : candidate.availability === 'ambiguous'
              ? t('projects.scripts.editor.foundAmbiguous')
              : null;
        const description = describeProjectCommandSource(
          source,
          findProjectInvocation(props.previews, source),
        );
        const disabled = !checked && (!enabled || taken);
        return (
          <Item
            key={index}
            testID={`${ID}.found:${index}`}
            accessibilityRole="checkbox"
            selected={checked}
            disabled={disabled}
            icon={
              <SelectionCheckGlyph state={checked ? 'checked' : 'unchecked'} />
            }
            title={source.target}
            titleAccessory={
              <StatusPill
                variant="neutral"
                hideDot
                label={description.badge ?? source.file}
                labelStyle={styles.mono}
                style={styles.badge}
              />
            }
            subtitle={[
              t(
                usage === 'setup'
                  ? 'projects.scripts.editor.usageSetup'
                  : usage === 'script'
                    ? 'projects.scripts.editor.usageScript'
                    : 'projects.scripts.editor.usageService',
              ),
              reason ?? description.command ?? description.reference,
            ].join(' · ')}
            subtitleStyle={
              reason && !checked
                ? { color: theme.colors.text.tertiary }
                : undefined
            }
            showChevron={false}
            onPress={() => {
              if (collection && name) model.removeDeclaration(collection, name);
              else if (!collection && step >= 0) model.removeSetupStep(step);
              else
                model.importNative({
                  usage,
                  ...(collection ? { name: source.target } : {}),
                  source,
                });
            }}
          />
        );
      })}
    </ItemGroup>
  );
}

function ServiceMark() {
  const { theme } = useUnistyles();
  return <Icon name="hard-drives" size={18} color={theme.colors.text.secondary} />;
}

/** A command or size in the shared neutral chip (lab code chips). */
function CodeChip(props: Readonly<{ text: string; sans?: boolean }>) {
  return (
    <StatusPill
      variant="neutral"
      hideDot
      label={props.text}
      labelVariant="phrase"
      labelStyle={props.sans ? undefined : styles.mono}
    />
  );
}

const styles = StyleSheet.create(() => ({
  form: { gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  addLabel: { ...Typography.default(), ...happierPageTextMetrics('rowTitle') },
  addFields: { gap: 8 },
  rowActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
  },
  mono: { ...Typography.mono(), ...happierPageTextMetrics('rowDescription') },
  badge: { marginLeft: 8 },
  toolVersion: {
    ...Typography.mono(),
    ...happierPageTextMetrics('rowDescription'),
    marginLeft: 8,
  },
}));
