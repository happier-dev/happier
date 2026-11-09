import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { inputOptionValueKey, isSameInputOptionValue } from '@happier-dev/protocol/inputs';
import type {
  ProjectCommandSourceV1,
  ProjectDefinitionDetectionV1,
  ProjectDefinitionImportCandidateV1,
  ProjectDevcontainerSelectionV1,
  ProjectToolchainSelectionV1,
  ProjectManifestV1,
  ProjectNativeRefV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Icon } from '@/components/ui/icons/Icon';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemAddRow } from '@/components/ui/lists/ItemAddRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useDeviceType } from '@/utils/platform/responsive';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';

import type { ProjectManifestEditorModel } from './projectManifestEditorModel';
import { getProjectManifestImportSelection } from './projectManifestImportSelection';
import {
  describeProjectCommandSource,
  describeProjectToolchain,
  findProjectInvocation,
} from './projectScriptPresentation';
import type { ProjectDefinitionInspection } from './useProjectDefinitionInspection';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ProjectNativeInvocationDetail, useProjectDefinitionDemand } from './ProjectNativeInvocationDetail';

const DiscoveryScope = React.createContext<Readonly<{ workspace: WorkspaceAddressV1; accountId: string }> | null>(null);

type Collection = 'scripts' | 'services';
type Declaration =
  | NonNullable<ProjectManifestV1['scripts']>[string]
  | NonNullable<ProjectManifestV1['services']>[string];
type Previews = Readonly<{
  commands: ProjectDefinitionInspection['commands'];
  importCandidates: readonly ProjectDefinitionImportCandidateV1[];
}>;

const ID = 'project-manifest-editor';

export type ProjectManifestFormProps = Readonly<{
  workspace?: WorkspaceAddressV1;
  accountId?: string;
  model: ProjectManifestEditorModel;
  manifest: ProjectManifestV1;
  detection: ProjectDefinitionDetectionV1;
  importCandidates: readonly ProjectDefinitionImportCandidateV1[];
  commands: ProjectDefinitionInspection['commands'];
  tools: ProjectDefinitionInspection['tools'];
  machineName: string;
  /** Phone: the section pushed in place (null lists the sections); the editor owns it so its Back can close it. */
  section: ProjectManifestFormSection | null;
  onSectionChange: (section: ProjectManifestFormSection | null) => void;
  /** Phone: whether a pushed section draws its own way back (false when the Project bar's Back closes it). */
  sectionBack: boolean;
}>;

/**
 * The Form view of the project file (plan 20 §2/§8, lab `s-scripts` EDIT): Tools, Setup,
 * Scripts, Services and what was found in the repository. Every control is one structured edit of the
 * model's single draft; nothing here writes the file, runs a command or copies a native body.
 */
export type ProjectManifestFormSection = 'toolchain' | 'setup' | 'scripts' | 'services' | 'found';
type FormSection = ProjectManifestFormSection;

export function ProjectManifestForm(props: ProjectManifestFormProps) {
  const scope = React.useMemo(() => props.workspace && props.accountId
    ? { workspace: props.workspace, accountId: props.accountId } : null, [props.workspace, props.accountId]);
  return <DiscoveryScope.Provider value={scope}><ProjectManifestFormContent {...props} /></DiscoveryScope.Provider>;
}

function ProjectManifestFormContent(props: ProjectManifestFormProps) {
  const previews: Previews = {
    commands: props.commands,
    importCandidates: props.importCandidates,
  };
  // Phone (lab EDITp): the Form lists its sections and each one pushes in place; Back keeps the draft.
  const phone = useDeviceType() === 'phone';
  const { section, onSectionChange: setSection } = props;
  const sections: Readonly<Record<FormSection, React.ReactNode>> = {
    toolchain: <ToolchainSection {...props} />,
    setup: <SetupSection model={props.model} manifest={props.manifest} detection={props.detection} previews={previews} />,
    scripts: <DeclarationSection collection="scripts" model={props.model} manifest={props.manifest} detection={props.detection} previews={previews} />,
    services: <DeclarationSection collection="services" model={props.model} manifest={props.manifest} detection={props.detection} previews={previews} />,
    found: <FoundImportsSection {...props} />,
  };
  if (!phone) {
    return (
      <View>
        {sections.toolchain}
        {sections.setup}
        {sections.scripts}
        {sections.services}
        {sections.found}
      </View>
    );
  }
  if (section) {
    return (
      <View>
        {props.sectionBack ? (
          <ItemGroup>
            <Item
              testID={`${ID}.sectionBack`}
              icon={<Icon name="caret-left" size={18} />}
              title={t('projects.scripts.editor.title')}
              showChevron={false}
              onPress={() => setSection(null)}
            />
          </ItemGroup>
        ) : null}
        {sections[section]}
      </View>
    );
  }
  return <PhoneFormSections {...props} onOpen={setSection} />;
}

