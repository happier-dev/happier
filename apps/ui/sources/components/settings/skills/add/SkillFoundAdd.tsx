import * as React from 'react';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import {
  CapabilityAddFooter,
  type CapabilityAddFound,
  type CapabilityAddInputContext,
} from '@/components/capabilities/add/CapabilityAddModal';
import { decodeUtf8Base64 } from '@/scm/diff/fallbackUnifiedDiff';
import type { CapabilityFactsProps } from '@/components/capabilities/facts/CapabilityFacts';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { Text } from '@/components/ui/text/Text';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { t } from '@/text';

import { SkillMark } from '../SkillKindGlyph';
import {
  SkillAddDetailBody,
  useSkillSiblingChoice,
  type SkillAddDetailInstalls,
} from './SkillAddDetailBody';
import { SkillInLibraryMark, SkillSameNameNote } from './SkillPreviewRows';
import {
  readAllHeldFooter,
  tickAllSkillPreviews,
  toggleSkillPreview,
  skillPreviewKey,
} from './skillPreviewSelection';
import {
  installSkills,
  selectSkillInstallSource,
  retrySkillInstall,
  describeSkillInstallIncomplete,
  type SkillInstallAcknowledgment,
  type SkillInstallSource,
} from './skillInstall';

type Preview = SkillInstallPreviewV1;
const keyOf = skillPreviewKey;

/** A detail's own Add: in flight, or acknowledged (the content landed; its rules may still be missing). */
type DetailAdd =
  | Readonly<{ status: 'adding' }>
  | Readonly<{
      status: 'added';
      outcome: SkillInstallAcknowledgment;
      where?: ReachRulesChangeV1;
    }>;

/** One open input task retains its checklist and acknowledgments while its reader is unmounted. */
export function createSkillFoundDraft(items: readonly Preview[] = NONE) {
  return createStore<{
    recoveryItems: readonly Preview[] | null;
    ticks: { items: readonly Preview[]; ticked: ReadonlySet<string> };
    adding: boolean;
    addError: string | null;
    acknowledged: SkillInstallAcknowledgment | null;
    detailAdds: ReadonlyMap<string, DetailAdd>;
    wheres: Map<string, ReachRulesChangeV1 | undefined>;
    selections: Map<string, readonly string[] | undefined>;
  }>(() => ({ recoveryItems: null, ticks: { items, ticked: tickAllSkillPreviews(items) }, adding: false,
    addError: null, acknowledged: null, detailAdds: new Map(), wheres: new Map(), selections: new Map() }));
}

type SkillFoundDraft = ReturnType<typeof createSkillFoundDraft>;

function readFoundSelection(state: ReturnType<SkillFoundDraft['getState']>, items: readonly Preview[]) {
  return state.ticks.items === items ? state.ticks.ticked
    : state.recoveryItems
      ? new Set(items.filter(item => item.inLibrary === undefined && state.ticks.ticked.has(keyOf(item))).map(item => keyOf(item)))
      : tickAllSkillPreviews(items);
}

/** Both the footer and dirty-exit Save commit the same retained checklist and receipt. */
export async function commitSkillFoundDraft(
  draft: SkillFoundDraft,
  execute: MountedAuthoringActionExecute,
  source: SkillInstallSource,
  previewItems: readonly Preview[],
): Promise<string | null> {
  const state = draft.getState();
  const items = state.recoveryItems ?? previewItems;
  if (state.adding || items.length === 0) return null;
  const ticked = readFoundSelection(state, items);
  if (!state.acknowledged && ticked.size === 0) return null;
  // One found skill has one Add, its details': Save commits what that Add would, with the Where picked there.
  const where = items.length === 1 ? state.wheres.get(keyOf(items[0]!)) : undefined;
  draft.setState({ adding: true, addError: null });
  try {
    const outcome = state.acknowledged
      ? await retrySkillInstall(execute, state.acknowledged, where)
      : await installSkills(execute, { source: selectSkillInstallSource(source, items.filter(item => ticked.has(keyOf(item)))),
          ...(items.length > 1 ? { selectPaths: items.filter(item => ticked.has(keyOf(item))).map(item => item.path) } : {}),
          ...(where ? { where } : {}) });
    if (!outcome.ok && outcome.skillIds.length === 0) {
      draft.setState({ addError: outcome.status ? describeRegistrySourceStatus(outcome.status) : t('capabilities.add.addFailed') });
      return null;
    }
    draft.setState({ acknowledged: outcome,
      ...(!outcome.ok && outcome.previews ? { recoveryItems: outcome.previews } : {}) });
    if (!outcome.ok || outcome.incomplete.length > 0) {
      draft.setState({ addError: describeSkillInstallIncomplete(outcome) });
      return null;
    }
    return outcome.skillIds[0] ?? null;
  } finally {
    draft.setState({ adding: false });
  }
}

