import * as React from 'react';
import { formatHappierCapabilityCount as formatCapabilityCount } from '@happier-dev/plugin-ui/presentation';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { SkillUpdateFileV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { getDiffStats } from '@/components/ui/code/model/diff/calculateDiff';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { resolveProseDiffPresentation } from '@/components/ui/code/diff/diffPresentationStyle';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useSkillsLibrary, type SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useSkillSourceNames } from '../useSkillSourceNames';

import { readSkillText } from '../detail/skillFileContent';
import { SKILLS_COLLECTION_ROUTE, skillSource } from '../skillsCollectionModel';
import { useSkillPlaces } from '../useSkillPlaces';
import {
  defaultSkillFileChoices,
  groupSkillUpdates,
  hasUpdatingSource,
  skillUpdateApplyChoices,
  type SkillFileChoice,
} from './skillsUpdatesModel';
import {
  contentRefLabel,
  provenanceRefLabel,
  useSkillsUpdates,
  type SkillsUpdatesController,
  type SkillUpdateApplyState,
  type SkillUpdateDiffState,
} from './useSkillsUpdates';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';


function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
}

function fileText(file: SkillUpdateFileV1['mine']): string {
  if (!file) return '';
  return file.contentKind === 'utf8' ? readSkillText(file.contentBase64) : '';
}

/** How many lines differ between the two sides of one file (the larger of added and removed). */
function changedLines(file: SkillUpdateFileV1): number {
  const stats = getDiffStats(fileText(file.mine), fileText(file.theirs));
  return Math.max(stats.additions, stats.deletions);
}

/**
 * `/settings/skills/updates` (P6 §4.6, lab su U/Up): newer versions from where skills came from. A skill
 * the person never changed is one tap away ("Ready to update"); one they changed asks per file, with
 * both sides shown (R5). Nothing changes until they choose.
 */
export const SkillsUpdatesScreen = React.memo(function SkillsUpdatesScreen() {
  const library = useSkillsLibrary();
  const updates = useSkillsUpdates(library);
  return <SkillsUpdatesPage library={library} updates={updates} />;
});

