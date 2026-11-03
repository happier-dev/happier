import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  isReadOnlySkillProvenanceV1,
  readSkillFrontmatterV1,
  type SkillProvenanceV1,
} from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { CapabilityBlockingBanner } from '@/components/capabilities/detail/CapabilityBlockingBanner';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import {
  CapabilityMachineTruth,
  type CapabilityMachineTruthRow,
} from '@/components/capabilities/detail/CapabilityMachineTruth';
import { AgentNameRun } from '@/components/capabilities/identity/AgentNameRun';
import {
  pickMostBlockingCapabilityStatus,
  type CapabilityStatus,
} from '@/components/capabilities/status/capabilityStatusPresentation';
import {
  WhereItsOnControl,
  useDraftReachRules,
} from '@/components/capabilities/where/WhereItsOnControl';
import { useFoundSkillsCache } from '@/sync/domains/skills/useFoundSkills';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { PageLeaveActions } from '@/components/ui/layout/PageLeaveActions';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import {
  projectReachOnMachines,
  useReachProjection,
  type ReachMachine,
} from '@/sync/domains/capabilities/reach/useReachProjection';
import { useReachRules } from '@/sync/domains/capabilities/reach/useReachRules';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

import {
  SKILLS_COLLECTION_ROUTE,
  skillHref,
  skillSource,
} from '../skillsCollectionModel';
import { skillStatus } from '../status/skillStatus';
import { SkillDetailsDisclosure } from './SkillDetailsDisclosure';
import { SkillFilesSection, readSkillFileText } from './SkillFilesSection';
import {
  SkillInstructionsSection,
  lintSkillMarkdown,
} from './SkillInstructionsSection';
import { SkillSourceSection } from './SkillSourceSection';
import { useSkillSourceNames } from '../useSkillSourceNames';
import { SKILL_DRAFT_TEMPLATE } from './skillDraftTemplate';
import { skillTextFile } from './skillFileContent';
import {
  readSkillActionRefusal,
  useSkillDetail,
  type SkillDetailModel,
} from './useSkillDetail';
import type { WhereItsOnNames } from '@/components/capabilities/where/whereItsOnPresentation';
import { summarizeMachines } from './skillMachineSummary';
import {
  useSkillMachineTruth,
  type SkillMachineTruth,
} from './useSkillMachineTruth';
import { useSkillPlaces } from '../useSkillPlaces';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';


function formatDay(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(ms);
}
function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}
function lastKnown(ms: number | null): string | undefined {
  if (!ms) return undefined;
  const sameDay = new Date(ms).toDateString() === new Date().toDateString();
  return t('capabilities.skillDetail.machines.lastKnown', {
    time: sameDay ? formatTime(ms) : formatDay(ms),
  });
}


/**
 * A skill (sd D order, all P5 parts): who it is, the one thing blocking it, Where it's on, its
 * Instructions (edited in place, saved on pause), its Files, its Source and updates, what each machine's
 * Agents get, the Details, and the way out. `skillId: null` is the new-skill draft (`/settings/skills/new`):
 * the same grammar, edited before it exists, added once with "Add to library".
 */
export const SkillDetailScreen = React.memo(function SkillDetailScreen(
  props: Readonly<{ skillId: string | null }>,
) {
  return props.skillId === null ? (
    <SkillDraft />
  ) : (
    <SavedSkill skillId={props.skillId} />
  );
});

/** Why a plugin's skill cannot be edited here. A built-in one says it once, in its Source row. */
function hostOwnedNote(provenance: SkillProvenanceV1): string | undefined {
  return provenance.kind === 'plugin' ? t('capabilities.skillDetail.instructions.readOnlyPlugin') : undefined;
}