function useFoundField<K extends keyof ReturnType<SkillFoundDraft['getState']>>(store: SkillFoundDraft, key: K) {
  type Value = ReturnType<SkillFoundDraft['getState']>[K];
  const value = useStore(store, state => state[key]);
  const setValue = React.useCallback((update: React.SetStateAction<Value>) => store.setState(previous => {
    const value = typeof update === 'function' ? (update as (current: Value) => Value)(previous[key]) : update;
    return Object.is(value, previous[key]) ? previous : { ...previous, [key]: value };
  }), [key, store]);
  return [value, setValue] as const;
}

/** Bytes a file carries, from its base64 body. */
function fileSize(contentBase64: string): number {
  const padding = contentBase64.endsWith('==')
    ? 2
    : contentBase64.endsWith('=')
      ? 1
      : 0;
  return Math.max(0, Math.floor((contentBase64.length * 3) / 4) - padding);
}

/**
 * What a link or an upload found, in the Add dialog's one list + details (lab sa L): a checklist row per skill (the
 * box ticks it; the row opens the same details Browse shows, with Where it's on), and the pinned footer that adds the
 * ticked ones in one call. A detail's Add to library adds that skill (and the siblings it keeps) with the Where the
 * person picked; the footer's Add preserves the batch's default reach. One found skill has no footer: its details' Add
 * is the one Add. A partial add keeps everything shown
 * and retries only the rules.
 */