/** The page over its library and operations (the dev specimen supplies fixtures for states real data can't reach). */
export const SkillsUpdatesPage = React.memo(function SkillsUpdatesPage(
  props: Readonly<{ library: SkillsLibrary; updates: SkillsUpdatesController }>,
) {
  const { library, updates } = props;
  const pluginUiProjection = useAppShellPluginUiDeclarationProjection();
  const sourceNameFor = useSkillSourceNames();
  const router = useRouter();
  // A skill added from a machine names that machine, as the rail and homepage do.
  const { names } = useSkillPlaces();
  const groups = React.useMemo(
    () => groupSkillUpdates(library.items),
    [library.items],
  );
  // A skill just updated stays on the page with its receipt until the person leaves.
  const applied = React.useMemo(
    () =>
      library.items.filter(
        (item) =>
          updates.applies.get(item.skillId)?.status === 'applied' &&
          !groups.ready.includes(item) &&
          !groups.needsChoice.includes(item),
      ),
    [groups, library.items, updates.applies],
  );
  const { loadDiff, diffs } = updates;
  // A skill that asks per file needs both sides before anything can be chosen.
  React.useEffect(() => {
    if (!updates.ready) return;
    for (const item of groups.needsChoice)
      if (!diffs.has(item.skillId)) void loadDiff(item.skillId);
  }, [diffs, groups.needsChoice, loadDiff, updates.ready]);

  const leave = React.useCallback(() => {
    const result = runGuardedNavigation(() =>
      router.push(SKILLS_COLLECTION_ROUTE as never),
    );
    if (result !== true)
      fireAndForget(result, { tag: 'SkillsUpdatesScreen.leave' });
  }, [router]);

  const loading = library.status === 'loading' && library.items.length === 0;
  // Written, uploaded and found skills have nowhere newer to come from: say that, not "up to date".
  const sourced = React.useMemo(() => hasUpdatingSource(library.items), [library.items]);
  // A failed check that never succeeded says nothing about freshness: no "up to date" claim.
  const nothing =
    !loading &&
    !updates.check.failed &&
    groups.ready.length === 0 &&
    groups.needsChoice.length === 0 &&
    applied.length === 0;

  return (
    <ItemList keyboardShouldPersistTaps="handled" pageColumn="wide">
      <PageHeader
        testID="skills.updates.header"
        title={t('capabilities.skillsUpdates.updates.title')}
        alwaysShowTitle
        description={t('capabilities.skillsUpdates.updates.purpose')}
        actions={
          <SectionActionButton
            testID="skills.updates.checkNow"
            title={
              updates.check.checking
                ? t('capabilities.skillsUpdates.updates.checking')
                : t('capabilities.skillsUpdates.updates.checkNow')
            }
            icon="arrow-clockwise"
            loading={updates.check.checking}
            disabled={updates.check.checking || !updates.ready || (!loading && !sourced)}
            onPress={() => void updates.checkNow()}
          />
        }
      />
      {updates.check.failed ? (
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="skills.updates.checkFailed"
            size="line"
            kind="error"
            title={t('capabilities.skillsUpdates.updates.checkFailed')}
            note={updates.check.results.flatMap(result => result.upstream.state === 'unchecked'
              ? [`${library.items.find(item => item.skillId === result.key)?.name ?? ''}${library.items.some(item => item.skillId === result.key) ? ': ' : ''}${describeRegistrySourceStatus(result.upstream.reason)}`]
              : []).join('\n') || undefined}
            diagnosticCode={updates.check.code ?? undefined}
            action={{
              label: t('capabilities.skillsUpdates.updates.tryAgain'),
              onPress: () => void updates.checkNow(),
            }}
          />
        </ItemGroup>
      ) : null}
      {library.status === 'unavailable' && library.items.length === 0 ? (
        <SurfaceStateCard
          testID="skills.updates.loadFailed"
          size="page"
          kind="error"
          title={t('capabilities.skills.loadFailed')}
          action={{ label: t('common.retry'), onPress: library.retry }}
        />
      ) : loading ? (
        // The library is still being read: say so in the place the answer will appear, never a blank page.
        <ItemGroup surface="none">
          <SurfaceStateCard
            testID="skills.updates.loading"
            size="line"
            kind="loading"
            title={t('capabilities.skillsUpdates.updates.checking')}
          />
        </ItemGroup>
      ) : nothing ? (
        // Nothing to review is a state of the page, on its column's edge, not a line floating in a blank one.
        <SurfaceStateCard
          testID="skills.updates.upToDate"
          size="page"
          kind="empty"
          scene="checksPassed"
          title={!sourced ? t('capabilities.skillsUpdates.updates.noSources') : t('capabilities.skillsUpdates.updates.upToDate')}
          reason={
            sourced && updates.check.checkedAt !== null
              ? t('capabilities.skillsUpdates.updates.checkedAt', { time: formatTime(updates.check.checkedAt) })
              : undefined
          }
        />
      ) : null}
      {groups.ready.length > 0 || applied.length > 0 ? (
        // Once only receipts remain, the group no longer promises a safe update: it says what happened.
        <ItemGroup
          title={groups.ready.length > 0 ? t('capabilities.skillsUpdates.updates.readyTitle') : t('capabilities.skillsUpdates.updates.updatedTitle')}
          description={groups.ready.length > 0 ? t('capabilities.skillsUpdates.updates.readyBody') : undefined}
        >
          {[...groups.ready, ...applied].flatMap((item) => [
            <ReadyRow
              key={item.skillId}
              item={item}
              machineName={names.machineName}
              installedPlugins={pluginUiProjection?.installedPackagesById}
              registrySourceName={sourceNameFor(item)}
              diff={diffs.get(item.skillId)?.revision === item.revision ? diffs.get(item.skillId)! : null}
              applyState={updates.applies.get(item.skillId) ?? null}
              onToggleDiff={(open) =>
                open ? void loadDiff(item.skillId) : undefined
              }
              onUpdate={() => void updates.apply(item, undefined, diffs.get(item.skillId)?.revision)}
            />,
          ])}
        </ItemGroup>
      ) : null}
      {groups.needsChoice.map((item, index) => (
        <ChoiceSection
          key={item.skillId}
          item={item}
          first={index === 0}
          diff={diffs.get(item.skillId)?.revision === item.revision ? diffs.get(item.skillId)! : null}
          applyState={updates.applies.get(item.skillId) ?? null}
          onRetryDiff={() => void loadDiff(item.skillId)}
          onApply={(choices) => void updates.apply(item, choices, diffs.get(item.skillId)?.revision)}
          onNotNow={leave}
        />
      ))}
    </ItemList>
  );
});