/** The phone Form's section list (lab EDITp): each row summarises its section and pushes it. */
function PhoneFormSections(props: ProjectManifestFormProps & Readonly<{ onOpen: (section: FormSection) => void }>) {
  const { manifest } = props;
  const toolchain = describeToolchain(manifest.toolchain ?? { kind: 'host' });
  const tools = props.tools ?? [];
  const setup = manifest.workspace?.setup ?? [];
  const scripts = Object.entries(declarationsOf(manifest, 'scripts'));
  const services = Object.entries(declarationsOf(manifest, 'services'));
  const describeScript = (declaration: Declaration) => [
    describeProjectCommandSource(declaration.source).badge ?? describeProjectCommandSource(declaration.source).reference,
    declaration.execution === 'portable' ? t('projects.scripts.anyWorker') : t('projects.scripts.editor.thisCheckout'),
    'memoryDemand' in declaration && declaration.memoryDemand
      ? t('projects.scripts.editor.needsAbout', { size: formatHappierDataBytes(declaration.memoryDemand.bytes, { kind: 'memory' }) })
      : null,
  ].filter(Boolean).join(' · ');
  return (
    <View>
      <ItemGroup title={t('projects.scripts.editor.toolchain')}>
        <Item testID={`${ID}.section:toolchain`} title={t('projects.scripts.editor.toolsFrom')}
          subtitle={[toolchain.title, toolchain.subtitle].filter(Boolean).join(' · ')} onPress={() => props.onOpen('toolchain')} />
        {tools.length > 0 ? (
          // The tools the environment found and whether this Machine has them, without opening the section.
          <Item testID={`${ID}.section:toolchain.tools`} title={tools.map((tool) => tool.tool).join(' · ')}
            subtitle={tools.length === 1
              ? describeToolAvailability(tools[0]!.availability, props.machineName)
              : t('projects.scripts.editor.toolsCount', {
                  available: tools.filter((tool) => tool.availability === 'available').length,
                  total: tools.length,
                  machine: props.machineName,
                })}
            onPress={() => props.onOpen('toolchain')} />
        ) : null}
      </ItemGroup>
      <ItemGroup title={t('projects.scripts.editor.setup')}>
        <Item testID={`${ID}.section:setup`} title={t('projects.scripts.setup.steps', { count: setup.length })}
          subtitle={setup.map((source) => describeProjectCommandSource(source).target).join(' · ') || undefined}
          // A summary of the steps (lab EDITp): one line; the section shows each command whole.
          subtitleLines={1}
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
      {props.workspace || props.importCandidates.length > 0 ? (
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

function describeToolchain(
  selection: ProjectToolchainSelectionV1,
): Readonly<{ title: string; subtitle?: string }> {
  const { title, config } = describeProjectToolchain(selection);
  return config ? { title, subtitle: config } : { title };
}

function devcontainerPath(selection: ProjectDevcontainerSelectionV1): string {
  return selection.configPath ?? '.devcontainer/devcontainer.json';
}

function describeToolAvailability(
  availability: 'available' | 'unavailable' | 'unresolved',
  machine: string,
): string {
  return availability === 'available'
    ? t('projects.scripts.editor.toolAvailable', { machine })
    : availability === 'unavailable'
      ? t('projects.scripts.editor.toolUnavailable', { machine })
      : t('projects.scripts.editor.toolUnresolved', { machine });
}

/** Tools from (toolchain) and Devcontainer (namespace): two independent choices (plan 24 §5). */
function ToolchainSection(props: ProjectManifestFormProps) {
  const { model, manifest } = props;
  const { theme } = useUnistyles();
  const [toolsOpen, setToolsOpen] = React.useState(false);
  const [namespaceOpen, setNamespaceOpen] = React.useState(false);
  const [inspected, setInspected] = React.useState(false);
  const scope = React.useContext(DiscoveryScope);
  const phone = useDeviceType() === 'phone';
  // Once asked, the section displays its observed versions and alternatives until it closes.
  const demanded = inspected || (phone && props.section === 'toolchain');
  const tooling = useProjectDefinitionDemand(scope?.workspace ?? null, scope?.accountId ?? null, { kind: 'tools' }, demanded);
  const detection = tooling.read && 'value' in tooling.read ? tooling.read.value.detection : props.detection;
  const tools = tooling.read && 'value' in tooling.read ? tooling.read.value.tools : props.tools;
  const toolchain = manifest.toolchain ?? { kind: 'host' as const };
  const toolchainItems = React.useMemo<DropdownMenuItem[]>(() => {
    const choices: ProjectToolchainSelectionV1[] = [
      { kind: 'host' },
      ...detection.toolchains,
    ];
    if (
      !choices.some(
        (choice) => selectionId(choice) === selectionId(toolchain),
      )
    )
      choices.push(toolchain);
    return choices.map((choice) => ({
      id: selectionId(choice),
      ...describeToolchain(choice),
    }));
  }, [toolchain, detection.toolchains]);
  const otherToolchains = detection.toolchains.filter(
    (choice) => selectionId(choice) !== selectionId(toolchain),
  );
  const namespaceItems = React.useMemo<DropdownMenuItem[]>(() => {
    const choices = [...detection.devcontainers];
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
  }, [manifest.devcontainer, detection.devcontainers]);
  const showNamespace =
    scope !== null ||
    detection.devcontainers.length > 0 ||
    manifest.devcontainer !== undefined;
  const toolchainTitle = describeToolchain(toolchain);
  return (
    <ItemGroup
      title={t('projects.scripts.editor.toolchain')}
      description={t('projects.scripts.editor.toolchainBody')}
    >
      <DropdownMenu
        testID={`${ID}.toolchain`}
        open={toolsOpen}
        onOpenChange={(open) => { setToolsOpen(open); if (open) setInspected(true); }}
        items={toolchainItems}
        selectedId={selectionId(toolchain)}
        onSelect={(id) => {
          if (toolchainItems.some((item) => item.id === id))
            model.importToolchain(
              JSON.parse(id) as ProjectToolchainSelectionV1,
            );
        }}
        itemTrigger={{
          title: t('projects.scripts.editor.toolsFrom'),
          showSelectedSubtitle: false,
          subtitle:
            [
              toolchainTitle.title,
              toolchainTitle.subtitle,
              otherToolchains.length
                ? t('projects.scripts.editor.alsoFound', {
                    names: otherToolchains
                      .map(
                        (choice) =>
                          describeToolchain(choice).subtitle ??
                          describeToolchain(choice).title,
                      )
                      .join(', '),
                  })
                : null,
              // The host stays the explicit default when nothing native was found (plan 24).
              toolchain.kind === 'host' && detection.toolchains.length === 0 && (!scope || tooling.read && 'value' in tooling.read)
                ? t('projects.scripts.toolchain.empty')
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
          onOpenChange={(open) => { setNamespaceOpen(open); if (open) setInspected(true); }}
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
      {demanded && scope && (tooling.scopeError || tooling.read?.error) ? <SurfaceStateCard size="line" kind="unavailable"
        title={t('projects.widgets.scriptsUnavailable')} diagnosticCode={tooling.scopeError ?? tooling.read?.error}
        action={!tooling.scopeError || tooling.scopeError === 'unavailable'
          ? { label: t('common.retry'), onPress: tooling.retry } : undefined} /> : null}
      {demanded && scope && !tooling.scopeError && !tooling.read ? (
        // Inspection has not reported yet; nothing is evaluated while it looks.
        <Item
          testID={`${ID}.toolchain.checking`}
          mode="info"
          density="compact"
          showChevron={false}
          title={t('projects.scripts.toolchain.checking')}
        />
      ) : null}
      {(tools ?? []).map((tool) => (
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
          detail={describeToolAvailability(tool.availability, props.machineName)
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
  // Lab EDIT: the step's command is a chip on the row's right, cut short when long; a phone has no room
  // beside the label, so the command reads beneath it instead (EDITp).
  const phone = useDeviceType() === 'phone';
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
      {setup.map((source, index) => {
        const command = describeProjectCommandSource(
          source,
          findProjectInvocation(props.previews, source),
        ).command ?? describeProjectCommandSource(source).reference;
        return (
        <EditableRow
          key={keys[index]}
          testID={`${ID}.step:${index}`}
          title={t('projects.scripts.setup.step', { n: index + 1 })}
          density={phone ? undefined : 'compact'}
          subtitle={phone ? command : undefined}
          monoSubtitle={phone}
          accessoryKind="fact"
          rightElement={phone ? undefined : <CodeChip text={command} truncate />}
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
            usage="setup"
            choices={choices}
            onCommandChange={(command) => model.edit([
              { kind: 'set', path: ['workspace', 'setup', index, 'command'], value: command },
            ])}
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
        );
      })}
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
                  size: formatHappierDataBytes(memory.bytes, { kind: 'memory' }),
                })}
                sans
              />
            ) : null}
            <SegmentedTabBar
              role="radiogroup"
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
        usage={collection === 'scripts' ? 'script' : 'service'}
        choices={props.choices}
        onCommandChange={(command) => model.edit([
          { kind: 'set', path: [...path, 'source', 'command'], value: command },
        ])}
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
          value={memory ? String(memory.bytes) : ''}
          unit="B"
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
                  value: size,
                },
              ]);
            else return memory ? String(memory.bytes) : '';
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
    usage: 'script' | 'service' | 'setup';
    choices: readonly ProjectNativeRefV1[];
    /** Literal edits preserve unrecognized siblings in the lossless document. */
    onCommandChange: (command: string) => void;
    /** Choosing another native source intentionally replaces the source object. */
    onChange: (source: ProjectCommandSourceV1) => void;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const scope = React.useContext(DiscoveryScope);
  const imports = useProjectDefinitionDemand(scope?.workspace ?? null, scope?.accountId ?? null, { kind: 'imports' }, open);
  const choicesFromRead = imports.read && 'value' in imports.read ? imports.read.value.detection.entries
    .filter(entry => entry.usage === props.usage).map(entry => entry.source) : props.choices;
  const { source } = props;
  const items = React.useMemo<DropdownMenuItem[]>(() => {
    if (source.kind === 'command') return [];
    const choices = choicesFromRead.some((choice) =>
      isSameInputOptionValue(choice, source),
    )
      ? choicesFromRead
      : [source, ...choicesFromRead];
    return choices.map((choice) => ({
      id: selectionId(choice),
      title: describeProjectCommandSource(choice).reference,
    }));
  }, [choicesFromRead, source]);
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
          props.onCommandChange(draft);
        }}
      />
    );
  }
  return (
    <>
    <DropdownMenu
      testID={`${props.testID}.source`}
      open={open}
      onOpenChange={setOpen}
      items={items}
      selectedId={selectionId(source)}
      onSelect={(id) => {
        const next = choicesFromRead.find((choice) => selectionId(choice) === id);
        if (next) props.onChange(next);
      }}
      itemTrigger={{
        title: t('projects.scripts.editor.source'),
        showSelectedSubtitle: false,
        subtitle: describeProjectCommandSource(source).reference,
      }}
    />
    {open && scope && !imports.scopeError && !imports.read ? <SurfaceStateCard size="line" kind="loading"
      title={t('projects.scripts.definition.inspecting')} /> : null}
    {open && scope && (imports.scopeError || imports.read?.error) ? <SurfaceStateCard size="line" kind="unavailable"
      title={t('projects.widgets.scriptsUnavailable')} diagnosticCode={imports.scopeError ?? imports.read?.error}
      action={!imports.scopeError || imports.scopeError === 'unavailable'
        ? { label: t('common.retry'), onPress: imports.retry } : undefined} /> : null}
    {scope ? <ProjectNativeInvocationDetail workspace={scope.workspace} accountId={scope.accountId}
      source={source} usage={props.usage} testID={`${props.testID}.nativeDetail`} /> : null}
    </>
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
    /**
     * `control` (default): a control of its own beside the label, moved beneath it when the row is narrow.
     * `fact`: something read, not pressed (a step's command chip); it stays beside the label, part of the
     * row's press, and is cut short when long.
     */
    accessoryKind?: 'control' | 'fact';
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
          accessoryLayout={props.accessoryKind === 'fact' ? 'inline' : 'adaptive'}
          rightElementOutsidePressable={props.accessoryKind !== 'fact'}
          rightElement={
            <View style={[styles.inline, styles.trailing]}>
              {props.rightElement}
              <DisclosureCaret expanded={expanded} size={14} />
            </View>
          }
        />
      )}
    >
      {expanded ? props.children : null}
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
        <ItemAddRow
          testID={props.testID}
          density="compact"
          title={props.label}
          expanded={open}
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