export function SkillFoundAdd(
  props: Readonly<{
    ctx: CapabilityAddInputContext;
    execute: MountedAuthoringActionExecute;
    /** What `skills.install` adds from; null until something was found. */
    source: SkillInstallSource | null;
    items: readonly Preview[] | null;
    /** The parent input still presents this exact Find/upload, not newer text or results. */
    isCurrentInput: () => boolean;
    /** Stands where Browse has its search (the link field, the upload's choosers). */
    field?: React.ReactNode;
    /** Before anything is found. */
    empty: React.ReactNode;
    /** The list's heading once something is found ("16 skills in this repository"). */
    groupTitle: string;
    /** The facts' source for a found skill (its repository at the pin, or you). */
    factsSource: (item: Preview) => CapabilityFactsProps['source'];
    factsExtra?: (item: Preview) => CapabilityFactsProps['extra'];
    /** The details' "where it comes from" line. */
    installsSource?: (item: Preview) => SkillAddDetailInstalls['source'];
    /** The list footer's quiet note while nothing failed. */
    note: React.ReactNode;
    /** The footer carries `note` before anything is found too (an upload says it never runs before you choose). */
    noteWhileEmpty?: boolean;
    /** The details footer's note (defaults to `note`). */
    detailNote?: React.ReactNode;
    /** The footer added the ticked ones: the dialog closes onto the first. */
    onAdded: (skillId: string) => void | Promise<void>;
    /** A detail's Add (or Open) closed the dialog: the page selects that skill. */
    onSelectAdded: (skillId: string) => void | Promise<void>;
    onDone: () => void;
    testID: string;
    draft?: SkillFoundDraft;
  }>,
) {
  const { theme } = useUnistyles();
  const { execute, source } = props;
  const [localDraft] = React.useState(() => createSkillFoundDraft());
  const draft = props.draft ?? localDraft;
  const presented = React.useRef(true);
  React.useEffect(() => {
    presented.current = true;
    return () => { presented.current = false; };
  }, []);
  const [recoveryItems, setRecoveryItems] = useFoundField(draft, 'recoveryItems');
  const items = recoveryItems ?? props.items ?? NONE;
  const several = items.length > 1;

  // Ticks follow the found set: a new find starts with every new skill ticked.
  const [ticks, setTicks] = useFoundField(draft, 'ticks');
  const ticked = readFoundSelection({ ...draft.getState(), ticks, recoveryItems }, items);
  React.useLayoutEffect(() => {
    if (draft.getState().ticks.items !== items) setTicks({ items, ticked });
  }, [draft, items, setTicks, ticked]);
  const [adding] = useFoundField(draft, 'adding');
  const [addError, setAddError] = useFoundField(draft, 'addError');
  const [acknowledged] = useFoundField(draft, 'acknowledged');
  const [detailAdds, setDetailAdds] = useFoundField(draft, 'detailAdds');
  const wheres = { current: draft.getState().wheres };
  const selections = { current: draft.getState().selections };
  const locked = adding || acknowledged !== null;

  const toggle = React.useCallback(
    (path: string) => {
      if (locked) return;
      setAddError(null);
      setTicks((previous) => ({
        items,
        ticked: toggleSkillPreview(
          items,
          previous.items === items
            ? previous.ticked
            : tickAllSkillPreviews(items),
          path,
        ),
      }));
    },
    [items, locked],
  );
  // Several found skills: the group heading ticks every new one again, or none (lab `k:link`). Local draft only; the
  // batch Add (`selectPaths`) stays the one Action.
  const everyNew = tickAllSkillPreviews(items);
  const allTicked = [...everyNew].every((path) => ticked.has(path));
  const tickEvery = React.useCallback(
    (on: boolean) => {
      if (locked) return;
      setAddError(null);
      setTicks({ items, ticked: on ? tickAllSkillPreviews(items) : new Set<string>() });
    },
    [items, locked],
  );
  const groupAction = several && !locked && everyNew.size > 1 ? {
    label: allTicked ? t('capabilities.skillsUpdates.choose.selectNone') : t('capabilities.skillsUpdates.choose.selectAll'),
    onPress: () => tickEvery(!allTicked),
  } : undefined;

  const add = React.useCallback(async () => {
    if (source === null) return;
    const id = await commitSkillFoundDraft(draft, execute, source, props.items ?? NONE);
    if (id !== null && presented.current && props.isCurrentInput()) await props.onAdded(id);
  }, [draft, execute, props.items, props.onAdded, props.isCurrentInput, source]);

  const nameByPath = React.useMemo(
    () => new Map(items.map((item) => [keyOf(item), item.name])),
    [items],
  );
  const anatomy = React.useMemo(
    () => ({
      ...buildCapabilityCollectionAnatomy<Preview>({
        title: (item) => item.name,
        description: (item) => item.description,
        // Found skills carry the same mark as Browse's rows (lab `k:link`, `k:upload`).
        mark: () => <SkillMark />,
        whereSummary: (item) =>
          item.inLibrary !== undefined ? (
            <SkillInLibraryMark
              testID={`${props.testID}.item.${item.name}.inLibrary`}
            />
          ) : null,
        facts: (item) => {
          const factsSource = props.factsSource(item);
          // A ticked skill names the siblings it brings along, so the reference holds once it is added.
          const alsoAdds =
            several && ticked.has(keyOf(item))
              ? (item.siblingSkills ?? [])
                  .filter((sibling) => ticked.has(keyOf(item, sibling.path)))
                  .map(
                    (sibling) => nameByPath.get(keyOf(item, sibling.path)) ?? sibling.path,
                  )
              : [];
          return {
            presentation: 'row',
            ...(factsSource ? { source: factsSource } : {}),
            trust: item.trust,
            cost: { tokensWhenUsed: item.cost.bodyTokens },
            extra: [...(props.factsExtra?.(item) ?? []), ...alsoAdds.map((name) =>
              t('capabilities.skillAdd.alsoAdds', { name }),
            )],
          } satisfies CapabilityFactsProps;
        },
        accessibilityLabel: (item) => item.name,
        testID: (item) => `${props.testID}.item.${item.name}`,
      }),
      // Several found: a checklist. The box is its own control; pressing the row opens the details.
      ...(several
        ? {
            leadingControl: (item: Preview) => {
              const held = item.inLibrary !== undefined;
              const checked = !held && ticked.has(keyOf(item));
              return (
                <IconButton
                  testID={`${props.testID}.item.${item.name}.tick`}
                  variant="plain"
                  size={24}
                  accessibilityRole="checkbox"
                  checked={checked}
                  selectedBackground={false}
                  disabled={held || locked}
                  accessibilityLabel={item.name}
                  icon={
                    <SelectionCheckGlyph
                      state={checked ? 'checked' : 'unchecked'}
                    />
                  }
                  onPress={() => toggle(keyOf(item))}
                />
              );
            },
          }
        : {}),
    }),
    [locked, nameByPath, props, several, ticked, toggle],
  );

  const renderDetail = React.useCallback(
    (item: Preview) => (
      <SkillFoundDetail
        key={keyOf(item)}
        item={item}
        items={items}
        factsSource={props.factsSource(item)}
        factsExtra={props.factsExtra?.(item)}
        installsSource={props.installsSource?.(item)}
        onOpenHeld={props.onSelectAdded}
        initialWhere={wheres.current.get(keyOf(item))}
        initialSelectPaths={selections.current.get(keyOf(item))}
        onWhereChange={(where) => wheres.current.set(keyOf(item), where)}
        onSelectionChange={(paths) => selections.current.set(keyOf(item), paths)}
        testID={`${props.testID}.detail`}
      />
    ),
    [items, props],
  );

  const detailFooter = React.useCallback<NonNullable<CapabilityAddFound<Preview>['detailFooter']>>(
    (item: Preview) => {
      const note = <View style={styles.note}>{props.detailNote ?? props.note}</View>;
      const state = detailAdds.get(keyOf(item));
      if (item.inLibrary !== undefined && state?.status !== 'added') {
        const held = item.inLibrary;
        return {
          provenance: note,
          primary: {
            label: t('capabilities.skillAdd.open'),
            onPress: async () => ({ itemId: held }),
          },
        };
      }
      const setState = (next: DetailAdd) =>
        setDetailAdds((previous) => new Map(previous).set(keyOf(item), next));
      if (state?.status === 'added' && (!state.outcome.ok || state.outcome.incomplete.length > 0)) {
        const acknowledgedAdd = state;
        return {
          provenance: (
            <Text
              variant="meta"
              style={{ color: theme.colors.status.error }}
              testID={`${props.testID}.detail.partial`}
            >
              {describeSkillInstallIncomplete(state.outcome)}
            </Text>
          ),
          primary: {
            label: t('capabilities.skillAdd.partial.tryAgain'),
            onPress: async () => {
              const outcome = await retrySkillInstall(
                execute,
                acknowledgedAdd.outcome,
                acknowledgedAdd.where,
              );
              setState({ ...acknowledgedAdd, outcome });
              if (!outcome.ok && outcome.previews) setRecoveryItems(outcome.previews);
              if (!outcome.ok || outcome.incomplete.length > 0)
                throw new Error(describeSkillInstallIncomplete(outcome));
              return props.isCurrentInput() ? { itemId: outcome.skillIds[0]! } : null;
            },
          },
        };
      }
      if (state?.status === 'added') return {
        provenance: note,
        primary: { label: t('capabilities.skillAdd.open'), onPress: async () => ({ itemId: state.outcome.skillIds[0]! }) },
        afterAdd: { open: { label: t('capabilities.skillAdd.open'),
          onPress: () => { void props.onSelectAdded(state.outcome.skillIds[0]!); } } },
      };
      return {
        provenance: note,
        primary: {
          label: several ? t('capabilities.skillAdd.addOnly', { name: item.name }) : t('capabilities.skillAdd.addToLibrary'),
          // A single result's Add is the one Add, so an exit Save in flight shows on it.
          busy: state?.status === 'adding' || (!several && adding),
          ...(source === null || locked
            ? { disabledReason: t('capabilities.skillAdd.detail.loading') }
            : {}),
          onPress: async () => {
            if (source === null) return null;
            const where = wheres.current.get(keyOf(item));
            const selectPaths = selections.current.get(keyOf(item)) ?? [item.path];
            setState({ status: 'adding' });
            const outcome = await installSkills(execute, {
              source: selectSkillInstallSource(source, items.filter(candidate => selectPaths.includes(candidate.path)
                && keyOf(candidate) === keyOf(item, candidate.path))),
              ...(several
                ? {
                    selectPaths,
                  }
                : {}),
              ...(where ? { where } : {}),
            });
            if (!outcome.ok && outcome.skillIds.length === 0) {
              setDetailAdds((previous) => {
                const next = new Map(previous);
                next.delete(keyOf(item));
                return next;
              });
              throw new Error(
                outcome.status
                  ? describeRegistrySourceStatus(outcome.status)
                  : t('capabilities.add.addFailed'),
              );
            }
            setState({ status: 'added', outcome, ...(where ? { where } : {}) });
            if (!outcome.ok && outcome.previews) setRecoveryItems(outcome.previews);
            if (!outcome.ok || outcome.incomplete.length > 0)
              throw new Error(describeSkillInstallIncomplete(outcome));
            return props.isCurrentInput() ? { itemId: outcome.skillIds[0]! } : null;
          },
        },
      };
    },
    [
      adding,
      detailAdds,
      execute,
      items,
      locked,
      props.detailNote,
      props.note,
      props.testID,
      props.isCurrentInput,
      props.onSelectAdded,
      several,
      source,
      theme.colors.status.error,
    ],
  );

  const allHeld = !acknowledged && items.length > 0 ? readAllHeldFooter(items) : null;
  // One found skill: its details carry the one Add (or Open) and the note beside it, so no footer repeats them. Only
  // an exit Save's acknowledgment keeps the footer, for its retry.
  const detailsOwnTheAdd = items.length === 1 && !acknowledged;
  const footer =
    detailsOwnTheAdd ? undefined : items.length === 0 ? (props.noteWhileEmpty ? (
      <CapabilityAddFooter testID={`${props.testID}.footer`} start={<View style={styles.note}>{props.note}</View>}>{null}</CapabilityAddFooter>
    ) : undefined) : (
      <CapabilityAddFooter
        testID={`${props.testID}.footer`}
        start={
          addError ? (
            <Text
              variant="meta"
              style={{ color: theme.colors.status.error }}
              testID={`${props.testID}.add-error`}
            >
              {addError}
            </Text>
          ) : (
            <View style={styles.note}>{props.note}</View>
          )
        }
      >
        {allHeld?.kind === 'open' ? (
          <RoundButton
            size="normal"
            title={t('capabilities.skillAdd.open')}
            onPress={() => props.onAdded(allHeld.skillId)}
            testID={`${props.testID}.add`}
          />
        ) : allHeld?.kind === 'done' ? (
          <RoundButton
            size="normal"
            title={t('capabilities.add.done')}
            onPress={props.onDone}
            testID={`${props.testID}.done`}
          />
        ) : (
          <RoundButton
            size="normal"
            title={
              acknowledged
                ? t('capabilities.skillAdd.partial.tryAgain')
                : several
                  ? t('capabilities.skillAdd.link.addSelected', {
                      count: ticked.size,
                    })
                  : t('capabilities.skillAdd.addToLibrary')
            }
            loading={adding}
            disabled={source === null || adding || (!acknowledged && several && ticked.size === 0)}
            action={add}
            testID={`${props.testID}.add`}
          />
        )}
      </CapabilityAddFooter>
    );

  return props.ctx.renderFound<Preview>({
    ...(props.field === undefined ? {} : { field: props.field }),
    items,
    itemKey: item => keyOf(item),
    // Nothing left to choose, so no "Choose which to add" heading over rows that are all held.
    ...(items.length > 0 && !allHeld ? { groups: [{ key: 'found', title: props.groupTitle, ...(groupAction === undefined ? {} : { action: groupAction }), itemKeys: items.map(item => keyOf(item)) }] } : {}),
    anatomy,
    empty: props.empty,
    ...(footer === undefined ? {} : { footer }),
    renderDetail,
    detailFooter,
    onAdded: ({ itemId }) => { void props.onSelectAdded(itemId); },
  });
}