function refWords(item: SkillListItemV1): string {
  const from = provenanceRefLabel(item.provenance);
  const to = contentRefLabel(item.upstream?.latest);
  return from && to
    ? t('capabilities.skillsUpdates.updates.refChange', { from, to })
    : '';
}

function ReadyRow(
  props: Readonly<{
    item: SkillListItemV1;
    machineName: (machineId: string) => string;
    installedPlugins: Parameters<typeof skillSource>[2];
    registrySourceName?: string;
    diff: SkillUpdateDiffState | null;
    applyState: SkillUpdateApplyState | null;
    onToggleDiff: (open: boolean) => void;
    onUpdate: () => void;
  }>,
) {
  const { item, diff, applyState } = props;
  const [open, setOpen] = React.useState(false);
  const changed =
    diff?.status === 'ready'
      ? diff.diff.files.filter((file) => file.changed)
      : null;
  const what =
    changed === null
      ? t('capabilities.skillsUpdates.updates.newerWaiting')
      : changed.length === 1
        ? t('capabilities.skillsUpdates.updates.linesChanged', {
            count: changedLines(changed[0]!),
            file: changed[0]!.path,
          })
        : t('capabilities.skillsUpdates.updates.filesChanged', {
            count: changed.length,
          });
  const refs = refWords(item);
  const applied = applyState?.status === 'applied';
  const cost =
    diff?.status === 'ready'
      ? {
          tokens:
            diff.diff.costDelta.mine.descriptionTokens +
            diff.diff.costDelta.mine.bodyTokens,
          to:
            diff.diff.costDelta.theirs.descriptionTokens +
            diff.diff.costDelta.theirs.bodyTokens,
        }
      : null;
  return (
    <>
      <CapabilityRow
        testID={`skills.updates.ready.${item.skillId}`}
        title={item.name}
        description={
          applied
            ? t('capabilities.skillsUpdates.updates.applied', {
                ref: applyState.ref ?? '',
              })
            : refs
              ? `${what} · ${refs}`
              : what
        }
        facts={{
          presentation: 'row',
          source: skillSource(item, props.machineName, props.installedPlugins, props.registrySourceName),
          trust: item.trust,
          ...(cost
            ? cost.to === cost.tokens
              ? { cost: { tokensWhenUsed: cost.to } }
              : {
                  extra: [
                    `${formatCapabilityCount(cost.tokens)} → ${t('capabilities.facts.tokensWhenUsed', { count: formatCapabilityCount(cost.to) })}`,
                  ],
                }
            : {}),
        }}
        // Two actions are wide: on a phone they move under the text so the change summary reads whole.
        stackActionWhenNarrow
        action={
          applied ? null : (
            <View style={styles.actions}>
              <TextLinkButton
                testID={`skills.updates.ready.${item.skillId}.view`}
                label={
                  open
                    ? t('capabilities.skillsUpdates.updates.hideChanges')
                    : t('capabilities.skillsUpdates.updates.viewChanges')
                }
                expanded={open}
                onPress={() => {
                  setOpen(!open);
                  if (!open && diff?.status !== 'ready')
                    props.onToggleDiff(true);
                }}
              />
              <RoundButton
                testID={`skills.updates.ready.${item.skillId}.update`}
                size="small"
                display="secondary"
                title={t('capabilities.skillsUpdates.updates.update')}
                loading={applyState?.status === 'applying'}
                disabled={applyState?.status === 'applying'}
                onPress={props.onUpdate}
              />
            </View>
          )
        }
      />
      {applyState?.status === 'failed' ? (
        <SectionContentRow continuesRow>
          <SurfaceStateCard
            size="line"
            kind="error"
            title={t('capabilities.skillsUpdates.updates.applyFailed')}
            diagnosticCode={applyState.code}
            action={{
              label: t('capabilities.skillsUpdates.updates.tryAgain'),
              onPress: props.onUpdate,
            }}
          />
        </SectionContentRow>
      ) : null}
      {open && !applied ? (
        <SectionContentRow
          continuesRow
          testID={`skills.updates.ready.${item.skillId}.changes`}
        >
          {diff === null || diff.status === 'loading' ? (
            <SurfaceStateCard
              size="line"
              kind="loading"
              title={t('capabilities.skillsUpdates.updates.checking')}
            />
          ) : diff.status === 'failed' ? (
            <SurfaceStateCard
              size="line"
              kind="error"
              title={t('capabilities.skillsUpdates.updates.diffFailed')}
              diagnosticCode={diff.code}
              action={{
                label: t('capabilities.skillsUpdates.updates.tryAgain'),
                onPress: () => props.onToggleDiff(true),
              }}
            />
          ) : (
            <View style={styles.diffs}>
              {diff.diff.files
                .filter((file) => file.changed)
                .map((file) => (
                  <SkillUpdateSides
                    key={file.path}
                    file={file}
                    item={item}
                    showPath={changed !== null && changed.length > 1}
                  />
                ))}
            </View>
          )}
        </SectionContentRow>
      ) : null}
    </>
  );
}

