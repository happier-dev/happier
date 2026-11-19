import { useAuthoringDraftExitGuard } from '@/utils/navigation/useAuthoringDraftExitGuard';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_PICKS_SOURCE_ID,
} from '@happier-dev/protocol/registries';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
  CapabilityAddModalBody,
  openCapabilityAddModalHost,
  type CapabilityAddInputContext,
  type CapabilityAddModalConfig,
} from '@/components/capabilities/add/CapabilityAddModal';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { CustomModalDismissGuard, CustomModalInjectedProps } from '@/modal/types';
import { ModalCardHeader } from '@/modal/components/card/ModalCardHeader';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { admitRegistrySummaryMark } from '@/registries/registryBrandMark';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { useRegistrySourcesSlot } from '@/registries/useRegistrySourcesSlot';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import type { RegistryCatalogItemSummary as RegistryItemSummaryV1 } from '@/registries/registryBrandMark';
import { useMcpServersSettings } from '../useMcpServersSettings';
import {
  McpAddDetail,
  type McpAddDraft,
  type McpAddState,
} from './McpAddDetail';
import { McpPasteInput, useMcpPasteDraft, useMcpPasteDirty } from './McpPasteInput';
import {
  findAddedMcpServer,
  isMcpAddSuggestion,
  mcpAddCreateInputs,
  mcpAddRowKey,
  missingMcpAddFields,
  type McpAddCatalogRow,
} from './mcpAddModalConfig';
import { useMcpAddPlaces, type McpAddPlaces } from './useMcpAddPlaces';
import { McpCustomInput } from './McpCustomInput';
import { useMcpAddBinding, useMcpDraftDirty, useMcpServerDraft, type McpAddBinding } from './useMcpServerDraft';
import { useMcpAddSuggestions } from './useMcpAddSuggestions';
import { useMcpAddDraftState, useMcpAddDraftStore } from './mcpAddDraftState';

export type McpAddModeKey = 'catalog' | 'paste' | 'custom';
export type McpAddSelection = Pick<RegistryItemSummaryV1, 'sourceId' | 'itemId' | 'version'>;

export type OpenMcpAddModalParams = Readonly<{
  modeKey?: McpAddModeKey;
  sourceId?: string;
  query?: string;
  initialSelection?: McpAddSelection;
  /** Ephemeral, host-local continuation identity; draft values never enter a URL. */
  continuationId?: string;
  /** An install link to open Paste on (`?install=`): read exactly like pasted text. */
  installLink?: string;
  /** The page selects the new server (the first one added). */
  onAdded?: (serverId: string, options?: Readonly<{ afterRegistryAdd: true }>) => void;
}>;

const TEST_ID = 'mcp.add';

/** Add an MCP server (P7 §T6): Catalog, Paste a config, or Custom, in the one capability Add modal. */
export function openMcpAddModal(
  params: OpenMcpAddModalParams,
): Readonly<{ close: () => void }> {
  let dismissGuard: CustomModalDismissGuard | null = null;
  return openCapabilityAddModalHost(
    McpAddModal,
    { params, registerDismissGuard: (guard: CustomModalDismissGuard | null) => { dismissGuard = guard; } },
    { title: t('capabilities.mcpAdd.title'), subtitle: t('capabilities.mcpAdd.subtitle'), testID: TEST_ID,
      onDismissRequest: reason => dismissGuard?.(reason) },
  );
}

type Row = McpAddCatalogRow;
const rowKey = mcpAddRowKey;

function rowDescription(row: Row): string | null {
  const description = row.description?.trim();
  if (!description || description === row.publisher?.name) return null;
  return description;
}

type McpAddModalProps = CustomModalInjectedProps & Readonly<{ params: OpenMcpAddModalParams;
  registerDismissGuard?: (guard: CustomModalDismissGuard | null) => void }>;