/**
 * Found in the repository (plan 20 §2 detected-source selection): every inspector offer stays
 * visible. Checking one adds its reference to the draft, unchecking removes it; a missing or unproved
 * tool stays visible and excluded, and a name already used in the file is named, never overwritten.
 */
function FoundImportsSection(props: ProjectManifestFormProps) {
  const phone = useDeviceType() === 'phone';
  const [expanded, setExpanded] = React.useState(false);
  if (phone) return <FoundImports {...props} />;
  return <ItemGroup>
    <ExpandableItem testID={`${ID}.found.disclosure`} expanded={expanded} onExpandedChange={setExpanded}
      header={({ headerProps }) => <Item {...headerProps} testID={`${ID}.found.open`}
        title={t('projects.scripts.editor.found')} showChevron={false}
        rightElement={<DisclosureCaret expanded={expanded} size={14} />} />}>
      {expanded ? <FoundImports {...props} /> : null}
    </ExpandableItem>
  </ItemGroup>;
}

function FoundImports(props: ProjectManifestFormProps) {
  const scope = React.useContext(DiscoveryScope);
  const phone = useDeviceType() === 'phone';
  const { read, retry, scopeError } = useProjectDefinitionDemand(scope?.workspace ?? null, scope?.accountId ?? null, { kind: 'imports' }, true);
  if (scope && (scopeError || read?.error)) return <SurfaceStateCard size="line" kind="unavailable"
    title={t('projects.widgets.scriptsUnavailable')} diagnosticCode={scopeError ?? read?.error}
    action={!scopeError || scopeError === 'unavailable' ? { label: t('common.retry'), onPress: retry } : undefined}
    testID={`${ID}.found.error`} />;
  if (scope && !read) return <SurfaceStateCard size="line" kind="loading"
    title={t('projects.scripts.definition.inspecting')} testID={`${ID}.found.loading`} />;
  const candidates = read && 'value' in read ? read.value.importCandidates : props.importCandidates;
  if (candidates.length === 0) return <SurfaceStateCard size="line" kind="empty"
    title={t('projects.widgets.scriptsEmpty')} testID={`${ID}.found.empty`} />;
  return <FoundSection model={props.model} manifest={props.manifest} importCandidates={candidates}
    machineName={props.machineName} showHeading={phone} />;
}