function ChoiceSection(
  props: Readonly<{
    item: SkillListItemV1;
    first: boolean;
    diff: SkillUpdateDiffState | null;
    applyState: SkillUpdateApplyState | null;
    onRetryDiff: () => void;
    onApply: (choices: Readonly<Record<string, SkillFileChoice>>) => void;
    onNotNow: () => void;
  }>,
) {
  const { item, diff } = props;
  const files = diff?.status === 'ready' ? diff.diff.files : null;
  const [selection, setSelection] = React.useState<Readonly<{
    review: SkillUpdateDiffState | null;
    picked: Readonly<Record<string, SkillFileChoice>>;
  }>>({ review: diff, picked: {} });
  const picked = selection.review === diff ? selection.picked : {};
  const defaults = React.useMemo(
    () => (files ? defaultSkillFileChoices(files) : {}),
    [files],
  );
  const keepMine = files
    ? Object.values(skillUpdateApplyChoices(files, picked)).some(
        (choice) => choice === 'mine',
      )
    : false;
  const applying = props.applyState?.status === 'applying';
  return (
    <ItemGroup
      {...(props.first
        ? { title: t('capabilities.skillsUpdates.updates.choiceTitle') }
        : {})}
      description={t('capabilities.skillsUpdates.updates.choiceBody', {
        name: item.name,
      })}
    >
      {files === null ? (
        <SectionContentRow>
          {diff?.status === 'failed' ? (
            <SurfaceStateCard
              size="line"
              kind="error"
              title={t('capabilities.skillsUpdates.updates.diffFailed')}
              diagnosticCode={diff.code}
              action={{
                label: t('capabilities.skillsUpdates.updates.tryAgain'),
                onPress: props.onRetryDiff,
              }}
            />
          ) : (
            <SurfaceStateCard
              size="line"
              kind="loading"
              title={t('capabilities.skillsUpdates.updates.checking')}
            />
          )}
        </SectionContentRow>
      ) : (
        files.flatMap((file) =>
          file.changed
            ? [
                <SegmentedChoiceItem<SkillFileChoice>
                  key={file.path}
                  testID={`skills.updates.choice.${item.skillId}.${file.path}`}
                  testIDPrefix={`skills.updates.choice.${item.skillId}.${file.path}`}
                  title={file.path}
                  subtitle={
                    file.mine === null
                      ? t('capabilities.skillsUpdates.updates.fileTheirsOnly')
                      : file.theirs === null
                        ? t('capabilities.skillsUpdates.updates.fileMineOnly')
                        : t('capabilities.skillsUpdates.updates.fileDiffers', {
                            count: changedLines(file),
                          })
                  }
                  options={[
                    {
                      id: 'mine',
                      label: t(
                        'capabilities.skillDetail.instructions.keepMine',
                      ),
                    },
                    {
                      id: 'theirs',
                      label: t(
                        'capabilities.skillDetail.instructions.takeTheirs',
                      ),
                    },
                  ]}
                  value={picked[file.path] ?? defaults[file.path] ?? 'mine'}
                  onChange={(next) =>
                    setSelection(previous => ({ review: diff, picked: {
                      ...(previous.review === diff ? previous.picked : {}),
                      [file.path]: next,
                    } }))
                  }
                />,
                <SectionContentRow key={`${file.path}:sides`} continuesRow>
                  <SkillUpdateSides
                    file={file}
                    item={item}
                    showPath={false}
                    kept={picked[file.path] ?? defaults[file.path] ?? 'mine'}
                  />
                </SectionContentRow>,
              ]
            : [
                <Item
                  key={file.path}
                  testID={`skills.updates.choice.${item.skillId}.${file.path}`}
                  title={file.path}
                  subtitle={t(
                    'capabilities.skillsUpdates.updates.fileUnchanged',
                  )}
                  detail={t(
                    'capabilities.skillsUpdates.updates.nothingToChoose',
                  )}
                  showChevron={false}
                />,
              ],
        )
      )}
      <SectionContentRow testID={`skills.updates.choice.${item.skillId}.foot`}>
        <View style={styles.foot}>
          <Text variant="meta" style={styles.note}>
            {keepMine
              ? t('capabilities.skillsUpdates.updates.keepNote', {
                  name: item.name,
                })
              : ''}
          </Text>
          <View style={styles.actions}>
            <TextLinkButton
              testID={`skills.updates.choice.${item.skillId}.notNow`}
              label={t('capabilities.skillsUpdates.updates.notNow')}
              onPress={props.onNotNow}
            />
            <RoundButton
              testID={`skills.updates.choice.${item.skillId}.apply`}
              size="small"
              title={t('capabilities.skillsUpdates.updates.applyChoices')}
              loading={applying}
              disabled={files === null || applying}
              onPress={() =>
                files && props.onApply(skillUpdateApplyChoices(files, picked))
              }
            />
          </View>
        </View>
        {props.applyState?.status === 'failed' ? (
          <SurfaceStateCard
            size="line"
            kind="error"
            title={t('capabilities.skillsUpdates.updates.applyFailed')}
            diagnosticCode={props.applyState.code}
          />
        ) : null}
      </SectionContentRow>
    </ItemGroup>
  );
}