export function McpAddModal(props: McpAddModalProps): React.ReactElement {
  return <McpAddController {...props} inputs>{(config, resolving) => config
    ? <CapabilityAddModalBody {...props} config={config} />
    : <>
      <ModalCardHeader inset="wide" title={t('capabilities.mcpAdd.title')} onClose={props.onClose} closeButtonTestID={`${TEST_ID}:close`} />
      <SurfaceStateCard kind={resolving ? 'loading' : 'error'} size="line"
        title={resolving ? t('common.loading') : t('common.unavailable')} testID={`${TEST_ID}.unavailable`} />
    </>}</McpAddController>;
}

type McpAddControllerProps = McpAddModalProps & Readonly<{
  /** The dialog's Paste and Custom inputs; a Store listing reviews its one catalog item without them. */
  inputs?: true;
  children: (config: CapabilityAddModalConfig<Row> | null, resolving: boolean) => React.ReactNode;
}>;

type McpAddContentProps = Omit<McpAddControllerProps, 'inputs'> & Readonly<{
  catalog: ReturnType<typeof useMcpServersSettings>;
  draftStore: ReturnType<typeof useMcpAddDraftStore>;
  execution: ReturnType<typeof useMountedActionExecution>;
}>;

/** What the dialog's input modes add to the catalog review: their bodies and the unsaved-draft question on leaving. */
type McpAddInputs = Readonly<{
  requestDeparture: (leave: () => void) => Promise<void>;
  modes: (actions: Readonly<{ places: McpAddPlaces; openServer: (serverId: string) => void; closeTask: () => void }>)
    => readonly CapabilityAddModalConfig<Row>['modes'][number][];
}>;

/** The same selected-item, draft and receipt owner for the dialog and Store pane/page. */
export function McpAddController(props: McpAddControllerProps): React.ReactNode {
  const catalog = useMcpServersSettings();
  const draftStore = useMcpAddDraftStore(catalog.scope, props.params.initialSelection, props.params.continuationId);
  const binding = useMcpAddBinding(catalog.scope);
  const execution = useMountedActionExecution(catalog.scope);
  if (!binding.current) return props.children(null, binding.resolving);
  return props.inputs
    ? <McpAddInputsOwner {...props} catalog={catalog} draftStore={draftStore} execution={execution} binding={binding} />
    : <McpAddModalContent {...props} catalog={catalog} draftStore={draftStore} execution={execution} inputs={null} />;
}