function SavedSkill(props: Readonly<{ skillId: string }>) {
  const { skillId } = props;
  const pluginUiProjection = useAppShellPluginUiDeclarationProjection();
  const sourceNameFor = useSkillSourceNames();
  const router = useRouter();
  const detail = useSkillDetail(skillId);
  const places = useSkillPlaces();
  const foundCache = useFoundSkillsCache(
    React.useMemo(() => places.placeMachines.map((machine) => machine.machineId), [places.placeMachines]),
  );
  // Where Happier's own copies of this skill sit, per machine (the Found scan's receipts).
  const installedPaths = React.useMemo(
    () =>
      Object.fromEntries(
        Object.entries(foundCache).map(([machineId, result]) => [
          machineId,
          (result?.items ?? [])
            .filter((item) => item.inLibrary === skillId && item.happierInstalled)
            .map((item) => item.path),
        ]),
      ),
    [foundCache, skillId],
  );
  const reach = useReachRules('skill', skillId);
  const projection = useReachProjection('skill', skillId);
  const rulesKey = React.useMemo(
    () => JSON.stringify(reach.rules),
    [reach.rules],
  );
  const truth = useSkillMachineTruth({
    skillId,
    machines: places.machines,
    projection,
    rulesKey,
    execute: detail.execute,
    ready: detail.ready,
  });
  const { read, listItem } = detail;
  const provenance = read?.provenance ?? listItem?.provenance;
  const registrySourceName = provenance ? sourceNameFor({ provenance }) : undefined;
  // Built-in and plugin Skills are host-owned: list, read and copy only.
  const hostOwned = provenance ? isReadOnlySkillProvenanceV1(provenance) : false;
  const [removing, setRemoving] = React.useState(false);

  // Never a raw id: until the library answers, the title stays empty (its space is kept).
  const name = read?.name ?? listItem?.name ?? '';
  // A folded YAML description keeps its source newlines; the header reads it as one sentence.
  const purpose = (
    listItem?.description ??
    (read ? readSkillFrontmatterV1(read.skillMd).description : undefined)
  )?.replace(/\s+/g, ' ').trim();
  const facts = React.useMemo(
    () => ({
      ...(provenance
        ? { source: skillSource({ provenance }, places.names.machineName, pluginUiProjection?.installedPackagesById, registrySourceName) }
        : {}),
      ...(read || listItem ? { trust: (read ?? listItem)!.trust } : {}),
      ...(read || listItem
        ? { cost: { tokensWhenUsed: (read ?? listItem)!.cost.bodyTokens } }
        : {}),
    }),
    [listItem, places.names.machineName, pluginUiProjection?.installedPackagesById, provenance, read, registrySourceName],
  );
  const statuses = React.useMemo(
    (): readonly CapabilityStatus[] =>
      listItem
        ? skillStatus(listItem, {
            nowMs: Date.now(),
            usageObservedSince: detail.library.usageObservedSince,
          })
        : [],
    [detail.library.usageObservedSince, listItem],
  );
  // "Off" is said once, by Where it's on; the title carries only what that section does not.
  const headerStatus = pickMostBlockingCapabilityStatus(statuses.filter((status) => status.kind !== 'off'), 'header');

  const menuItems = React.useMemo((): readonly PageHeaderMenuAction[] => {
    const items: PageHeaderMenuAction[] = [
      {
        id: 'duplicate',
        testID: 'skill.detail.duplicate',
        title: hostOwned
          ? t('capabilities.skillDetail.menu.makeCopy')
          : t('capabilities.skillDetail.menu.duplicate'),
        onSelect: async () => {
          const copy = await detail.duplicate();
          if (copy) router.push(skillHref(copy) as never);
          else Modal.alert(t('common.error'), t('errors.unknownError'));
        },
      },
    ];
    const folders = detail.folders.value?.folders ?? [];
    if (!hostOwned && detail.folders.status === 'ready') {
      const current = listItem?.folderId ?? null;
      items.push({
        id: 'move',
        testID: 'skill.detail.move',
        title: t('capabilities.skillDetail.menu.moveToFolder'),
        onSelect: () => undefined,
        children: [
          null,
          ...[...folders].sort((a, b) => a.name.localeCompare(b.name)),
        ].map((folder): PageHeaderMenuAction => ({
          id: `move:${folder?.id ?? 'none'}`,
          testID: `skill.detail.move:${folder?.id ?? 'none'}`,
          title: folder?.name ?? t('capabilities.skillDetail.menu.noFolder'),
          checked: (folder?.id ?? null) === current,
          onSelect: async () => {
            if (!(await detail.moveToFolder(folder?.id ?? null)))
              Modal.alert(t('common.error'), t('errors.unknownError'));
          },
        })),
      });
    }
    items.push({
      id: 'exportZip',
      testID: 'skill.detail.exportZip',
      title: t('capabilities.skillDetail.menu.exportZip'),
      onSelect: async () => {
        try {
          if (!(await detail.exportZip()))
            Modal.alert(t('common.error'), t('errors.unknownError'));
        } catch {
          Modal.alert(t('common.error'), t('errors.unknownError'));
        }
      },
    });
    const link =
      provenance?.kind === 'link'
        ? provenance.url
        : provenance?.kind === 'registry'
          ? provenance.registry.sourceUrl
          : provenance?.kind === 'wellKnown'
            ? provenance.indexUrl
            : null;
    if (link)
      items.push({
        id: 'copyLink',
        testID: 'skill.detail.copyLink',
        title: t('capabilities.skillDetail.menu.copyLink'),
        onSelect: () => {
          void Clipboard.setStringAsync(link);
        },
      });
    return items;
  }, [detail, hostOwned, listItem?.folderId, provenance, router]);

  const remove = React.useCallback(async () => {
    setRemoving(true);
    try {
      const removed = await detail.remove();
      if (removed === true) router.replace(SKILLS_COLLECTION_ROUTE as never);
      else if (removed === false) Modal.alert(t('common.error'), t('errors.unknownError'));
    } finally {
      setRemoving(false);
    }
  }, [detail, router]);

  const unavailable =
    detail.status === 'unavailable' || detail.library.status === 'unavailable';
  const readTheirs = React.useCallback(async () => {
    const latest = await detail.readLatest();
    return latest ? { text: latest.skillMd, revision: latest.revision } : null;
  }, [detail]);
  const adoptTheirs = React.useCallback(async () => {
    const latest = await detail.readLatest();
    if (latest) detail.adopt(latest);
  }, [detail]);
  const saveInstructions = React.useCallback(
    (text: string) => {
      const unixMode = read?.files.find(
        (file) => file.path === 'SKILL.md',
      )?.unixMode;
      return detail.update({
        files: [
          { kind: 'upsert', file: skillTextFile('SKILL.md', text, unixMode) },
        ],
      });
    },
    [detail, read?.files],
  );
  const readFile = React.useCallback(
    async (path: string) => {
      const latest = await detail.readLatest(path);
      return { text: readSkillFileText(latest?.file) };
    },
    [detail],
  );

  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <CapabilityDetailHeader
        testID="skill.detail.header"
        title={name}
        purpose={purpose}
        facts={facts}
        status={headerStatus}
        // Nothing to act on until the library has answered for this skill.
        menuItems={read || listItem ? menuItems : undefined}
      />
      {unavailable ? (
        <CapabilityBlockingBanner
          testID="skill.detail.banner"
          status={{
            kind: 'error',
            fix: { kind: 'try_again', onPress: detail.retry },
          }}
          title={t('capabilities.skillDetail.banner.couldntLoadTitle')}
          body={t('capabilities.skillDetail.banner.couldntLoadBody')}
        />
      ) : null}
      <WhereItsOnControl
        testID="skill.detail.where"
        kind="skill"
        presentation="section"
        rules={reach.rules}
        defaultEnabled={reach.resolveReach([], { machineId: '', machinePlatform: null, directory: null, projectKey: null, agentId: null }).enabled}
        status={reach.status}
        projection={reach.status === 'ready' ? projection : null}
        places={{
          agentIds: places.agentIds,
          machines: places.placeMachines,
          projects: places.projects,
        }}
        agentTakes={places.agentTakes}
        onChange={reach.change}
        onUndo={async () => {
          await reach.undoLast();
        }}
      />
      {read ? (
        <>
          <SkillInstructionsSection
            testID="skill.detail.instructions"
            skillId={skillId}
            skillMd={read.skillMd}
            readOnly={hostOwned ? { note: hostOwnedNote(read.provenance) } : false}
            onSave={saveInstructions}
            onDirtyChange={detail.setHold}
            readTheirs={readTheirs}
            adoptTheirs={adoptTheirs}
          />
          <SkillFilesSection
            testID="skill.detail.files"
            read={read}
            readOnly={hostOwned}
            update={detail.update}
            readFile={readFile}
          />
          <SkillSourceSection
            testID="skill.detail.source"
            read={read}
            pluginSource={facts.source?.kind === 'plugin' ? facts.source : undefined}
            registrySourceName={registrySourceName}
            updatePolicy={listItem?.updatePolicy ?? 'manual'}
            machineName={places.names.machineName}
            checkNow={() => {
              void detail.checkNow();
            }}
            checking={detail.checking}
            checkedAt={detail.checkedAt}
            checkFailed={detail.checkFailed}
            checkFailureReason={detail.checkFailureReason}
            onViewUpdate={() =>
              router.push(`${SKILLS_COLLECTION_ROUTE}/updates` as never)
            }
            update={detail.update}
          />
        </>
      ) : !unavailable ? (
        <ItemGroup title={t('capabilities.skillDetail.instructions.title')}>
          <Item
            testID="skill.detail.loading"
            title={t('capabilities.skillDetail.files.loading')}
            showChevron={false}
            mode="info"
          />
        </ItemGroup>
      ) : null}
      <SkillMachines truth={truth} names={places.names} />
      {read ? (
        <SkillDetailsDisclosure
          testID="skill.detail.details"
          skillId={skillId}
          revision={read.revision}
          allowInstall={!hostOwned}
          onlineMachines={places.placeMachines.filter(
            (machine) => machine.online,
          )}
          installedPaths={installedPaths}
          execute={detail.execute}
        />
      ) : null}
      {!hostOwned && read ? (
        <PageLeaveActions
          testID="skill.detail.leave"
          footnote={t('capabilities.skillDetail.leave.footnote')}
          actions={[
            {
              testID: 'skill.detail.remove',
              display: 'bordered',
              icon: 'trash',
              label: t('capabilities.skillDetail.leave.remove'),
              busy: removing,
              onPress: () => {
                void remove();
              },
            },
          ]}
        />
      ) : null}
    </ItemList>
  );
}