const NONE: readonly Preview[] = [];

/** A found skill's details: Browse's details over the preview the link or upload returned. */
function SkillFoundDetail(
  props: Readonly<{
    item: Preview;
    items: readonly Preview[];
    factsSource: CapabilityFactsProps['source'];
    factsExtra: CapabilityFactsProps['extra'];
    installsSource: SkillAddDetailInstalls['source'] | undefined;
    onOpenHeld: (skillId: string) => void;
    onWhereChange: (where: ReachRulesChangeV1 | undefined) => void;
    initialWhere?: ReachRulesChangeV1;
    initialSelectPaths?: readonly string[];
    onSelectionChange: (selectPaths: readonly string[] | undefined) => void;
    testID: string;
  }>,
) {
  const { item, items } = props;
  const siblings = React.useMemo(() => {
    const referenced = new Set(
      (item.siblingSkills ?? []).map((sibling) => sibling.path),
    );
    return items.filter((candidate) => referenced.has(candidate.path) && keyOf(candidate) === keyOf(item, candidate.path));
  }, [item, items]);
  const choice = useSkillSiblingChoice({
    primary: item,
    siblings,
    outsideReferences: item.outsideReferences ?? NO_REFERENCES,
    initialSelectPaths: props.initialSelectPaths,
    onOpenHeld: props.onOpenHeld,
    testID: props.testID,
  });
  const { onSelectionChange } = props;
  React.useEffect(() => {
    onSelectionChange(choice.selectPaths);
  }, [choice.selectPaths, onSelectionChange]);
  const files = React.useMemo(
    () =>
      item.files.map((file) => ({
        path: file.path,
        size: fileSize(file.contentBase64),
      })),
    [item.files],
  );
  // The found skill's own SKILL.md, read here like the rest of the upload (lab `k:upload` Its instructions).
  const instructions = React.useMemo(() => {
    const skillMd = item.files.find((file) => file.path === 'SKILL.md');
    if (!skillMd) return undefined;
    try {
      return decodeUtf8Base64(skillMd.contentBase64);
    } catch {
      return undefined;
    }
  }, [item.files]);
  return (
    <SkillAddDetailBody
      testID={props.testID}
      title={item.name}
      purpose={item.description}
      {...(item.sameNameInLibrary
        ? { notice: <SkillSameNameNote name={item.name} testID={`${props.testID}.sameName`} /> }
        : {})}
      facts={{
        presentation: 'row',
        ...(props.factsSource ? { source: props.factsSource } : {}),
        ...(props.factsExtra ? { extra: props.factsExtra } : {}),
        trust: item.trust,
        cost: { tokensWhenUsed: item.cost.bodyTokens },
      }}
      installs={{
        trust: item.trust,
        scripts: item.files.filter((file) => file.unixMode === 0o755).length,
        files,
        cost: item.cost,
        ...(props.installsSource ? { source: props.installsSource } : {}),
      }}
      {...(instructions === undefined ? {} : { instructions })}
      outsideReferences={choice.stillOutside}
      siblings={choice.rows}
      onWhereChange={props.onWhereChange}
      initialWhere={props.initialWhere}
    />
  );
}

const NO_REFERENCES: readonly string[] = [];

const styles = StyleSheet.create((theme) => ({
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
}));