/** The dialog's Paste and Custom drafts: only the dialog subscribes to them and asks before discarding them. */
function McpAddInputsOwner(props: McpAddContentProps & Readonly<{ binding: McpAddBinding }>): React.ReactNode {
  const { params, catalog, execution } = props;
  const { scope, writable, reload, approval } = catalog;
  const customDraft = useMcpServerDraft(catalog, props.binding);
  const customDirty = useMcpDraftDirty(customDraft);
  const pasteDraft = useMcpPasteDraft({
    ...(params.installLink ? { initialText: params.installLink } : {}),
    execution, scope, writable: writable !== null, reloadCatalog: reload,
  });
  const pasteDirty = useMcpPasteDirty(pasteDraft);
  const isDirty = customDirty || pasteDirty;
  const dirtyRef = React.useRef(isDirty);
  dirtyRef.current = isDirty;
  const discardDrafts = React.useCallback(() => { customDraft.reset(); pasteDraft.reset(); dirtyRef.current = false; }, [customDraft.reset, pasteDraft.reset]);
  const saveDrafts = React.useCallback(async () => {
    if (customDraft.store.getState().dirty && (await customDraft.create()) === null) return false;
    return !pasteDraft.isDirty() || (await pasteDraft.create()) !== null;
  }, [customDraft.store, customDraft.create, pasteDraft.isDirty, pasteDraft.create]);
  const continueNavigation = React.useCallback(() => props.onClose(), [props.onClose]);
  const exit = useAuthoringDraftExitGuard({ isDirty, isDirtyRef: dirtyRef,
    onDiscard: discardDrafts, onSave: saveDrafts, onContinue: continueNavigation });
  const requestDeparture = React.useCallback(async (leave: () => void) => {
    if (!execution.isCurrent()) return;
    // An acknowledged Action may settle before React publishes its dirty subscription.
    dirtyRef.current = customDraft.store.getState().dirty || pasteDraft.isDirty();
    if (await exit.requestExit() && execution.isCurrent()) leave();
  }, [customDraft.store, pasteDraft.isDirty, execution.isCurrent, exit.requestExit]);
  React.useEffect(() => {
    props.registerDismissGuard?.(exit.requestExit);
    return () => props.registerDismissGuard?.(null);
  }, [exit.requestExit, props.registerDismissGuard]);
  const inputs = React.useMemo((): McpAddInputs => ({
    requestDeparture,
    modes: ({ places, openServer, closeTask }) => [
      {
        key: 'paste',
        label: t('capabilities.mcpAdd.modes.paste'),
        icon: 'file-text',
        kind: 'input',
        ownsTools: true,
        renderBody: (ctx: CapabilityAddInputContext) => (
          <McpPasteInput
            testID={`${TEST_ID}.paste`}
            ctx={ctx}
            draft={pasteDraft}
            execution={execution}
            scope={scope}
            places={places}
            writable={writable !== null}
            onAdded={serverIds => serverIds[0] ? openServer(serverIds[0]) : closeTask()}
            onDone={async () => {
              if (!pasteDraft.store.getSnapshot().added) pasteDraft.reset();
              await closeTask();
            }}
          />
        ),
      },
      {
        key: 'custom',
        label: t('capabilities.mcpAdd.modes.custom'),
        icon: 'terminal',
        kind: 'input',
        ownsTools: true,
        // How Happier reaches it leads the list; the chosen way's form is the details (lab `n:custom`).
        renderBody: (ctx: CapabilityAddInputContext) => <McpCustomInput ctx={ctx} draft={customDraft} approval={approval} places={places}
          onOpen={openServer} onDone={closeTask} />,
      },
    ],
  }), [approval, customDraft, execution, pasteDraft, requestDeparture, scope, writable]);
  return <McpAddModalContent {...props} inputs={inputs} />;
}