/** A machine's Agents as one line of the row's subtitle, the joining words in the subtitle's ink. */
function MachineAgents(props: Readonly<{ agentIds: readonly string[]; machineId: string; quiet?: boolean }>) {
  const { theme } = useUnistyles();
  return (
    <Text variant="body" style={{ color: theme.colors.text.secondary }}>
      <AgentNameRun agentIds={props.agentIds} machineId={props.machineId} tone={props.quiet ? 'secondary' : 'primary'} />
    </Text>
  );
}

/** One machine's row in "On your machines": its own preview's words online, the projection dated offline. */
function machineRow(
  entry: SkillMachineTruth,
  names: Pick<WhereItsOnNames, 'agentName' | 'agentNames'>,
): CapabilityMachineTruthRow {
  const { machine } = entry;
  const name = machine.name ?? machine.machineId;
  if (machine.online !== true) {
    return {
      machineId: machine.machineId,
      machineName: name,
      deviceIcon: 'desktop',
      offline: machine.offline,
      who:
        entry.projectedAgents.length > 0 ? (
          <MachineAgents agentIds={entry.projectedAgents} machineId={machine.machineId} quiet />
        ) : (
          t('capabilities.skillDetail.machines.noAgent')
        ),
      status: machine.offline ? { kind: 'offline' } : null,
      note: machine.offline ? lastKnown(machine.lastSeenAt) : t('common.unknown'),
    };
  }
  const delivered: string[] = [];
  const notes: string[] = [];
  let pending = false;
  let masked = false;
  for (const agentId of entry.skillAgents) {
    const fact = entry.facts.get(agentId);
    if (!fact || fact.kind === 'pending') {
      pending = true;
      continue;
    }
    if (fact.kind === 'delivered') delivered.push(agentId);
    else if (fact.kind === 'masked') {
      masked = true;
      notes.push(
        t('capabilities.skillDetail.machines.masked', {
          agent: names.agentName(agentId),
          machine: name,
        }),
      );
    } else if (fact.kind === 'failed')
      notes.push(
        t('capabilities.skillDetail.machines.previewFailed', {
          agent: names.agentName(agentId),
        }),
      );
  }
  if (entry.cannotLoad.length > 0)
    notes.push(
      t('capabilities.skillDetail.machines.cantLoad', {
        agents: names.agentNames(entry.cannotLoad).join(', '),
      }),
    );
  if (pending && delivered.length === 0)
    notes.unshift(t('capabilities.skillDetail.machines.checking'));
  return {
    machineId: machine.machineId,
    machineName: name,
    deviceIcon: 'desktop',
    // While its previews answer, the row keeps what the rules say (no flash of "no agent").
    who:
      delivered.length > 0 ? (
        <MachineAgents agentIds={delivered} machineId={machine.machineId} />
      ) : pending && entry.projectedAgents.length > 0 ? (
        <MachineAgents agentIds={entry.projectedAgents} machineId={machine.machineId} quiet />
      ) : (
        t('capabilities.skillDetail.machines.noAgent')
      ),
    ...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
    status: masked ? { kind: 'masked', machineName: name } : null,
  };
}