/**
 * R5: one file's two sides in the shared diff viewer's prose face, Yours beside Theirs (stacked on a
 * phone, an accepted refinement). Once a side is chosen it stays bright and the other is set aside.
 */
function SkillUpdateSides(
  props: Readonly<{
    file: SkillUpdateFileV1;
    item: SkillListItemV1;
    showPath: boolean;
    kept?: SkillFileChoice | null;
  }>,
) {
  // R5 prose: Yours beside Theirs down to the prose minimum, stacked under it (a phone).
  const [width, setWidth] = React.useState<number | null>(null);
  const onLayout = React.useCallback((event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width), []);
  const theirsRef = contentRefLabel(props.item.upstream?.latest);
  return (
    <View style={styles.sides} onLayout={onLayout}>
      {props.showPath ? (
        <Text variant="label" style={styles.path}>
          {props.file.path}
        </Text>
      ) : null}
      <DiffViewer
        mode="text"
        face="prose"
        oldText={fileText(props.file.mine)}
        newText={fileText(props.file.theirs)}
        filePath={props.file.path}
        wrapLines
        presentationStyleOverride={resolveProseDiffPresentation(width)}
        prose={{
          oldLabel: <SideLabel title={t('capabilities.skillDetail.instructions.yours')} />,
          newLabel: <SideLabel title={t('capabilities.skillDetail.instructions.theirs')} detail={theirsRef} />,
          kept: props.kept === 'mine' ? 'old' : props.kept === 'theirs' ? 'new' : null,
        }}
      />
    </View>
  );
}

function SideLabel(props: Readonly<{ title: string; detail?: string | null }>) {
  return (
    <>
      <Text variant="label" emphasis="semiBold" style={styles.path}>
        {props.title}
      </Text>
      {props.detail ? (
        <Text variant="micro" style={styles.sideDetail}>
          {props.detail}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s16 },
  diffs: { gap: theme.space.s16 },
  sides: { gap: theme.space.s8 },
  sideDetail: { color: theme.colors.text.tertiary },
  path: { color: theme.colors.text.primary },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s16,
    flexWrap: 'wrap',
  },
  note: { flex: 1, minWidth: 200, color: theme.colors.text.secondary },
}));