function FoundSection(
  props: Readonly<{
    model: ProjectManifestEditorModel;
    manifest: ProjectManifestV1;
    importCandidates: readonly ProjectDefinitionImportCandidateV1[];
    machineName: string;
    showHeading?: boolean;
  }>,
) {
  const { model, manifest } = props;
  const { theme } = useUnistyles();
  const [namingIndex, setNamingIndex] = React.useState<number | null>(null);
  const [importName, setImportName] = React.useState('');
  // The draft owns selection: preserve the first declaration/step for each exact canonical source.
  const selected = React.useMemo(() => {
    const names = { scripts: new Map<string, string>(), services: new Map<string, string>() };
    for (const collection of ['scripts', 'services'] as const) {
      for (const [name, declaration] of Object.entries(manifest[collection] ?? {})) {
        const key = inputOptionValueKey(declaration.source);
        if (!names[collection].has(key)) names[collection].set(key, name);
      }
    }
    const steps = new Map<string, number>();
    for (const [index, source] of (manifest.workspace?.setup ?? []).entries()) {
      const key = inputOptionValueKey(source);
      if (!steps.has(key)) steps.set(key, index);
    }
    return { names, steps };
  }, [manifest.scripts, manifest.services, manifest.workspace?.setup]);
  const rows = getProjectManifestImportSelection(props.importCandidates).rows;
  if (rows.length === 0) return null;
  return (
    <ItemGroup
      title={props.showHeading === false ? undefined : t('projects.scripts.editor.found')}
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
        const sourceKey = inputOptionValueKey(source);
        const name = collection ? selected.names[collection].get(sourceKey) ?? null : null;
        const step = collection ? -1 : selected.steps.get(sourceKey) ?? -1;
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
        const description = describeProjectCommandSource(source);
        const disabled = !checked && !enabled;
        const trimmedName = importName.trim();
        const importNameTaken = collection !== null && Object.hasOwn(manifest[collection] ?? {}, trimmedName);
        return (
          <React.Fragment key={index}>
          <NativeImportRow rowId={`${ID}.found:${index}`} source={source} usage={usage}
            header={(detailControl) => (
          <Item
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
            rightElement={detailControl}
            rightElementOutsidePressable
            onPress={() => {
              if (collection && name) model.removeDeclaration(collection, name);
              else if (!collection && step >= 0) model.removeSetupStep(step);
              else if (collection && (taken || candidate.availability === 'ambiguous')) {
                setImportName(source.target);
                setNamingIndex(index);
              }
              else
                model.importNative({
                  usage,
                  ...(collection ? { name: source.target } : {}),
                  source,
                });
            }}
          />
            )}
          />
          <InlineAddExpander
            trigger={null}
            title={t('projects.scripts.editor.name')}
            helpText={reason ?? undefined}
            isOpen={namingIndex === index}
            onOpenChange={(open) => setNamingIndex(open ? index : null)}
            cancelLabel={t('common.cancel')}
            saveLabel={t('common.add')}
            cancelTestID={`${ID}.found:${index}.cancel`}
            saveTestID={`${ID}.found:${index}.save`}
            saveDisabled={!enabled || !trimmedName || importNameTaken}
            onCancel={() => setNamingIndex(null)}
            onSave={() => {
              if (enabled && collection && model.importNative({ usage, name: trimmedName, source })) setNamingIndex(null);
            }}
          >
            <FieldTextInput
              testID={`${ID}.found:${index}.name`}
              value={importName}
              onChangeText={setImportName}
              accessibilityLabel={t('projects.scripts.editor.name')}
              autoCapitalize="none"
              error={importNameTaken ? t('projects.scripts.editor.nameTaken', { name: trimmedName }) : null}
            />
          </InlineAddExpander>
          </React.Fragment>
        );
      })}
    </ItemGroup>
  );
}

