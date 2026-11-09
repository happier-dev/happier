import * as React from 'react';
import { useStore } from 'zustand';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_PICKS_SOURCE_ID,
  type RegistryItemSummaryV1,
  type RegistryItemV1,
  type RegistryItemPointerV1,
} from '@happier-dev/protocol/registries';
import type { ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { findHeldSkillV1, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { deriveSkillTrustV1 } from '@happier-dev/protocol/prompts/library/skills/skillTrustV1';
import { estimateSkillCostV1 } from '@happier-dev/protocol/prompts/library/skills/skillCostV1';
import { readSkillOutsideReferencesV1 } from '@happier-dev/protocol/prompts/library/skills/skillReferencesV1';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
  CapabilityAddModalBody,
  openCapabilityAddModalHost,
  type CapabilityAddInputContext,
  type CapabilityAddModalConfig,
} from '@/components/capabilities/add/CapabilityAddModal';
import type { CapabilityTrust } from '@/components/capabilities/facts/CapabilityFacts';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { CustomModalDismissGuard, CustomModalInjectedProps } from '@/modal/types';
import { useAuthoringDraftExitGuard } from '@/utils/navigation/useAuthoringDraftExitGuard';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { useRegistrySourcesSlot } from '@/registries/useRegistrySourcesSlot';
import { admitRegistrySummaryMark } from '@/registries/registryBrandMark';
import { useSkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { SkillMark } from '../SkillKindGlyph';
import { skillSource, skillSourceVerification } from '../skillsCollectionModel';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

import { installSkills, previewSkillInstall, retrySkillInstall, describeSkillInstallIncomplete, type SkillInstallAcknowledgment } from './skillInstall';
import { SkillLinkInput, createSkillLinkDraft, skillLinkMatchesPreview } from './SkillLinkInput';
import { SkillUploadInput, createSkillUploadDraft } from './SkillUploadInput';
import { commitSkillFoundDraft, createSkillFoundDraft } from './SkillFoundAdd';
import { SkillWriteInput } from './SkillWriteInput';
import { useSkillDraft } from './useSkillDraft';
import { SkillInLibraryMark } from './SkillPreviewRows';
import { SkillAddDetailBody, useSkillSiblingChoice } from './SkillAddDetailBody';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';

export type SkillAddModeKey = 'browse' | 'link' | 'upload' | 'write';
export type SkillAddSelection = Readonly<Omit<RegistryItemPointerV1, 'version'> & { version?: string }>;

export type OpenSkillAddModalParams = Readonly<{
  modeKey?: SkillAddModeKey;
  sourceId?: string;
  query?: string;
  initialSelection?: SkillAddSelection;
  /** The page selects the new row (the first skill added). */
  onAdded?: (skillId: string) => void;
}>;

const TEST_ID = 'skills.add';
const EMPTY_FOUND_DRAFT = createSkillFoundDraft();

/** Add a skill (P6 §4.4): Browse your registries, From a link, Upload, or Write, in the one capability Add modal. */
export function openSkillAddModal(
  params: OpenSkillAddModalParams,
): Readonly<{ close: () => void }> {
  let dismissGuard: CustomModalDismissGuard | null = null;
  return openCapabilityAddModalHost(
    SkillAddModal,
    { params, registerDismissGuard: (guard: CustomModalDismissGuard | null) => { dismissGuard = guard; } },
    { title: t('capabilities.skillAdd.title'), testID: TEST_ID, onDismissRequest: reason => dismissGuard?.(reason) },
  );
}

type Row = RegistryItemSummaryV1;
const rowKey = (row: Pick<Row, 'sourceId' | 'itemId'>) => `${row.sourceId}|${row.itemId}`;
const shortRef = (version: string | undefined) =>
  version && /^[0-9a-f]{40}$/.test(version)
    ? version.slice(0, 7)
    : (version ?? '');

function repositoryLabel(url: string | undefined): string | null {
  const match = url ? /github\.com[/:]([^/]+\/[^/#?]+)/.exec(url) : null;
  return match ? match[1]!.replace(/\.git$/, '') : null;
}
function libraryMatch(
  items: readonly SkillListItemV1[],
  row: Row,
): SkillListItemV1 | null {
  return findHeldSkillV1(items, { registry: row });
}
/** A listing whose "description" is only its repository says nothing the facts line doesn't: no second copy. */
function rowDescription(row: Row): string | null {
  const description = row.description?.trim();
  if (!description) return null;
  return description === repositoryLabel(row.links?.repository) || description === row.publisher?.name ? null : description;
}
type AddState =
  | Readonly<{ status: 'adding' }>
  | Readonly<{
      status: 'added';
      outcome: SkillInstallAcknowledgment;
      where?: ReachRulesChangeV1;
    }>
  | Readonly<{ status: 'failed'; error: string }>;

type SkillAddModalProps = CustomModalInjectedProps & Readonly<{
  params: OpenSkillAddModalParams; registerDismissGuard?: (guard: CustomModalDismissGuard | null) => void;
}>;
type SkillAddControllerProps = SkillAddModalProps & Readonly<{
  children: (config: CapabilityAddModalConfig<Row> | null, resolving: boolean, requestClose: () => void) => React.ReactNode;
}>;

export function SkillAddModal(props: SkillAddModalProps): React.ReactElement {
  return <SkillAddController {...props}>{(config, resolving, requestClose) => config
    ? <CapabilityAddModalBody {...props} onClose={requestClose} config={config} />
    : <SurfaceStateCard kind={resolving ? 'loading' : 'error'} size="line"
      title={resolving ? t('common.loading') : t('common.unavailable')} testID={`${TEST_ID}.unavailable`} />}
  </SkillAddController>;
}

/** One native draft, exact read and receipt owner for Add and Store listing hosts. */
export function SkillAddController(props: SkillAddControllerProps): React.ReactNode {
  const writeDraft = useSkillDraft();
  if (!writeDraft.current) return props.children(null, writeDraft.resolving, props.onClose);
  return <SkillAddModalContent {...props} writeDraft={writeDraft} />;
}

function SkillAddModalContent(props: SkillAddControllerProps & Readonly<{
  writeDraft: ReturnType<typeof useSkillDraft>;
}>): React.ReactNode {
  const { params } = props;
  const { theme } = useUnistyles();
  const scope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(scope?.serverId ?? null);
  const [linkDraft] = React.useState(createSkillLinkDraft);
  const [uploadDraft] = React.useState(createSkillUploadDraft);
  const { writeDraft } = props;
  const writeDirty = useStore(writeDraft.store, state => state.dirty);
  const linkPresent = useStore(linkDraft, state => state.url.trim() !== '');
  const linkMatchesPreview = useStore(linkDraft, skillLinkMatchesPreview);
  const linkFound = useStore(linkDraft, state => state.state.kind === 'found' ? state.state.draft : EMPTY_FOUND_DRAFT);
  const uploadFound = useStore(uploadDraft, state => state.state.kind === 'ready' ? state.state.draft : EMPTY_FOUND_DRAFT);
  const linkSettled = useStore(linkFound, state => state.acknowledged !== null || [...state.detailAdds.values()].some(add => add.status === 'added'));
  const uploadSettled = useStore(uploadFound, state => state.acknowledged !== null || [...state.detailAdds.values()].some(add => add.status === 'added'));
  const linkSaveable = useStore(linkFound, state => !state.adding && state.ticks.ticked.size > 0);
  const uploadSaveable = useStore(uploadFound, state => !state.adding && state.ticks.ticked.size > 0);
  const inputDirty = linkPresent && !(linkMatchesPreview && linkSettled) || uploadFound !== EMPTY_FOUND_DRAFT && !uploadSettled;
  const isDirty = writeDirty || inputDirty;
  const dirtyRef = React.useRef(isDirty);
  dirtyRef.current = isDirty;
  const discard = React.useCallback(() => {
    writeDraft.reset();
    linkDraft.setState({ url: '', state: { kind: 'idle' } });
    uploadDraft.setState({ state: { kind: 'idle' } });
    dirtyRef.current = false;
  }, [linkDraft, uploadDraft, writeDraft.reset]);
  const save = React.useCallback(async () => {
    if (!writeDraft.isCurrent()) return false;
    const link = linkDraft.getState();
    const upload = uploadDraft.getState();
    const inputsUnchanged = () => linkDraft.getState().url === link.url && linkDraft.getState().state === link.state
      && uploadDraft.getState().state === upload.state;
    if (writeDraft.store.getState().dirty && (await writeDraft.create()) === null) return false;
    if (!inputsUnchanged() || !writeDraft.isCurrent()) return false;
    if (link.url.trim() !== '' && !linkSettled) {
      if (!skillLinkMatchesPreview(link) || link.state.kind !== 'found') return false;
      if ((await commitSkillFoundDraft(link.state.draft, execute, link.state.source, link.state.items)) === null) return false;
    }
    if (!inputsUnchanged() || !writeDraft.isCurrent()) return false;
    if (upload.state.kind === 'ready' && !uploadSettled) {
      if (!writeDraft.isCurrent()) return false;
      if ((await commitSkillFoundDraft(upload.state.draft, execute,
        { kind: 'upload', files: [...upload.state.files] }, upload.state.items)) === null) return false;
    }
    return writeDraft.isCurrent() && inputsUnchanged() && !writeDraft.store.getState().dirty;
  }, [execute, linkDraft, linkSettled, uploadDraft, uploadSettled, writeDraft.create, writeDraft.isCurrent, writeDraft.store]);
  const canSaveInputs = (!linkPresent || linkMatchesPreview && (linkSettled || linkSaveable))
    && (uploadFound === EMPTY_FOUND_DRAFT || uploadSettled || uploadSaveable);
  const exit = useAuthoringDraftExitGuard({ isDirty, isDirtyRef: dirtyRef, onDiscard: discard,
    onSave: canSaveInputs ? save : undefined, onContinue: props.onClose });
  const depart = React.useCallback(async (leave: () => void) => {
    const link = linkDraft.getState();
    const upload = uploadDraft.getState();
    const settled = (found: ReturnType<typeof createSkillFoundDraft>) => found.getState().acknowledged !== null
      || [...found.getState().detailAdds.values()].some(add => add.status === 'added');
    dirtyRef.current = writeDraft.store.getState().dirty
      || link.url.trim() !== '' && !(skillLinkMatchesPreview(link) && link.state.kind === 'found' && settled(link.state.draft))
      || upload.state.kind === 'ready' && !settled(upload.state.draft);
    if (await exit.requestExit() && writeDraft.isCurrent()) leave();
  }, [exit.requestExit, linkDraft, uploadDraft, writeDraft.isCurrent, writeDraft.store]);
  const close = React.useCallback(() => depart(props.onClose), [depart, props.onClose]);
  const openSkill = React.useCallback((id: string) => depart(() => { props.onClose(); params.onAdded?.(id); }),
    [depart, params.onAdded, props.onClose]);
  React.useEffect(() => {
    props.registerDismissGuard?.(exit.requestExit);
    return () => props.registerDismissGuard?.(null);
  }, [exit.requestExit, props.registerDismissGuard]);
  const library = useSkillsLibrary();
  const { sources: allSources } = useRegistrySources('skill');
  const sourceTitle = React.useCallback(
    (sourceId: string) =>
      allSources.find((source) => source.id === sourceId)?.title ?? t('capabilities.store.unnamedCatalog'),
    [allSources],
  );

  const itemsFromSource = React.useCallback(
    (sourceId: string) =>
      library.items
        .filter(
          (item) =>
            item.provenance.kind === 'registry' &&
            item.provenance.registry.sourceId === sourceId,
        )
        .map((item) => ({
          title: item.name,
          ...(item.provenance.kind === 'registry' &&
          item.provenance.registry.ref.kind === 'gitTree'
            ? { ref: item.provenance.registry.ref.commit.slice(0, 7) }
            : {}),
          onOpen: () => {
            void openSkill(item.skillId);
          },
        })),
    [library.items, openSkill],
  );
  const [seedRequested, setSeedRequested] = React.useState(params.initialSelection !== undefined);
  const discardSeed = React.useCallback(() => setSeedRequested(false), []);
  const slot = useRegistrySourcesSlot('skill', {
    itemsFromSource,
    ...((params.initialSelection?.sourceId ?? params.sourceId)
      ? { initialSelection: params.initialSelection?.sourceId ?? params.sourceId } : {}),
    onSelectionChange: discardSeed,
    testID: `${TEST_ID}.registries`,
  });
  const [query, setQuery] = React.useState(params.query ?? '');
  const changeQuery = React.useCallback((value: string) => { setQuery(value); setSeedRequested(false); }, []);
  const [catalogDemanded, setCatalogDemanded] = React.useState((params.modeKey ?? 'browse') === 'browse');
  const catalog = useRegistryItems({
    kind: 'skill',
    ...(slot.sourceIds ? { sourceIds: slot.sourceIds } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
  }, catalogDemanded && !seedRequested);

  // What the details read (the pinned version the primary installs) and what the person picked for Where.
  const [reads, setReads] = React.useState<ReadonlyMap<string, RegistryItemV1>>(
    () => new Map(),
  );
  // What the install preview says about each detail's primary: the held skill's id, null when it is new, undefined
  // until the preview has answered (the Action decides, including a Git identity from another source).
  const [heldByPreview, setHeldByPreview] = React.useState<ReadonlyMap<string, string | null | undefined>>(
    () => new Map(),
  );
  const onHeld = React.useCallback(
    (key: string, held: string | null | undefined) =>
      setHeldByPreview((previous) => (previous.get(key) === held && previous.has(key) ? previous : new Map(previous).set(key, held))),
    [],
  );
  const wheres = React.useRef(
    new Map<string, ReachRulesChangeV1 | undefined>(),
  );
  // The skills a detail adds: its own path and the referenced siblings the person kept (undefined: nothing to choose).
  const selections = React.useRef(
    new Map<string, readonly string[] | undefined>(),
  );
  const [adds, setAdds] = React.useState<ReadonlyMap<string, AddState>>(
    () => new Map(),
  );
  const setAdd = React.useCallback(
    (key: string, state: AddState) =>
      setAdds((previous) => new Map(previous).set(key, state)),
    [],
  );
  const onRead = React.useCallback(
    (key: string, item: RegistryItemV1 | null) =>
      setReads((previous) => {
        if (item === null) {
          if (!previous.has(key)) return previous;
          const next = new Map(previous);
          next.delete(key);
          return next;
        }
        return previous.get(key) === item ? previous : new Map(previous).set(key, item);
      }),
    [],
  );

  const install = React.useCallback(
    async (
      row: Row,
      version: string,
      where: ReachRulesChangeV1 | undefined,
      selectPaths?: readonly string[],
    ) => {
      const key = rowKey(row);
      const previous = adds.get(key);
      if (previous?.status === 'added') {
        const outcome = await retrySkillInstall(execute, previous.outcome, previous.where);
        setAdd(key, { ...previous, outcome });
        library.retry();
        return outcome;
      }
      setAdd(key, { status: 'adding' });
      const outcome = await installSkills(execute, {
        source: {
          kind: 'registry',
          sourceId: row.sourceId,
          itemId: row.itemId,
          version,
        },
        ...(selectPaths ? { selectPaths } : {}),
        ...(where ? { where } : {}),
      });
      if (!outcome.ok && outcome.skillIds.length === 0) {
        setAdd(key, { status: 'failed', error: outcome.error });
        throw new Error(outcome.status ? describeRegistrySourceStatus(outcome.status) : t('capabilities.add.addFailed'));
      }
      setAdd(key, {
        status: 'added',
        outcome,
        ...(where ? { where } : {}),
      });
      library.retry();
      return outcome;
    },
    [adds, execute, library, setAdd],
  );

  const seed = params.initialSelection;
  const seedActive = seedRequested && seed !== undefined;
  const items = React.useMemo(() => {
    if (!seedActive || !seed) return catalog.items;
    const listed = catalog.items.find(row => rowKey(row) === rowKey(seed));
    const read = reads.get(rowKey(seed));
    const summary = read && (!seed.version || read.summary.version === seed.version) ? read.summary : null;
    const row = summary ? admitRegistrySummaryMark(summary, listed)
      : listed && (!seed.version || listed.version === seed.version) ? listed
        : admitRegistrySummaryMark({ ...seed, kind: 'skill', title: seed.itemId });
    return [row, ...catalog.items.filter(item => rowKey(item) !== rowKey(row))];
  }, [catalog.items, reads, seed, seedActive]);
  const groups = React.useMemo(() => {
    const picks = items
      .filter((row) => row.sourceId === HAPPIER_PICKS_SOURCE_ID)
      .map(rowKey);
    const rest = items
      .filter((row) => row.sourceId !== HAPPIER_PICKS_SOURCE_ID)
      .map(rowKey);
    const restTitle =
      slot.selection === 'all'
        ? t('capabilities.skillAdd.groupAll')
        : t('capabilities.skillAdd.groupSource', {
            source: sourceTitle(slot.selection),
          });
    return [
      ...(picks.length > 0
        ? [
            {
              key: 'picks',
              title: t('capabilities.skillAdd.groupPicks'),
              itemKeys: picks,
            },
          ]
        : []),
      ...(rest.length > 0
        ? [{ key: 'rest', title: restTitle, itemKeys: rest }]
        : []),
    ];
  }, [items, slot.selection, sourceTitle]);

  const anatomy = React.useMemo(
    () =>
      buildCapabilityCollectionAnatomy<Row>({
        title: (row) => row.title,
        description: rowDescription,
        // The same skill mark the library rail draws (lab `m:skill`): registry skills carry no brand of their own.
        mark: () => <SkillMark />,
        whereSummary: (row) => {
          const state = adds.get(rowKey(row));
          const inLibrary =
            state?.status === 'added' ||
            libraryMatch(library.items, row) !== null;
          if (!inLibrary) return null;
          return <SkillInLibraryMark />;
        },
        facts: (row) => {
          const repo = repositoryLabel(row.links?.repository);
          return {
            presentation: 'row',
            ...(repo
              ? { source: { kind: 'git' as const, label: repo } }
              : row.publisher
                ? {
                    source: {
                      kind: 'registry' as const,
                      label: row.publisher.name,
                    },
                  }
                : {}),
            extra: [t('capabilities.skillAdd.via', {
                source: sourceTitle(row.sourceId),
              })],
          };
        },
        accessibilityLabel: (row) => row.title,
        testID: (row) => `${TEST_ID}.row.${row.itemId}`,
      }),
    [adds, library.items, sourceTitle],
  );

  const config = React.useMemo(
    (): CapabilityAddModalConfig<Row> => ({
      title: t('capabilities.skillAdd.title'),
      testID: TEST_ID,
      initialModeKey: params.modeKey ?? 'browse',
      ...(seedActive && seed ? { initialItemKey: rowKey(seed) } : {}),
      onCatalogDemandChange: setCatalogDemanded,
      modes: [
        {
          key: 'browse',
          label: t('capabilities.skillAdd.modes.browse'),
          icon: 'magnifying-glass',
          kind: 'catalog',
        },
        {
          key: 'link',
          label: t('capabilities.skillAdd.modes.link'),
          icon: 'link',
          kind: 'input',
          ownsTools: true,
          renderBody: (ctx) => (
            <SkillLinkInput
              draft={linkDraft}
              ctx={ctx}
              execute={execute}
              onAdded={(skillId) => {
                library.retry();
                return openSkill(skillId);
              }}
              onSelectAdded={(skillId) => {
                library.retry();
                return openSkill(skillId);
              }}
              onDone={close}
              testID={`${TEST_ID}.link`}
            />
          ),
        },
        {
          key: 'upload',
          label: t('capabilities.skillAdd.modes.upload'),
          icon: 'upload',
          kind: 'input',
          ownsTools: true,
          renderBody: (ctx) => (
            <SkillUploadInput
              draft={uploadDraft}
              ctx={ctx}
              execute={execute}
              onAdded={(skillId) => {
                library.retry();
                return openSkill(skillId);
              }}
              onSelectAdded={(skillId) => {
                library.retry();
                return openSkill(skillId);
              }}
              onDone={close}
              testID={`${TEST_ID}.upload`}
            />
          ),
        },
        {
          key: 'write',
          label: t('capabilities.skillAdd.modes.write'),
          icon: 'pencil-simple',
          kind: 'input',
          ownsTools: true,
          // The skill's files lead the list; SKILL.md, being written, is the details (lab `k:write`).
          renderBody: (ctx: CapabilityAddInputContext) => <SkillWriteInput ctx={ctx} draft={writeDraft} onOpen={skillId => {
            library.retry(); return openSkill(skillId);
          }} onDone={close} />,
        },
      ],
      sources: slot.sources,
      catalog: {
        query,
        onQueryChange: changeQuery,
        searchPlaceholder: t('capabilities.skillAdd.searchPlaceholder', {
          count: catalog.pages.reduce<number | null>(
            (sum, page) =>
              page.total === undefined || sum === null
                ? null
                : sum + page.total,
            catalog.pages.length > 0 ? 0 : null,
          ),
        }),
        items,
        groups,
        itemKey: rowKey,
        anatomy,
        loading: catalog.loading && items.length === 0,
        ...(catalog.hasNextPage ? { loadMore: { label: t('common.more'), loading: catalog.loading, onPress: catalog.nextPage } } : {}),
        sourceFailures: catalog.sourceFailures.map((failure) => ({
          ...failure,
          message: `${sourceTitle(failure.sourceId)} · ${failure.message}`,
        })),
        empty: ({ selectMode }) => (
          <CatalogEmpty
            query={query}
            onClear={() => changeQuery('')}
            onWrite={() => {
              selectMode('write');
            }}
          />
        ),
      },
      renderDetail: (row) => (
        <SkillAddDetail
          row={row}
          sourceTitle={sourceTitle(row.sourceId)}
          onRead={onRead}
          onHeld={onHeld}
          onOpenHeld={(skillId) => {
            void openSkill(skillId);
          }}
          initialWhere={wheres.current.get(rowKey(row))}
          savedRules={(heldByPreview.get(rowKey(row))
            ? library.items.find(item => item.skillId === heldByPreview.get(rowKey(row)))
            : libraryMatch(library.items, row))?.rules}
          initialSelectPaths={selections.current.get(rowKey(row))}
          execute={execute}
          onWhereChange={(key, where) => {
            wheres.current.set(key, where);
          }}
          onSelectionChange={(key, selectPaths) => {
            selections.current.set(key, selectPaths);
          }}
        />
      ),
      detailFooter: (row) => {
        const key = rowKey(row);
        const read = reads.get(key) ?? null;
        // The preview after the item read is authoritative; the summary match only stands in until it answers.
        const previewedHeld = heldByPreview.get(key);
        const existingId =
          previewedHeld !== undefined ? previewedHeld : (libraryMatch(library.items, row)?.skillId ?? null);
        const state = adds.get(key);
        const version = read?.summary.version;
        const provenance = version ? (
        <View style={styles.provenance}>
          <Icon name="push-pin" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {t('capabilities.skillAdd.pinnedTo', { ref: shortRef(version) })}
          </Text>
        </View>
      ) : undefined;
        if (existingId !== null && state?.status !== 'added') {
          return {
            ...(provenance ? { provenance } : {}),
            primary: {
              label: t('capabilities.skillAdd.open'),
              onPress: async () => { await openSkill(existingId); return null; },
            },
          };
        }
        if (state?.status === 'added') {
          const partial = !state.outcome.ok || state.outcome.incomplete.length > 0;
          return {
            provenance: partial ? <Text variant="meta" style={{ color: theme.colors.status.error }}>{describeSkillInstallIncomplete(state.outcome)}</Text> : provenance,
            primary: {
              label: t(partial ? 'capabilities.skillAdd.partial.tryAgain' : 'capabilities.skillAdd.open'),
              onPress: async () => {
                if (!partial) { await openSkill(state.outcome.skillIds[0]!); return null; }
                const outcome = await install(row, version ?? '', state.where);
                if (!outcome.ok || outcome.incomplete.length > 0) throw new Error(describeSkillInstallIncomplete(outcome));
                return null;
              },
            },
          };
        }
        const problem = read?.summary.problem ?? row.problem;
        return {
          ...(provenance ? { provenance } : {}),
          primary: {
            label: t('capabilities.skillAdd.addToLibrary'),
            busy: state?.status === 'adding',
            ...(problem
              ? {
                  disabledReason: t(
                    'capabilities.skillAdd.detail.problemUnsupported',
                  ),
                }
              : !version || previewedHeld === undefined
                ? { disabledReason: t('capabilities.skillAdd.detail.loading') }
                : {}),
            onPress: async () => {
              const result = await install(
                row,
                version!,
                wheres.current.get(key),
                selections.current.get(key),
              );
              if (!result.ok || result.incomplete.length > 0) throw new Error(describeSkillInstallIncomplete(result));
              return null;
            },
          },
        };
      },
    }),
    [
      adds,
      anatomy,
      catalog.loading,
      catalog.hasNextPage,
      catalog.nextPage,
      catalog.pages,
      catalog.sourceFailures,
      execute,
      groups,
      heldByPreview,
      install,
      items,
      library,
      linkDraft,
      uploadDraft,
      onRead,
      params,
      props,
      query,
      changeQuery,
      reads,
      setAdd,
      seed,
      seedActive,
      slot.sources,
      sourceTitle,
      theme.colors.status.error,
      theme.colors.text.secondary,
      writeDraft,
      close,
      openSkill,
    ],
  );

  return props.children(config, false, () => { void close(); });
}

function CatalogEmpty(props: Readonly<{ query: string; onClear: () => void; onWrite: () => void }>) {
  const { theme } = useUnistyles();
  const query = props.query.trim();
  if (!query) {
    // Registries that list nothing: what Browse is for, and the ways forward (the registry menu sits above; Write is
    // the one that leaves Browse). A failed source never reaches here: the body keeps its Retry line for that.
    return (
      <View style={styles.emptyPage}>
        <EmptyState
          layout="centered"
          size="page"
          scene="exploring"
          title={t('capabilities.skillAdd.emptyTitle')}
          subtitle={t('capabilities.skillAdd.emptyBody')}
          primaryAction={{
            label: t('capabilities.skills.home.writeOwn'),
            onPress: props.onWrite,
            testID: `${TEST_ID}.empty.write`,
          }}
          testID={`${TEST_ID}.empty`}
        />
      </View>
    );
  }
  return (
    <View style={styles.empty}>
      <Text variant="body" style={{ color: theme.colors.text.secondary }}>
        {t('capabilities.skillAdd.noMatch', { query })}
      </Text>
      <RoundButton
        size="small"
        display="inverted"
        title={t('capabilities.skillAdd.clear')}
        onPress={props.onClear}
      />
    </View>
  );
}

/**
 * A registry skill's details (lab sa A2): who it is with its pinned source, trust and cost; Where it's on (pick,
 * Everywhere by default); what it installs; what happens next; its files. Reads the selected reviewed version, and
 * hands that read up so the footer's Add installs exactly what is shown.
 */
function SkillAddDetail(
  props: Readonly<{
    row: Row;
    sourceTitle: string;
    execute: MountedAuthoringActionExecute;
    onRead: (key: string, item: RegistryItemV1 | null) => void;
    onHeld: (key: string, held: string | null | undefined) => void;
    onOpenHeld: (skillId: string) => void;
    onWhereChange: (key: string, where: ReachRulesChangeV1 | undefined) => void;
    initialWhere?: ReachRulesChangeV1;
    savedRules?: SkillListItemV1['rules'];
    initialSelectPaths?: readonly string[];
    onSelectionChange: (key: string, selectPaths: readonly string[] | undefined) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const key = rowKey(props.row);
  const read = useRegistryItem({
    kind: 'skill',
    sourceId: props.row.sourceId,
    itemId: props.row.itemId,
    ...(props.row.version ? { version: props.row.version } : {}),
  });
  const { onRead, onWhereChange } = props;
  React.useEffect(() => {
    onRead(key, read.item);
  }, [key, onRead, read.item]);
  const onWhere = React.useCallback((where: ReachRulesChangeV1 | undefined) => onWhereChange(key, where), [key, onWhereChange]);

  const skill =
    read.item?.payload.kind === 'skill' ? read.item.payload.skill : null;
  const trust: CapabilityTrust | undefined = skill
    ? deriveSkillTrustV1(skill.files)
    : undefined;
  const cost = skill ? estimateSkillCostV1(skill.skillMarkdown) : null;
  const outsideReferences = React.useMemo(
    () =>
      skill
        ? readSkillOutsideReferencesV1(
            skill.skillMarkdown,
            skill.files.map((file) => file.path),
          )
        : [],
    [skill],
  );
  // What adding this item would do, asked once the item is read (a dry run, nothing written): whether the library
  // already holds it, and the sibling skills of the same repository that its instructions refer to (added with it
  // unless unticked, or held already).
  const { execute, onSelectionChange, onHeld } = props;
  const version = read.item?.summary.version;
  const primaryPath = skill?.ref.kind === 'gitTree' ? skill.ref.path
    : skill?.ref.kind === 'wellKnown' ? skill.ref.name : undefined;
  const [offered, setOffered] = React.useState<Readonly<{ primary: SkillInstallPreviewV1; siblings: readonly SkillInstallPreviewV1[] }> | null>(null);
  React.useEffect(() => {
    setOffered(null);
    if (!version) {
      onHeld(key, undefined);
      return;
    }
    if (primaryPath === undefined) {
      onHeld(key, null);
      return;
    }
    onHeld(key, undefined);
    let current = true;
    void previewSkillInstall(execute, {
      kind: 'registry',
      sourceId: props.row.sourceId,
      itemId: props.row.itemId,
      version,
    }).then((preview) => {
      if (!current) return;
      const primary = preview.ok ? preview.items.find((item) => item.path === primaryPath) : undefined;
      // A preview that cannot answer leaves Add to the Action, which holds the same identity on commit.
      onHeld(key, primary?.inLibrary ?? null);
      if (!preview.ok || !primary) return;
      const siblings = preview.items.filter((item) => item.path !== primaryPath);
      if (siblings.length > 0) setOffered({ primary, siblings });
    });
    return () => {
      current = false;
    };
  }, [execute, key, onHeld, primaryPath, props.row.itemId, props.row.sourceId, version]);
  const siblingChoice = useSkillSiblingChoice({
    primary: offered?.primary ?? null,
    siblings: offered?.siblings ?? NO_PREVIEWS,
    outsideReferences,
    initialSelectPaths: props.initialSelectPaths,
    onOpenHeld: props.onOpenHeld,
    testID: `${TEST_ID}.detail`,
  });
  React.useEffect(() => {
    if (offered) onSelectionChange(key, siblingChoice.selectPaths);
  }, [key, offered, onSelectionChange, siblingChoice.selectPaths]);
  const ref = skill?.ref.kind === 'gitTree'
    ? skill.ref.commit.slice(0, 7)
    : shortRef(read.item?.summary.version);
  const repo = skill?.ref.kind === 'gitTree'
    ? (repositoryLabel(skill.ref.repo) ?? skill.ref.repo)
    : repositoryLabel(props.row.links?.repository);
  const indexSource = skill?.ref.kind === 'wellKnown' ? skillSource({ provenance: skill.ref }, (id) => id) : undefined;
  const indexVerification = skill?.ref.kind === 'wellKnown'
    ? skillSourceVerification({ provenance: skill.ref })
    : undefined;
  const problem = read.item?.summary.problem ?? props.row.problem;
  const purpose = (read.item ? rowDescription(read.item.summary) : null) ?? rowDescription(props.row);

  return (
    <SkillAddDetailBody
      testID={`${TEST_ID}.detail`}
      title={props.row.title}
      purpose={purpose}
      initialWhere={props.initialWhere}
      savedRules={props.savedRules}
      facts={{
        presentation: 'row',
        ...(indexSource && indexVerification ? { source: indexSource, extra: [indexVerification] }
          : repo ? { source: { kind: 'git' as const, label: repo, ...(ref ? { ref } : {}) } } : {}),
        ...(trust ? { trust } : {}),
        ...(cost ? { cost: { tokensWhenUsed: cost.bodyTokens } } : {}),
      }}
      notice={
        <>
          {problem ? (
            <Text variant="meta" style={{ color: theme.colors.state.warning.textForeground }}>
              {problem.code === 'too_large'
                ? t('capabilities.skillAdd.detail.problemTooLarge')
                : problem.code === 'removed_from_source'
                  ? t('capabilities.skillAdd.detail.problemRemoved')
                  : t('capabilities.skillAdd.detail.problemUnsupported')}
            </Text>
          ) : null}
          {read.error && !read.item ? (
            <View style={styles.partial} testID={`${TEST_ID}.detail.failure`}>
              <Text variant="meta" style={{ flexShrink: 1, color: read.status?.state === 'rate_limited' || read.status?.state === 'needs_machine'
                ? theme.colors.state.warning.textForeground : theme.colors.status.error }}>
                {read.status ? describeRegistrySourceStatus(read.status) : t('capabilities.skillAdd.detail.loadFailed')}
              </Text>
              <RoundButton size="small" display="secondary" title={t('capabilities.skillAdd.partial.tryAgain')}
                onPress={() => void read.refresh()} testID={`${TEST_ID}.detail.retry`} />
            </View>
          ) : null}
        </>
      }
      reading={!read.item && !read.error}
      installs={
        skill && trust && cost
          ? {
              trust,
              scripts: skill.files.filter((file) => file.unixMode === 0o755).length,
              files: skill.files,
              cost,
              // A repository source reads in Source and licence below; a well-known index stays here.
              ...(indexSource?.kind === 'link' && indexVerification
                ? { source: { icon: 'link' as const, title: indexSource.host, subtitle: indexVerification } }
                : {}),
            }
          : null
      }
      listing={{
        version: ref ?? null,
        sourceTitle: props.sourceTitle,
        license: (read.item?.summary ?? props.row).license ?? null,
        links: skill?.ref.kind === 'gitTree' ? { repository: skill.ref.repo } : (read.item?.summary ?? props.row).links ?? null,
      }}
      outsideReferences={siblingChoice.stillOutside}
      siblings={siblingChoice.rows}
      onWhereChange={onWhere}
    />
  );
}

const NO_PREVIEWS: readonly SkillInstallPreviewV1[] = [];


const styles = StyleSheet.create((theme) => ({
  provenance: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  // Centred in the body the list leaves, as the Add-an-agent plugin source draws its empty state.
  emptyPage: { flex: 1, justifyContent: 'center' },
  empty: {
    alignItems: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s32,
  },
  partial: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    flexWrap: 'wrap',
    marginTop: theme.space.s4,
  },
}));