function McpAddModalContent(props: McpAddContentProps & Readonly<{ inputs: McpAddInputs | null }>): React.ReactNode {
  const { params, execution, inputs } = props;
  const { theme } = useUnistyles();
  const { settings, snapshot, scope, writable } = props.catalog;
  const { execute } = execution;
  const places = useMcpAddPlaces();
  const requestDeparture = React.useCallback(async (leave: () => void) => {
    if (inputs) return inputs.requestDeparture(leave);
    if (execution.isCurrent()) leave();
  }, [inputs, execution.isCurrent]);
  const closeTask = React.useCallback(() => requestDeparture(props.onClose), [requestDeparture, props.onClose]);
  const openServer = React.useCallback((serverId: string, options?: Readonly<{ afterRegistryAdd: true }>) => requestDeparture(() => {
    props.onClose();
    params.onAdded?.(serverId, options);
  }), [requestDeparture, props.onClose, params.onAdded]);
  const { sources: allSources } = useRegistrySources('mcpServer');
  const sourceTitle = React.useCallback(
    (sourceId: string) =>
      allSources.find((source) => source.id === sourceId)?.title ?? t('capabilities.store.unnamedCatalog'),
    [allSources],
  );

  const itemsFromSource = React.useCallback(
    (sourceId: string) =>
      settings.servers
        .filter(
          (server) =>
            server.origin?.kind === 'registry' &&
            server.origin.provenance.sourceId === sourceId,
        )
        .map((server) => ({
          title: server.title ?? server.name,
          onOpen: () => openServer(server.id),
        })),
    [openServer, settings.servers],
  );
  const [seedRequested, setSeedRequested] = React.useState(params.initialSelection !== undefined);
  const discardSeed = React.useCallback(() => setSeedRequested(false), []);
  const slot = useRegistrySourcesSlot('mcpServer', {
    itemsFromSource,
    ...((params.initialSelection?.sourceId ?? params.sourceId)
      ? { initialSelection: params.initialSelection?.sourceId ?? params.sourceId } : {}),
    onSelectionChange: discardSeed,
    testID: `${TEST_ID}.registries`,
  });
  const [query, setQuery] = React.useState(params.query ?? '');
  const changeQuery = React.useCallback((value: string) => { setQuery(value); setSeedRequested(false); }, []);
  const [catalogDemanded, setCatalogDemanded] = React.useState((params.modeKey ?? (params.installLink ? 'paste' : 'catalog')) === 'catalog');
  // A linked pin shows only its own row (no suggestions) until the person leaves it, like the registry read below.
  const suggestions = useMcpAddSuggestions(execution, catalogDemanded && !seedRequested);
  const catalog = useRegistryItems({
    kind: 'mcpServer',
    ...(slot.sourceIds ? { sourceIds: slot.sourceIds } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
  }, catalogDemanded && !seedRequested);
  // A linked pin may be outside the first page. Its identity is enough to
  // present the candidate; only the Collection's visible detail reads its body.
  const seed = params.initialSelection;
  const seedActive = seedRequested && Boolean(seed);

  // What the open details read and the person set: the footer adds exactly what is shown.
  const { drafts, setDrafts, adds, setAdds, detailScrollOffset } = useMcpAddDraftState(props.draftStore);
  const setAdd = React.useCallback(
    (key: string, state: McpAddState) =>
      setAdds((previous) => new Map(previous).set(key, state)),
    [setAdds],
  );
  const draftSetters = React.useRef(
    new Map<string, (draft: McpAddDraft) => void>(),
  );
  const draftSetter = React.useCallback((key: string) => {
    let setter = draftSetters.current.get(key);
    if (!setter) {
      setter = (draft: McpAddDraft) =>
        setDrafts((previous) => {
          const current = previous.get(key);
          if (
            current &&
            current.suggestionId === draft.suggestionId &&
            current.item === draft.item &&
            current.model === draft.model &&
            current.values === draft.values &&
            current.editedValues === draft.editedValues &&
            current.where === draft.where
          )
            return previous;
          return new Map(previous).set(key, draft);
        });
      draftSetters.current.set(key, setter);
    }
    return setter;
  }, [setDrafts]);
  // One edit callback per row, so an open detail keeps its props while other facts arrive.
  const draftEditors = React.useRef(
    new Map<string, (update: (current: McpAddDraft) => McpAddDraft) => void>(),
  );
  const draftEditor = React.useCallback((key: string) => {
    let editor = draftEditors.current.get(key);
    if (!editor) {
      editor = (update: (current: McpAddDraft) => McpAddDraft) => setDrafts((previous) => {
        const current = previous.get(key);
        return current ? new Map(previous).set(key, update(current)) : previous;
      });
      draftEditors.current.set(key, editor);
    }
    return editor;
  }, [setDrafts]);

  const create = React.useCallback(
    async (row: Row, draft: McpAddDraft): Promise<string> => {
      const key = rowKey(row);
      const version = draft.item?.summary.version;
      if (draft.model?.supported !== true || (isMcpAddSuggestion(row)
        ? draft.suggestionId !== row.suggestionId
        : !version || draft.item?.summary.sourceId !== row.sourceId || draft.item.summary.itemId !== row.itemId
          || (row.version !== undefined && version !== row.version)))
        throw new Error(t('capabilities.add.addFailed'));
      setAdd(key, { status: 'adding' });
      try {
        const result = await execute('mcp.servers.create', {
          expectedRevision: snapshot.revision,
          ...(isMcpAddSuggestion(row) ? { suggestionId: row.suggestionId } : {
            from: { registry: { sourceId: row.sourceId, itemId: row.itemId, version } },
            inputs: mcpAddCreateInputs(draft.values),
            ...(draft.model.signIn ? { remote: { auth: { kind: 'oauth' as const } } } : {}),
          }),
          ...(draft.where ? { where: draft.where } : {}),
        });
        if (!result.ok) throw createActionExecuteFailureError(result);
        const parsed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.create'].safeParse(result.result);
        if (!parsed.success || !('serverId' in parsed.data)) throw new Error('invalid_action_output');
        const serverId = parsed.data.serverId;
        setAdd(key, { status: 'added', serverId });
        return serverId;
      } catch (error) {
        setAdd(key, { status: 'failed', error: resolveActionExecutionErrorMessage(error, t('capabilities.add.addFailed')) });
        throw error;
      }
    },
    [execute, setAdd, snapshot.revision],
  );

  const seedItem = seed ? drafts.get(`${seed.sourceId}|${seed.itemId}`)?.item : null;
  const registryItems = React.useMemo(() => {
    if (!seedActive || !seed) return catalog.items;
    const listed = catalog.items.find(row => row.sourceId === seed.sourceId && row.itemId === seed.itemId && row.version === seed.version);
    const summary = seedItem?.summary;
    const row = summary?.sourceId === seed.sourceId && summary.itemId === seed.itemId && (!seed.version || summary.version === seed.version)
      ? admitRegistrySummaryMark(summary, listed)
      : listed ?? admitRegistrySummaryMark({ ...seed, kind: 'mcpServer', title: seed.itemId });
    return [row, ...catalog.items.filter(item => rowKey(item) !== rowKey(row))];
  }, [seedActive, seed, seedItem, catalog.items]);
  const items = React.useMemo<readonly Row[]>(() => {
    const visibleSuggestions = !seedActive && (slot.selection === 'all' || slot.selection === HAPPIER_PICKS_SOURCE_ID)
      ? suggestions.rows.filter(row => !query.trim() || `${row.title} ${row.description ?? ''} ${row.suggestionId}`.toLowerCase().includes(query.trim().toLowerCase()))
      : [];
    return [...visibleSuggestions, ...registryItems];
  }, [suggestions.rows, registryItems, query, slot.selection, seedActive]);
  const groups = React.useMemo(() => {
    const picks = items
      .filter((row) => isMcpAddSuggestion(row) || row.sourceId === HAPPIER_PICKS_SOURCE_ID)
      .map(rowKey);
    const rest = items
      .filter((row) => !isMcpAddSuggestion(row) && row.sourceId !== HAPPIER_PICKS_SOURCE_ID)
      .map(rowKey);
    const restTitle =
      slot.selection === 'all'
        ? t('capabilities.mcpAdd.groupAll')
        : t('capabilities.mcpAdd.groupSource', {
            source: sourceTitle(slot.selection),
          });
    return [
      ...(picks.length > 0
        ? [
            {
              key: 'picks',
              title: t('capabilities.mcpAdd.groupPicks'),
              itemKeys: picks,
            },
          ]
        : []),
      ...(rest.length > 0
        ? [{ key: 'rest', title: restTitle, itemKeys: rest }]
        : []),
    ];
  }, [items, slot.selection, sourceTitle]);

  // Groups already name Happier's picks and a single source; a row names its source only where sources mix.
  const multipleSources = React.useMemo(
    () =>
      new Set(
        items
          .filter((row) => !isMcpAddSuggestion(row) && row.sourceId !== HAPPIER_PICKS_SOURCE_ID)
          .map((row) => row.sourceId),
      ).size > 1,
    [items],
  );
  const anatomy = React.useMemo(
    () =>
      buildCapabilityCollectionAnatomy<Row>({
        title: (row) => row.title,
        description: rowDescription,
        // Every row holds the leading mark column: the registry's icon, else the transport glyph the lists share.
        mark: (row) => (
          <HappierBrandMark
            brand={row.brandMark ?? { displayName: row.title }}
            externallyLabelled
            pixelSize={20}
          />
        ),
        whereSummary: (row) => {
          const added =
            adds.get(rowKey(row))?.status === 'added' ||
            findAddedMcpServer(settings.servers, row) !== null;
          if (!added) return null;
          return (
            <View style={styles.inCatalog}>
              <Icon
                name="check"
                size={ICON_SIZE.xs}
                color={theme.colors.text.secondary}
              />
              <Text
                variant="meta"
                style={{ color: theme.colors.text.secondary }}
              >
                {t('capabilities.mcpAdd.inCatalog')}
              </Text>
            </View>
          );
        },
        facts: (row) => ({
          presentation: 'row',
          ...(row.publisher
            ? {
                source: {
                  kind: 'registry' as const,
                  label: row.publisher.name,
                },
              }
            : {}),
          // The source is a fact only when the visible rows come from more than one.
          extra: multipleSources && !isMcpAddSuggestion(row) && row.sourceId !== HAPPIER_PICKS_SOURCE_ID
            ? [t('capabilities.mcpAdd.via', { source: sourceTitle(row.sourceId) })]
            : [],
        }),
        accessibilityLabel: (row) => row.title,
        testID: (row) => `${TEST_ID}.row.${isMcpAddSuggestion(row) ? row.suggestionId : row.itemId}`,
      }),
    [adds, multipleSources, settings.servers, sourceTitle, theme.colors.text.secondary],
  );

  // The open detail and its footer read only these: list-only arrivals (sources, suggestions, pages) keep them.
  const renderDetail = React.useCallback(
    (row: Row) => (
      <McpAddDetail
        key={rowKey(row)}
        testID={TEST_ID}
        row={row}
        sourceTitle={isMcpAddSuggestion(row) ? null : sourceTitle(row.sourceId)}
        existing={findAddedMcpServer(settings.servers, row)}
        state={adds.get(rowKey(row)) ?? null}
        scope={scope}
        places={places}
        draft={drafts.get(rowKey(row))}
        onEdit={draftEditor(rowKey(row))}
        onDraft={draftSetter(rowKey(row))}
      />
    ),
    [adds, draftEditor, draftSetter, drafts, places, scope, settings.servers, sourceTitle],
  );
  const detailFooter = React.useCallback(
    (row: Row): ReturnType<CapabilityAddModalConfig<Row>['detailFooter']> => {
      const key = rowKey(row);
      const draft = drafts.get(key);
      const state = adds.get(key);
      const existing = findAddedMcpServer(settings.servers, row);
      const model = draft?.model ?? null;
      if (existing !== null && state?.status !== 'added') {
        return {
          primary: {
            label: t('capabilities.mcpAdd.open'),
            onPress: async () => { await openServer(existing.id); return null; },
          },
        };
      }
      const supported = model?.supported === true ? model : null;
      const missing = supported
        ? missingMcpAddFields(supported.fields, draft!.values)
        : [];
      const note = supported ? (
        <View style={styles.provenance}>
          <Icon
            name={supported.signIn ? 'globe' : 'lock'}
            size={ICON_SIZE.xs}
            color={theme.colors.text.secondary}
          />
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
            {supported.signIn && supported.remoteHost
              ? t('capabilities.mcpAdd.detail.signInNote', {
                  host: supported.remoteHost,
                })
              : t('capabilities.mcpAdd.detail.runsNote')}
          </Text>
        </View>
      ) : undefined;
      return {
        ...(note ? { provenance: note } : {}),
        primary: {
          // One label from first paint to Add: the sign-in a remote asks for is said in the note beside it.
          label: t('capabilities.mcpAdd.addServer'),
          busy: state?.status === 'adding',
          ...(writable === null
            ? { disabledReason: t('capabilities.add.addFailed') }
            : model !== null && !model.supported
              ? {
                  disabledReason: t('capabilities.mcpAdd.detail.unsupported'),
                }
              : !(draft?.item || draft?.suggestionId) || !supported
                ? { disabledReason: t('capabilities.mcpAdd.detail.loading') }
                : missing.length > 0
                  ? {
                      disabledReason: t(
                        'capabilities.mcpAdd.detail.stillNeeded',
                        {
                          count: missing.length,
                        },
                      ),
                    }
                  : {}),
          onPress: async () => {
            const serverId = await create(row, draft!);
            return { itemId: serverId, then: 'stay' };
          },
        },
        // Added, in place: the acknowledgement where the note stood, then the next step it needs (lab `m:mcp` + → Added ·
        // Sign in). The route continuation decides what Sign in opens; a server without a sign-in opens its page.
        afterAdd: {
          start: (
            <View style={styles.provenance} testID={`${TEST_ID}:added`} accessibilityLiveRegion="polite">
              <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
              <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{t('capabilities.add.added')}</Text>
            </View>
          ),
          open: { label: supported?.signIn ? t('capabilities.status.fix.signIn') : t('capabilities.mcpAdd.open'), onPress: async () => {
            if (state?.status !== 'added' || !state.serverId) return;
            await openServer(state.serverId, { afterRegistryAdd: true });
          } },
          onDone: closeTask,
        },
      };
    },
    [adds, closeTask, create, drafts, openServer, settings.servers, theme.colors.text.secondary, writable],
  );

  const config = React.useMemo(
    (): CapabilityAddModalConfig<Row> => ({
      title: t('capabilities.mcpAdd.title'),
      subtitle: t('capabilities.mcpAdd.subtitle'),
      testID: TEST_ID,
      detailScrollOffset,
      initialModeKey:
        params.modeKey ?? (params.installLink ? 'paste' : 'catalog'),
      onCatalogDemandChange: setCatalogDemanded,
      ...(seedActive && seed ? { initialItemKey: `${seed.sourceId}|${seed.itemId}` } : {}),
      modes: [
        {
          key: 'catalog',
          label: t('capabilities.mcpAdd.modes.catalog'),
          icon: 'magnifying-glass',
          kind: 'catalog',
        },
        ...(inputs?.modes({ places, openServer, closeTask }) ?? []),
      ],
      sources: slot.sources,
      catalog: {
        query,
        onQueryChange: changeQuery,
        searchPlaceholder: t('capabilities.mcpAdd.searchPlaceholder', {
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
        loading: (catalog.loading || suggestions.loading) && items.length === 0,
        ...(catalog.hasNextPage ? { loadMore: { label: t('common.more'), loading: false, onPress: catalog.nextPage } } : {}),
        sourceFailures: [...catalog.sourceFailures.map((failure) => ({
          ...failure,
          message: `${sourceTitle(failure.sourceId)} · ${failure.message}`,
        })), ...(suggestions.error ? [{ sourceId: 'mcp.servers.create', message: t('common.unavailable'), onRetry: suggestions.retry }] : [])],
        empty: <CatalogEmpty query={query} onClear={() => setQuery('')} />,
      },
      renderDetail,
      detailFooter,
    }),
    [
      detailScrollOffset,
      inputs,
      anatomy,
      catalog.loading,
      catalog.hasNextPage,
      catalog.nextPage,
      catalog.pages,
      catalog.sourceFailures,
      suggestions.loading,
      suggestions.error,
      suggestions.retry,
      changeQuery,
      closeTask,
      openServer,
      detailFooter,
      groups,
      items,
      params,
      places,
      query,
      renderDetail,
      seedActive,
      seed,
      slot.sources,
      sourceTitle,
    ],
  );

  return props.children(config, false);
}

function CatalogEmpty(props: Readonly<{ query: string; onClear: () => void }>) {
  const { theme } = useUnistyles();
  const query = props.query.trim();
  return (
    <View style={styles.empty}>
      <Text variant="body" style={{ color: theme.colors.text.secondary }}>
        {query
          ? t('capabilities.mcpAdd.noMatch', { query })
          : t('capabilities.mcpAdd.nothingHere')}
      </Text>
      {query ? (
        <RoundButton
          size="small"
          display="inverted"
          title={t('capabilities.mcpAdd.clear')}
          onPress={props.onClear}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  inCatalog: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  provenance: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  empty: {
    alignItems: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s32,
  },
}));