/** The checkbox edits selection; its separate disclosure previews only this exact native reference. */
function NativeImportRow(props: Readonly<{
  rowId: string;
  source: ProjectNativeRefV1;
  usage: 'script' | 'service' | 'setup';
  header: (detailControl: React.ReactNode) => React.ReactElement;
}>) {
  const scope = React.useContext(DiscoveryScope);
  const [expanded, setExpanded] = React.useState(false);
  return <ExpandableItem testID={`${props.rowId}.disclosure`} expanded={expanded} onExpandedChange={setExpanded}
    header={props.header(<IconButton testID={`${props.rowId}.details`} variant="plain"
      iconName={expanded ? 'caret-down' : 'caret-right'} iconSize={14} expanded={expanded}
      accessibilityLabel={`${t(expanded ? 'common.collapse' : 'common.expand')} · ${props.source.target}`}
      onPress={() => setExpanded(value => !value)} />)}>
    {expanded && scope ? <ProjectNativeInvocationDetail workspace={scope.workspace} accountId={scope.accountId}
      source={props.source} usage={props.usage} testID={`${props.rowId}.nativeDetail`} /> : null}
  </ExpandableItem>;
}

function ServiceMark() {
  const { theme } = useUnistyles();
  return <Icon name="hard-drives" size={18} color={theme.colors.text.secondary} />;
}

/** A command or size in the shared neutral chip (lab code chips). */
function CodeChip(props: Readonly<{ text: string; sans?: boolean; truncate?: boolean }>) {
  return (
    <StatusPill
      variant="neutral"
      hideDot
      label={props.text}
      labelVariant="phrase"
      labelStyle={props.sans ? undefined : styles.mono}
      {...(props.truncate ? { labelNumberOfLines: 1 } : {})}
    />
  );
}

const styles = StyleSheet.create(() => ({
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // The row's trailing slot: its chip gives way (ellipsis) so the disclosure caret keeps the trailing edge.
  trailing: { flexShrink: 1, minWidth: 0, justifyContent: 'flex-end' },
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