function SkillMachines(
  props: Readonly<{
    truth: readonly SkillMachineTruth[];
    names: Pick<WhereItsOnNames, 'agentName' | 'agentNames'>;
  }>,
) {
  const { truth, names } = props;
  // Online machines first (their answers are live), then offline ones with last-known facts.
  const shown = truth
    .filter((entry) => entry.machine.agentIds.length > 0)
    .sort((a, b) => Number(a.machine.offline) - Number(b.machine.offline));
  const rows = shown.map((entry) => machineRow(entry, names));
  const { summary, note } = summarizeMachines(shown, names.agentNames);
  return (
    <CapabilityMachineTruth
      testID="skill.detail.machines"
      description={`${t('capabilities.skillDetail.machines.description')} ${t('capabilities.skillDetail.machines.projectNote')}`}
      rows={rows}
      summary={summary}
      {...(note ? { summaryNote: note } : {})}
      emptyLabel={t('capabilities.skillDetail.machines.nowhere')}
      defaultExpanded={rows.length > 0 && rows.length <= 6}
    />
  );
}

/** The draft's one file, drawn like a Files row (mono path and its glyph). */
function DraftSkillFile() {
  const { theme } = useUnistyles();
  return (
    <Item testID="skill.draft.file" title="SKILL.md" titleStyle={{ ...Typography.mono() }}
      icon={<Icon name="file-text" size={18} color={theme.colors.text.secondary} />} showChevron={false} />
  );
}

/** The new-skill draft: the same page before the skill exists; "Add to library" creates it once. */
function SkillDraft() {
  const router = useRouter();
  const scope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(scope?.serverId ?? null);
  const places = useSkillPlaces();
  const draftReach = useDraftReachRules('skill');
  const [text, setText] = React.useState(SKILL_DRAFT_TEMPLATE);
  const [adding, setAdding] = React.useState(false);
  const frontmatter = React.useMemo(() => readSkillFrontmatterV1(text), [text]);
  const lint = React.useMemo(() => lintSkillMarkdown(text), [text]);
  const projection = React.useMemo(
    () =>
      projectReachOnMachines(
        draftReach.rules,
        places.machines as readonly ReachMachine[],
        undefined,
        places.workspaceRefs,
      ),
    [draftReach.rules, places.machines, places.workspaceRefs],
  );

  const add = React.useCallback(async () => {
    if (!frontmatter.name || adding) return;
    setAdding(true);
    try {
      const result = await execute('skills.create', {
        name: frontmatter.name,
        ...(frontmatter.description
          ? { description: frontmatter.description }
          : {}),
        files: [skillTextFile('SKILL.md', text)],
        ...(draftReach.where ? { where: draftReach.where } : {}),
      });
      if (readSkillActionRefusal(result)) {
        Modal.alert(
          t('common.error'),
          t('capabilities.skillDetail.draft.addFailed'),
        );
        return;
      }
      const created = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(
        result.ok ? result.result : null,
      );
      if (created.incomplete === 'rules')
        Modal.alert(t('capabilities.skillDetail.draft.whereIncomplete'));
      router.replace(skillHref(created.skillId) as never);
    } catch {
      Modal.alert(
        t('common.error'),
        t('capabilities.skillDetail.draft.addFailed'),
      );
    } finally {
      setAdding(false);
    }
  }, [
    adding,
    draftReach.where,
    execute,
    frontmatter.description,
    frontmatter.name,
    router,
    text,
  ]);

  const neverSaves = React.useCallback(
    async () => ({ ok: true as const, revision: '' }),
    [],
  );
  const noTheirs = React.useCallback(async () => null, []);
  const noAdopt = React.useCallback(async () => undefined, []);
  const noDirty = React.useCallback(() => undefined, []);
  const draft = React.useMemo(() => ({ text, onChange: setText }), [text]);

  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <CapabilityDetailHeader
        testID="skill.draft.header"
        title={
          frontmatter.name?.trim() || t('capabilities.skillDetail.draft.title')
        }
        purpose={t('capabilities.skillDetail.draft.purpose')}
        facts={{ source: { kind: 'you' } }}
        primaryAction={{
          testID: 'skill.draft.add',
          title: adding
            ? t('capabilities.skillDetail.draft.adding')
            : t('capabilities.skillDetail.draft.add'),
          onPress: add,
          disabled: !lint.ok || adding,
          loading: adding,
        }}
      />
      <WhereItsOnControl
        testID="skill.draft.where"
        kind="skill"
        presentation="section"
        rules={draftReach.rules}
        status="ready"
        projection={projection}
        places={{
          agentIds: places.agentIds,
          machines: places.placeMachines,
          projects: places.projects,
        }}
        agentTakes={places.agentTakes}
        onChange={draftReach.onChange}
      />
      <SkillInstructionsSection
        testID="skill.draft.instructions"
        skillId="new"
        skillMd={text}
        readOnly={false}
        draft={draft}
        onSave={neverSaves}
        onDirtyChange={noDirty}
        readTheirs={noTheirs}
        adoptTheirs={noAdopt}
      />
      <ItemGroup
        title={t('capabilities.skillDetail.files.title')}
        description={t('capabilities.skillDetail.files.afterAdd')}
        density="compact"
      >
        <DraftSkillFile />
      </ItemGroup>
    </ItemList>
  );
}

export type { SkillDetailModel };
