import * as React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import { HappierColumnEdgeContext } from '../layout/columnEdge.js';
import {
  HappierCollectionNavigationBackClosesDetailContext,
  useHappierCollectionLayout,
} from '../collection/collectionLayout.js';
import { HappierCollectionRestingRowsContext } from '../collection/CollectionList.js';
import { useHappierCollection } from '../collection/useCollection.js';
import {
  deriveHappierCollectionSections,
  resolveHappierCollectionInitialKey,
} from '../collection/collectionModel.js';
// Types only: the list itself is the caller's (`host.Collection`, the public Collection), so this owner adds no
// runtime dependency on the components layer.
import type {
  CollectionAnatomy,
  CollectionDetailRenderContext,
  CollectionGroupAction,
  CollectionProps,
} from '../../components/Collection.js';

/**
 * The Add dialog's body (Capabilities A7 ruling 1): the ways to add as tabs, the catalog list with its details beside
 * it (pushed on a phone), each item's one action under its identity and the registry selector. One owner for Happier's Add a skill, Add a
 * server and Add an agent dialogs and for a plugin that adds its own installable things inside its own page or sheet.
 * The frame around it (a modal card, a sheet, a page) and the way back from one level in stay the caller's.
 */

/**
 * The list/detail split of a catalog: the list keeps its width, the details take the rest. Measured against lab `m:mcp`
 * (420 of 1040): at .34 the list's search shared its row with the source at 153 px and cut its own placeholder.
 */
export const HAPPIER_CATALOG_LIST_ROLE = Object.freeze({
  minListWidthPx: 320,
  minDetailWidthPx: 440,
  preferredListRatio: 0.4,
});

export type HappierCapabilityAddMode<Icon extends string = string> =
  | Readonly<{ key: string; label: string; icon: Icon; kind: 'catalog' }>
  | Readonly<{
      key: string;
      label: string;
      icon: Icon;
      kind: 'input';
      renderBody: (ctx: HappierCapabilityAddInputContext) => React.ReactNode;
      /** The body places the tools band itself (`ctx.tools`, or through `ctx.renderFound`). */
      ownsTools?: boolean;
    }>
  | Readonly<{
      key: string;
      label: string;
      icon: Icon;
      kind: 'handoff';
      onSelect: () => void;
    }>;

export type HappierCapabilityAddInputContext = Readonly<{
  /** The tools band: the mode tabs, then `field` where Browse has its search (a link field, a chosen upload). */
  tools: (field?: React.ReactNode) => React.ReactNode;
  /** What the input found, in Browse's own list and details, with the tools band leading it. */
  renderFound: <Found>(
    found: HappierCapabilityAddFound<Found>,
  ) => React.ReactElement;
  /** Opens one found item's details (one uploaded skill goes straight to them); `null` closes them. */
  openDetail: (itemKey: string | null) => void;
}>;

export type HappierCapabilityAddGroups = readonly Readonly<{
  key: string;
  title: string;
  /** The group heading's one action, as the Collection draws it (a found checklist's Select all / Select none). */
  action?: CollectionGroupAction;
  itemKeys: readonly string[];
}>[];

/** An input mode's results, shown and added through the body's one list + details path. */
export type HappierCapabilityAddFound<Found> = Readonly<{
  field?: React.ReactNode;
  items: readonly Found[];
  initialItemKey?: string;
  itemKey: (item: Found) => string;
  groups?: HappierCapabilityAddGroups;
  anatomy: CollectionAnatomy<Found>;
  /** The body before anything is found (what to paste or drop, and why). */
  empty: React.ReactNode;
  /** The input's pinned batch operation; stays reachable while previewing any result. */
  footer?: React.ReactNode;
  renderDetail: HappierCapabilityAddConfig<Found>['renderDetail'];
  /** Omit when the batch footer is the input's sole operation. */
  detailFooter?: HappierCapabilityAddConfig<Found>['detailFooter'];
  onAdded?: (result: Readonly<{ itemId: string }>) => void;
}>;

export type HappierCapabilityAddDetailContext = Readonly<{
  /** The details are the page (a phone): the body keeps its own heading; the action takes its own full-width line. */
  pushed: boolean;
  /** The primary resolved `then: 'stay'` for this item: the body shows its live state. */
  added: boolean;
}>;

export type HappierCapabilityAddDetailFooter = Readonly<{
  provenance?: React.ReactNode;
  primary: Readonly<{
    label: string;
    /** `null`: the person backed out (declined the confirm); nothing changes. */
    onPress: () => Promise<Readonly<{
      itemId: string;
      then?: 'close' | 'stay';
    }> | null>;
    busy?: boolean;
    disabledReason?: string;
  }>;
  /** After the primary resolved `then: 'stay'`: the footer's note, an optional way to the added item, and Done. */
  afterAdd?: Readonly<{
    start?: React.ReactNode;
    open?: Readonly<{ label: string; onPress: () => void }>;
    onDone?: () => void;
  }>;
}>;

export type HappierCapabilityAddConfig<
  Item,
  Icon extends string = string,
> = Readonly<{
  title: string;
  /** The header's purpose line; the caller's frame draws it. */
  subtitle?: string;
  modes: readonly HappierCapabilityAddMode<Icon>[];
  initialModeKey?: string;
  /** A deliberate item identity; unlike a row press this never pushes a cold phone list. */
  initialItemKey?: string;
  /** The person presented another mode. */
  onModeChange?: (key: string) => void;
  /** Demand the catalog only while it is presented, not behind an input or source-management level. */
  onCatalogDemandChange?: (demanded: boolean) => void;
  /** The registry selector beside the tabs while Browse shows, and the registries view one level in. */
  sources?: Readonly<{
    renderSelect: (
      ctx: Readonly<{ openRegistries: (intent: 'manage' | 'add') => void }>,
    ) => React.ReactNode;
    renderRegistriesView: (
      ctx: Readonly<{ intent: 'manage' | 'add'; back: () => void }>,
    ) => React.ReactNode;
    /** The header one level in ("Registries" · "Where Browse looks for skills."). */
    registriesHeader: Readonly<{ title: string; subtitle?: string }>;
  }>;
  catalog: Readonly<{
    query: string;
    onQueryChange: (query: string) => void;
    searchPlaceholder: string;
    resultCountLabel?: string;
    items: readonly Item[];
    groups?: HappierCapabilityAddGroups;
    itemKey: (item: Item) => string;
    anatomy: CollectionAnatomy<Item>;
    loading: boolean;
    /** The caller's explicit next-page operation; rendering never drains the catalog. */
    loadMore?: Readonly<{
      label: string;
      loading: boolean;
      onPress: () => Promise<void>;
    }>;
    sourceFailures?: readonly Readonly<{
      sourceId: string;
      message: string;
      onRetry: () => void;
    }>[];
    empty:
      | React.ReactNode
      | ((
          context: Readonly<{ selectMode: (key: string) => void }>,
        ) => React.ReactNode);
    /** One quiet line pinned under the list while no details are open (what the source checks). */
    footer?: React.ReactNode;
  }>;
  renderDetail: (
    item: Item,
    ctx: HappierCapabilityAddDetailContext,
  ) => React.ReactNode;
  /**
   * The open item's one action. The details lead with the item and that action: each detail places
   * `HappierCapabilityAddDetailAction` right under its identity and purpose (lab `m:mcp`).
   */
  detailFooter: (item: Item) => HappierCapabilityAddDetailFooter;
  onAdded?: (result: Readonly<{ itemId: string }>) => void;
  testID: string;
}>;

/** Where the body stands, for the caller's frame: its own header, an open detail on a phone, or the registries. */
export type HappierCapabilityAddLevel =
  | Readonly<{ kind: 'root' }>
  | Readonly<{ kind: 'detail'; back: () => void }>
  | Readonly<{
      kind: 'registries';
      header: Readonly<{ title: string; subtitle?: string }>;
      back: () => void;
    }>;

/** The words the body says itself. */
export type HappierCapabilityAddLabels = Readonly<{
  modesLabel: string;
  searchLabel: string;
  retry: string;
  closeDetails: string;
  added: string;
  done: string;
  addFailed: string;
}>;

/** The primitives the body draws with; Happier binds its own, the public adapter binds public components. */
export type HappierCapabilityAddHost<Icon extends string = string> = Readonly<{
  /** The public Collection: the list and its details. */
  Collection: <Item>(props: CollectionProps<Item>) => React.ReactElement;
  ModeTabs: React.ComponentType<
    Readonly<{
      modes: readonly Readonly<{ key: string; label: string; icon: Icon }>[];
      activeKey: string;
      onSelect: (key: string) => void;
      /** A phone page: every label still reads whole, so the glyphs step aside. */
      narrow: boolean;
      accessibilityLabel: string;
      testID: string;
    }>
  >;
  Button: React.ComponentType<
    Readonly<{
      title: string;
      display: 'primary' | 'secondary';
      loading?: boolean;
      disabled?: boolean;
      accessibilityHint?: string;
      onPress: () => void | Promise<void>;
      testID: string;
    }>
  >;
  /** Several buttons side by side share one size. */
  ButtonRow?: React.ComponentType<Readonly<{ children: React.ReactNode }>>;
  /** One failed source's quiet line with its own Retry. */
  SourceFailure: React.ComponentType<
    Readonly<{
      title: string;
      retryLabel: string;
      onRetry: () => void;
      retryTestID: string;
      testID: string;
    }>
  >;
  ErrorText: React.ComponentType<
    Readonly<{ children: string; testID: string }>
  >;
  /** Wraps the list (the caller's collection scope). */
  CollectionScope?: React.ComponentType<
    Readonly<{ children: React.ReactNode }>
  >;
  /** Wraps an input mode's body and the details' body: a contained column whose sections read like a page's. */
  ContainedPage?: React.ComponentType<Readonly<{ children: React.ReactNode }>>;
  /** Escape closes the open details before the frame (the caller's key layer). */
  useDismissDetail?: (enabled: boolean, onDismiss: () => void) => void;
}>;

export type HappierCapabilityAddBodyProps<
  Item,
  Icon extends string = string,
> = Readonly<{
  config: HappierCapabilityAddConfig<Item, Icon>;
  /** Closes the frame (Done, a handoff mode, an added item). */
  onClose: () => void;
  /** Where the body stands, for the frame's header and its way back. */
  onLevelChange?: (level: HappierCapabilityAddLevel) => void;
  /** Place the one mode control and current level in the caller's existing frame, during this render. */
  renderLayout?: (
    parts: Readonly<{
      modes: React.ReactNode;
      level: HappierCapabilityAddLevel;
      body: React.ReactNode;
    }>,
  ) => React.ReactElement;
  /** The frame is a phone page (the card fills the screen, details push). */
  phone: boolean;
  labels: HappierCapabilityAddLabels;
  host: HappierCapabilityAddHost<Icon>;
  /** The caller's spacing steps and hairline. */
  space?: Readonly<Record<'s4' | 's8' | 's12' | 's16' | 's24', number>>;
  hairlineColor: string;
}>;

type Shared = Readonly<{
  space: NonNullable<HappierCapabilityAddBodyProps<unknown>['space']>;
  edge: Readonly<{ paddingHorizontal: number }>;
  phone: boolean;
  hairlineColor: string;
  labels: HappierCapabilityAddLabels;
  /** Every slot but the tabs, which the body draws with its own mode type. */
  host: Omit<HappierCapabilityAddHost, 'ModeTabs'>;
}>;
const SharedContext = React.createContext<Shared | null>(null);
function useShared(): Shared {
  const shared = React.useContext(SharedContext);
  if (shared === null)
    throw new Error(
      'The Add body parts render inside HappierCapabilityAddBody.',
    );
  return shared;
}

const noDismiss = (_enabled: boolean, _onDismiss: () => void) => {};
const PassThrough = ({ children }: Readonly<{ children: React.ReactNode }>) => (
  <>{children}</>
);
type AddSelection = Readonly<{ key: string | null; explicit: boolean }>;
type AddOperation = Readonly<{ busy: boolean; error: string | null }>;
const IDLE_OPERATION: AddOperation = Object.freeze({
  busy: false,
  error: null,
});

export function HappierCapabilityAddBody<Item, Icon extends string = string>(
  props: HappierCapabilityAddBodyProps<Item, Icon>,
): React.ReactElement {
  const { config, onClose, onLevelChange, host } = props;
  const space = props.space ?? HAPPIER_SPACE_STEPS;
  const edge = React.useMemo(
    () => ({ paddingHorizontal: props.phone ? space.s16 : space.s24 }),
    [props.phone, space],
  );
  const shared = React.useMemo<Shared>(
    () => ({
      space,
      edge,
      phone: props.phone,
      hairlineColor: props.hairlineColor,
      labels: props.labels,
      host,
    }),
    [space, edge, props.phone, props.hairlineColor, props.labels, host],
  );
  const { catalog } = config;
  const [modeKey, setModeKey] = React.useState(
    config.initialModeKey ?? config.modes[0]?.key ?? '',
  );
  const [selections, setSelections] = React.useState<
    ReadonlyMap<string, AddSelection>
  >(() => new Map());
  const selection = selections.get(modeKey) ?? {
    key: config.initialItemKey ?? null,
    explicit: false,
  };
  const setSelection = React.useCallback(
    (key: string | null, explicit: boolean) => {
      setSelections((previous) => {
        const current = previous.get(modeKey);
        const next = {
          key: key ?? current?.key ?? null,
          explicit: key !== null && explicit,
        };
        if (current?.key === next.key && current.explicit === next.explicit)
          return previous;
        return new Map(previous).set(modeKey, next);
      });
    },
    [modeKey],
  );
  const openDetail = React.useCallback(
    (key: string | null) => setSelection(key, true),
    [setSelection],
  );
  const land = React.useCallback(
    (key: string | null) => {
      setSelections((previous) => {
        const current = previous.get(modeKey);
        if (current?.key === key) return previous;
        return new Map(previous).set(modeKey, { key, explicit: false });
      });
    },
    [modeKey],
  );
  const [registries, setRegistries] = React.useState<'manage' | 'add' | null>(
    null,
  );
  const [added, setAdded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [operations, setOperations] = React.useState<
    ReadonlyMap<string, AddOperation>
  >(() => new Map());
  const liveOperations = React.useRef(operations);
  const operationKey = (key: string) => JSON.stringify([modeKey, key]);
  const updateOperation = (key: string, operation: AddOperation) => {
    const next = new Map(liveOperations.current).set(
      operationKey(key),
      operation,
    );
    liveOperations.current = next;
    setOperations(next);
  };
  const mode =
    config.modes.find((candidate) => candidate.key === modeKey) ??
    config.modes[0];
  const catalogDemanded = mode?.kind === 'catalog' && registries === null;
  React.useEffect(() => {
    config.onCatalogDemandChange?.(catalogDemanded);
  }, [catalogDemanded, config.onCatalogDemandChange]);

  const useDismissDetail = host.useDismissDetail ?? noDismiss;
  useDismissDetail(
    registries !== null ||
      (selection.explicit && (props.phone || mode?.kind === 'input')),
    () => {
      if (registries !== null) setRegistries(null);
      else openDetail(null);
    },
  );

  // One level in (Registries), or an open detail on a phone, where the details are the page: the frame shows the way back.
  const detailBackInHeader =
    props.phone &&
    selection.explicit &&
    selection.key !== null &&
    registries === null;
  const registriesHeader = config.sources?.registriesHeader;
  const level: HappierCapabilityAddLevel =
    registries !== null && registriesHeader !== undefined
      ? {
          kind: 'registries',
          header: registriesHeader,
          back: () => setRegistries(null),
        }
      : detailBackInHeader
        ? { kind: 'detail', back: () => openDetail(null) }
        : { kind: 'root' };
  React.useEffect(() => {
    if (onLevelChange === undefined) return;
    if (registries !== null && registriesHeader !== undefined)
      onLevelChange({
        kind: 'registries',
        header: registriesHeader,
        back: () => setRegistries(null),
      });
    else if (detailBackInHeader)
      onLevelChange({ kind: 'detail', back: () => openDetail(null) });
    else onLevelChange({ kind: 'root' });
  }, [
    detailBackInHeader,
    onLevelChange,
    openDetail,
    registries,
    registriesHeader,
  ]);

  const selectMode = React.useCallback(
    (key: string) => {
      const next = config.modes.find((candidate) => candidate.key === key);
      if (next === undefined) return;
      if (next.kind === 'handoff') {
        onClose();
        next.onSelect();
        return;
      }
      setModeKey(key);
      config.onModeChange?.(key);
    },
    [config.modes, config.onModeChange, onClose],
  );

  const tools = (search: React.ReactNode) => (
    <View style={[styles.tools, { gap: space.s12 }]}>
      {props.renderLayout !== undefined ? null : (
        <CatalogModes
          ModeTabs={host.ModeTabs}
          modes={config.modes}
          activeKey={mode?.key ?? ''}
          onSelect={selectMode}
          testID={config.testID}
        />
      )}
      {/* The search leads and grows; the source it searches sits at its end (lab `m:mcp`). */}
      {search === null || search === undefined ? null : (
        <View style={styles.search}>{search}</View>
      )}
      {config.sources === undefined || mode?.kind !== 'catalog'
        ? null
        : config.sources.renderSelect({ openRegistries: setRegistries })}
    </View>
  );
  const toolsBand = { paddingBottom: space.s12 };

  const common = {
    title: config.title,
    testID: config.testID,
    selection,
    onOpenChange: openDetail,
    onLandingChange: land,
    isAdded: (key: string) => added.has(operationKey(key)),
    onStay: (key: string) =>
      setAdded((previous) => new Set(previous).add(operationKey(key))),
    operation: (key: string) =>
      operations.get(operationKey(key)) ?? IDLE_OPERATION,
    beginOperation: (key: string) => {
      if (
        liveOperations.current.get(operationKey(key))?.busy ||
        added.has(operationKey(key))
      )
        return false;
      updateOperation(key, { busy: true, error: null });
      return true;
    },
    finishOperation: (key: string, error: string | null) =>
      updateOperation(key, { busy: false, error }),
    onClose,
    detailBackInHeader,
  };

  let body: React.ReactElement;
  if (registries !== null && config.sources !== undefined) {
    body = (
      <View style={styles.fill} testID={`${config.testID}:registries`}>
        {config.sources.renderRegistriesView({
          intent: registries,
          back: () => setRegistries(null),
        })}
      </View>
    );
  } else if (mode?.kind === 'input') {
    const ContainedPage = host.ContainedPage ?? PassThrough;
    const input = mode.renderBody({
      tools: (field) => (
        <View style={[toolsBand, edge]}>{tools(field ?? null)}</View>
      ),
      renderFound: (found) => (
        <AddCollection
          {...common}
          items={found.items}
          {...(found.initialItemKey === undefined
            ? {}
            : { initialItemKey: found.initialItemKey })}
          itemKey={found.itemKey}
          {...(found.groups === undefined ? {} : { groups: found.groups })}
          anatomy={found.anatomy}
          loading={false}
          empty={found.empty}
          header={() => tools(found.field ?? null)}
          renderDetail={found.renderDetail}
          {...(found.detailFooter === undefined
            ? {}
            : { detailFooter: found.detailFooter })}
          {...(found.onAdded === undefined ? {} : { onAdded: found.onAdded })}
          footer={found.footer === undefined ? null : found.footer}
          footerWhileDetail
        />
      ),
      openDetail,
    });
    body =
      mode.ownsTools === true ? (
        <View style={styles.fill}>{input}</View>
      ) : (
        <View style={styles.fill}>
          <View style={[toolsBand, edge]}>{tools(null)}</View>
          <View style={styles.fill}>
            <ContainedPage>{input}</ContainedPage>
          </View>
        </View>
      );
  } else {
    // One registry failing never empties the others: each failed source keeps one quiet line with its own Retry. When
    // nothing came back at all, that line is the state, never "no results".
    const failures = catalog.sourceFailures ?? [];
    const onlyFailures =
      failures.length > 0 && catalog.items.length === 0 && !catalog.loading;
    const failureLines =
      failures.length === 0 ? null : (
        <View
          style={
            onlyFailures
              ? [{ paddingTop: space.s16 }, edge]
              : { paddingTop: space.s12 }
          }
        >
          {failures.map((failure) => (
            <host.SourceFailure
              key={failure.sourceId}
              title={failure.message}
              retryLabel={props.labels.retry}
              onRetry={failure.onRetry}
              retryTestID={`${config.testID}:sourceFailure:${failure.sourceId}:retry`}
              testID={`${config.testID}:sourceFailure:${failure.sourceId}`}
            />
          ))}
        </View>
      );
    body = (
      <AddCollection
        {...common}
        items={catalog.items}
        {...(config.initialItemKey === undefined
          ? {}
          : { initialItemKey: config.initialItemKey })}
        itemKey={catalog.itemKey}
        {...(catalog.groups === undefined ? {} : { groups: catalog.groups })}
        anatomy={catalog.anatomy}
        loading={catalog.loading}
        {...(catalog.loadMore === undefined
          ? {}
          : { loadMore: catalog.loadMore })}
        empty={
          onlyFailures
            ? failureLines
            : typeof catalog.empty === 'function'
              ? catalog.empty({ selectMode })
              : catalog.empty
        }
        search={{
          label: props.labels.searchLabel,
          value: catalog.query,
          onValueChange: catalog.onQueryChange,
          placeholder: catalog.searchPlaceholder,
          width: 'fill',
          testID: `${config.testID}:search`,
        }}
        header={(search) => (
          <>
            {tools(search)}
            {onlyFailures ? null : failureLines}
          </>
        )}
        renderDetail={config.renderDetail}
        detailFooter={config.detailFooter}
        {...(config.onAdded === undefined ? {} : { onAdded: config.onAdded })}
        footer={
          catalog.footer === undefined ? null : (
            <View
              style={[
                styles.listFooter,
                {
                  paddingVertical: space.s12,
                  borderTopColor: props.hairlineColor,
                },
                edge,
              ]}
              testID={`${config.testID}:list-footer`}
            >
              {catalog.footer}
            </View>
          )
        }
      />
    );
  }
  const modes = (
    <CatalogModes
      ModeTabs={host.ModeTabs}
      modes={config.modes}
      activeKey={mode?.key ?? ''}
      onSelect={selectMode}
      testID={config.testID}
    />
  );
  return (
    <SharedContext.Provider value={shared}>
      {props.renderLayout ? props.renderLayout({ modes, level, body }) : body}
    </SharedContext.Provider>
  );
}

/**
 * The body's one list + details: the public `Collection` (list, `detail: 'auto'`) at the catalog list role, its
 * header in the tools band, details beside the list (pushed on a phone) and the list's footer pinned while no details
 * are open. Browse's catalog and an input mode's results (a link's skills, an upload) both render through it.
 */
function AddCollection<Item>(
  props: Readonly<{
    title: string;
    testID: string;
    items: readonly Item[];
    initialItemKey?: string;
    itemKey: (item: Item) => string;
    groups?: HappierCapabilityAddGroups;
    anatomy: CollectionAnatomy<Item>;
    loading: boolean;
    loadMore?: HappierCapabilityAddConfig<Item>['catalog']['loadMore'];
    empty: React.ReactNode;
    search?: NonNullable<CollectionProps<Item>['search']>;
    header: (search: React.ReactNode) => React.ReactNode;
    renderDetail: HappierCapabilityAddConfig<Item>['renderDetail'];
    detailFooter?: HappierCapabilityAddConfig<Item>['detailFooter'];
    onAdded?: (result: Readonly<{ itemId: string }>) => void;
    footer: React.ReactNode;
    footerWhileDetail?: boolean;
    selection: AddSelection;
    onOpenChange: (key: string | null) => void;
    onLandingChange: (key: string | null) => void;
    isAdded: (key: string) => boolean;
    operation: (key: string) => AddOperation;
    beginOperation: (key: string) => boolean;
    finishOperation: (key: string, error: string | null) => void;
    onStay: (key: string) => void;
    onClose: () => void;
    detailBackInHeader: boolean;
  }>,
): React.ReactElement {
  const shared = useShared();
  const { items, itemKey, onOpenChange } = props;
  const declared = props.groups;
  const groups = React.useMemo(() => {
    if (declared === undefined || declared.length === 0) return undefined;
    const groupOf = new Map<string, string>();
    for (const group of declared)
      for (const key of group.itemKeys) groupOf.set(key, group.key);
    return {
      axis: declared.map((group) => ({ key: group.key, title: group.title })),
      groupOf: (item: Item) => groupOf.get(itemKey(item)) ?? declared[0]!.key,
    };
  }, [declared, itemKey]);

  // Derive the same displayed order the Collection uses, before its first settled render. No visit memory or effect-open.
  const keys = React.useMemo(
    () =>
      deriveHappierCollectionSections({
        items,
        keyOf: itemKey,
        ...(groups === undefined ? {} : { groups }),
      }).flatMap((section) => section.items.map(itemKey)),
    [groups, itemKey, items],
  );
  const openKey = resolveHappierCollectionInitialKey({
    keys,
    lastVisited: props.selection.key ?? props.initialItemKey ?? null,
  });
  const explicit = props.selection.explicit && props.selection.key === openKey;
  // Completion follows deliberate selection, not automatic landing when an
  // acknowledged add withdraws its Found row before the response settles.
  const activeKey = React.useRef<string | null>(openKey);
  const activeQuery = React.useRef(props.search?.value);
  activeQuery.current = props.search?.value;
  const select = React.useCallback((key: string | null) => {
    activeKey.current = key;
    onOpenChange(key);
  }, [onOpenChange]);
  React.useEffect(
    () => () => {
      activeKey.current = null;
    },
    [],
  );
  const model = useHappierCollection<Item>({
    items,
    keyOf: itemKey,
    ...(groups === undefined ? {} : { groups }),
    openKey,
    onOpenChange: select,
  });

  const itemsByKey = React.useMemo(
    () => new Map(items.map((item) => [itemKey(item), item])),
    [items, itemKey],
  );

  // Remember the admitted choice, not a repeated "select first". An absent explicit item falls back without a phone push.
  React.useEffect(() => {
    if (!props.loading || openKey !== null) props.onLandingChange(openKey);
  }, [openKey, props.loading, props.onLandingChange]);

  const renderDetail = (
    key: string,
    context: CollectionDetailRenderContext,
  ) => {
    const item = itemsByKey.get(key);
    if (item === undefined) return null;
    return (
      <AddDetail
        key={key}
        item={item}
        itemKey={key}
        renderDetail={props.renderDetail}
        {...(props.detailFooter === undefined
          ? {}
          : { detailFooter: props.detailFooter })}
        testID={props.testID}
        pushed={context.pushed}
        added={props.isAdded(key)}
        operation={props.operation(key)}
        beginOperation={() => {
          const began = props.beginOperation(key);
          if (began) activeKey.current = key;
          return began;
        }}
        finishOperation={(error) => props.finishOperation(key, error)}
        primaryDisplay={
          props.footerWhileDetail && props.footer !== null
            ? 'secondary'
            : 'primary'
        }
        onCloseDialog={props.onClose}
        onPrimaryDone={(result) => {
          if (result.then === 'stay' || activeKey.current !== key
            || activeQuery.current !== props.search?.value) {
            props.onStay(key);
            return;
          }
          props.onClose();
          props.onAdded?.({ itemId: result.itemId });
        }}
      />
    );
  };

  const Scope = shared.host.CollectionScope ?? PassThrough;
  return (
    <Scope>
      {/* The list keeps one rhythm: ruled rows beside the details; a phone's full-screen list parts its rows by air
          on the page's edges, as its pushed details' sections do (lab `mp:mcpList`). */}
      <HappierCollectionRestingRowsContext.Provider
        value={shared.phone ? 'air-page' : 'ruled'}
      >
        <HappierCollectionNavigationBackClosesDetailContext.Provider
          value={props.detailBackInHeader}
        >
          <View style={styles.fill}>
            <shared.host.Collection<Item>
              model={model}
              anatomy={props.anatomy}
              accessibilityLabel={props.title}
              presentation="list"
              detail="auto"
              detailOpenIntent={explicit ? 'explicit' : 'landing'}
              renderDetail={renderDetail}
              minListWidth={HAPPIER_CATALOG_LIST_ROLE.minListWidthPx}
              minDetailWidth={HAPPIER_CATALOG_LIST_ROLE.minDetailWidthPx}
              preferredListRatio={HAPPIER_CATALOG_LIST_ROLE.preferredListRatio}
              loading={props.loading}
              {...(declared?.some((group) => group.action !== undefined)
                ? {
                    groupAction: (groupKey: string) =>
                      declared.find((group) => group.key === groupKey)
                        ?.action ?? null,
                  }
                : {})}
              // More stands on the rows' edge (the body's edge, the phone gutter), never across the list's sides.
              {...(props.loadMore === undefined
                ? {}
                : {
                    footer: (
                      <View
                        style={[
                          shared.edge,
                          { paddingVertical: shared.space.s8 },
                        ]}
                      >
                        <shared.host.Button
                          title={props.loadMore.label}
                          display="secondary"
                          loading={props.loadMore.loading}
                          disabled={props.loadMore.loading}
                          onPress={() => props.loadMore?.onPress()}
                          testID={`${props.testID}:load-more`}
                        />
                      </View>
                    ),
                  })}
              empty={props.empty}
              {...(props.search === undefined ? {} : { search: props.search })}
              // The search, the source and an input's field lead their own list; the details start at the top beside it.
              headerPlacement="list"
              header={(slots) => (
                <ToolsBand open={explicit && openKey !== null}>
                  {props.header(slots.search)}
                </ToolsBand>
              )}
              testID={`${props.testID}:collection`}
              listTestID={`${props.testID}:list`}
              detailTestID={`${props.testID}:detail`}
            />
          </View>
        </HappierCollectionNavigationBackClosesDetailContext.Provider>
      </HappierCollectionRestingRowsContext.Provider>
      {explicit && openKey !== null && !props.footerWhileDetail
        ? null
        : props.footer}
    </Scope>
  );
}

/** The body's one content edge (the tools band, failure lines and footers stand on it): for an input mode's own parts. */
export function useHappierCapabilityAddEdge(): Readonly<{
  paddingHorizontal: number;
}> {
  return useShared().edge;
}

/**
 * Whether the body reads as a phone page. A Collection's own layout says so for its list and details; an input mode
 * (Link, Upload, Paste) sits outside any Collection, so there the frame's phone presentation decides.
 */
function useAddBodyNarrow(): boolean {
  const layout = useHappierCollectionLayout();
  return useShared().phone || layout?.mode === 'stacked';
}

/** The modes as a tab list hugging their labels; on a phone page the glyphs step aside first, labels never truncate. */
function CatalogModes<Icon extends string>(
  props: Readonly<{
    ModeTabs: HappierCapabilityAddHost<Icon>['ModeTabs'];
    modes: readonly HappierCapabilityAddMode<Icon>[];
    activeKey: string;
    onSelect: (key: string) => void;
    testID: string;
  }>,
): React.ReactElement | null {
  const narrow = useAddBodyNarrow();
  const { labels } = useShared();
  const { ModeTabs } = props;
  // One way to add is no choice: no one-segment tab list (Add a plugin browses only).
  if (props.modes.length < 2) return null;
  return (
    <ModeTabs
      modes={props.modes.map((mode) => ({
        key: mode.key,
        label: mode.label,
        icon: mode.icon,
      }))}
      activeKey={props.activeKey}
      onSelect={props.onSelect}
      narrow={narrow}
      accessibilityLabel={labels.modesLabel}
      testID={props.testID}
    />
  );
}

/** The tools band; on a phone the pushed details are the page, so the band steps aside while they show. */
function ToolsBand(
  props: Readonly<{ open: boolean; children: React.ReactNode }>,
): React.ReactElement | null {
  const layout = useHappierCollectionLayout();
  const { edge, space, host } = useShared();
  if (props.open && layout?.mode === 'stacked') return null;
  // The band already stands on the body's edge: a section an input places here (Where it's on) adds no second inset.
  const ContainedPage = host.ContainedPage ?? PassThrough;
  return (
    <View style={[{ paddingBottom: space.s12 }, edge]}>
      <ContainedPage>{props.children}</ContainedPage>
    </View>
  );
}

/**
 * The pinned footer of the Add body: a quiet note (or the failure) at the start, the actions at the end. Where the
 * details are a phone page (`stacked`) the note reads on its own line and the actions share the full width. A mode that
 * is not a Collection's details (Link, Upload, Paste) is a phone page exactly when the frame is presented as one.
 */
export function HappierCapabilityAddFooter(
  props: Readonly<{
    start: React.ReactNode;
    children: React.ReactNode;
    stacked?: boolean;
    testID?: string;
  }>,
): React.ReactElement {
  const narrow = useAddBodyNarrow();
  const { edge, space, hairlineColor } = useShared();
  const stacked = props.stacked ?? narrow;
  const frame = [
    styles.row,
    styles.footerRule,
    {
      gap: space.s16,
      paddingVertical: space.s12,
      borderTopColor: hairlineColor,
    },
  ];
  if (stacked) {
    return (
      <View
        testID={props.testID}
        style={[...frame, styles.stacked, { gap: space.s12 }, edge]}
      >
        {props.start === null || props.start === undefined ? null : props.start}
        <View style={[styles.row, styles.stretch, { gap: space.s8 }]}>
          {React.Children.toArray(props.children).map((child, index) => (
            <View key={index} style={styles.slot}>
              {child}
            </View>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View testID={props.testID} style={[...frame, edge]}>
      <View style={styles.slot}>{props.start}</View>
      {props.children}
    </View>
  );
}

const DetailActionContext = React.createContext<React.ReactNode>(null);

/**
 * The open item's one action and what it does: the details place it right under their identity and purpose, so the
 * decision sits with what it decides (lab `m:mcp`). Renders nothing outside the Add body's details.
 */
export function HappierCapabilityAddDetailAction(): React.ReactElement | null {
  const action = React.useContext(DetailActionContext);
  return action === null ? null : <>{action}</>;
}

export type HappierCapabilityListingDetailProps<Item> = Readonly<{
  item: Item;
  itemKey: string;
  renderDetail: HappierCapabilityAddConfig<Item>['renderDetail'];
  detailFooter?: HappierCapabilityAddConfig<Item>['detailFooter'];
  /** An optional host-owned position for a review moving between listing surfaces. */
  detailScrollOffset?: { current: number };
  /** The primary resolved `then: 'close'`: the caller continues to the added item. */
  onAdded?: (result: Readonly<{ itemId: string }>) => void;
  /** Leaves the listing (Done, or the after-add way to the item). */
  onClose: () => void;
  /** The listing is a phone page: the action takes its own full-width line. */
  pushed: boolean;
  phone: boolean;
  labels: HappierCapabilityAddLabels;
  /** The same primitives the Add body draws with (its tabs are not used here). */
  host: Omit<HappierCapabilityAddHost, 'ModeTabs'>;
  space?: HappierCapabilityAddBodyProps<Item>['space'];
  hairlineColor: string;
  testID: string;
}>;

/**
 * One item's listing outside the Add body (a Store pane or page): the very details the Add body opens beside its
 * list, with its identity, the one action under it and the action's own busy/failed/added state. The caller keys it
 * by item, so another item starts from rest. Memoized: its owner re-renders for catalog facts this review does not
 * read, and the review redraws only when its own props change.
 */
export const HappierCapabilityListingDetail = React.memo(CapabilityListingDetail) as typeof CapabilityListingDetail;

function CapabilityListingDetail<Item>(
  props: HappierCapabilityListingDetailProps<Item>,
): React.ReactElement {
  const space = props.space ?? HAPPIER_SPACE_STEPS;
  const edge = React.useMemo(
    () => ({ paddingHorizontal: props.phone ? space.s16 : space.s24 }),
    [props.phone, space],
  );
  const shared = React.useMemo<Shared>(
    () => ({
      space,
      edge,
      phone: props.phone,
      hairlineColor: props.hairlineColor,
      labels: props.labels,
      host: props.host,
    }),
    [space, edge, props.phone, props.hairlineColor, props.labels, props.host],
  );
  const [added, setAdded] = React.useState(false);
  const [operation, setOperation] =
    React.useState<AddOperation>(IDLE_OPERATION);
  const busy = React.useRef(false);
  const { onAdded } = props;
  return (
    <SharedContext.Provider value={shared}>
      <AddDetail
        item={props.item}
        itemKey={props.itemKey}
        detailScrollOffset={props.detailScrollOffset}
        renderDetail={props.renderDetail}
        {...(props.detailFooter === undefined
          ? {}
          : { detailFooter: props.detailFooter })}
        testID={props.testID}
        pushed={props.pushed}
        added={added}
        operation={operation}
        beginOperation={() => {
          if (busy.current || added) return false;
          busy.current = true;
          setOperation({ busy: true, error: null });
          return true;
        }}
        finishOperation={(error) => {
          busy.current = false;
          setOperation({ busy: false, error });
        }}
        primaryDisplay="primary"
        onCloseDialog={props.onClose}
        onPrimaryDone={(result) => {
          setAdded(true);
          if (result.then !== 'stay') onAdded?.({ itemId: result.itemId });
        }}
      />
    </SharedContext.Provider>
  );
}

function AddDetail<Item>(
  props: Readonly<{
    item: Item;
    itemKey: string;
    renderDetail: HappierCapabilityAddConfig<Item>['renderDetail'];
    detailFooter?: HappierCapabilityAddConfig<Item>['detailFooter'];
    detailScrollOffset?: { current: number };
    testID: string;
    pushed: boolean;
    added: boolean;
    operation: AddOperation;
    beginOperation: () => boolean;
    finishOperation: (error: string | null) => void;
    primaryDisplay: 'primary' | 'secondary';
    onCloseDialog: () => void;
    onPrimaryDone: (
      result: Readonly<{ itemId: string; then?: 'close' | 'stay' }>,
    ) => void;
  }>,
): React.ReactElement {
  const { edge, space, host, labels } = useShared();
  const scrollRef = React.useRef<ScrollView>(null);
  const { detailScrollOffset } = props;
  const restoreScroll = React.useCallback(() => {
    if (detailScrollOffset) scrollRef.current?.scrollTo({ x: 0, y: detailScrollOffset.current, animated: false });
  }, [detailScrollOffset]);
  const footer = props.detailFooter?.(props.item);
  const { busy, error } = props.operation;
  const press = React.useCallback(async () => {
    if (footer === undefined || !props.beginOperation()) return;
    let failureMessage: string | null = null;
    try {
      const result = await footer.primary.onPress();
      if (result !== null) props.onPrimaryDone(result);
    } catch (failure) {
      failureMessage =
        failure instanceof Error && failure.message
          ? failure.message
          : labels.addFailed;
    } finally {
      props.finishOperation(failureMessage);
    }
  }, [footer?.primary, labels.addFailed, props]);
  const afterAdd = props.added ? footer?.afterAdd : undefined;
  // On a phone page each after-add action takes an equal share of the row; the footer slots its children.
  const slot = (node: React.ReactNode) =>
    props.pushed ? <View style={styles.slot}>{node}</View> : node;
  const ButtonRow = host.ButtonRow ?? PassThrough;
  // Once added, the next step it needs (Sign in, Open) leads and Done steps back.
  const nextLeads = afterAdd?.open !== undefined;
  const primary =
    footer === undefined ? null : afterAdd !== undefined ? (
      <ButtonRow>
        <View
          style={[
            styles.row,
            props.pushed ? styles.slot : null,
            { gap: space.s8 },
          ]}
        >
          {afterAdd.open === undefined
            ? null
            : slot(
                <host.Button
                  title={afterAdd.open.label}
                  display={nextLeads ? props.primaryDisplay : 'secondary'}
                  onPress={() => {
                    props.onCloseDialog();
                    afterAdd.open?.onPress();
                  }}
                  testID={`${props.testID}:open-added`}
                />,
              )}
          {slot(
            <host.Button
              title={labels.done}
              display={nextLeads ? 'secondary' : props.primaryDisplay}
              onPress={() => {
                props.onCloseDialog();
                afterAdd.onDone?.();
              }}
              testID={`${props.testID}:done`}
            />,
          )}
        </View>
      </ButtonRow>
    ) : (
      <host.Button
        title={props.added ? labels.added : footer.primary.label}
        display={props.primaryDisplay}
        loading={busy || footer.primary.busy === true}
        disabled={props.added || footer.primary.disabledReason !== undefined}
        {...(footer.primary.disabledReason === undefined
          ? {}
          : { accessibilityHint: footer.primary.disabledReason })}
        onPress={() => {
          void press();
        }}
        testID={`${props.testID}:primary`}
      />
    );
  const note =
    error === null ? (
      (afterAdd?.start ?? footer?.provenance ?? null)
    ) : (
      <host.ErrorText testID={`${props.testID}:primary-error`}>
        {error}
      </host.ErrorText>
    );
  // Under the identity: the primary, then what it does beside it; a phone page gives each its own full-width line.
  const headAction =
    footer === undefined ? null : (
      <View
        // A step below the identity's last line, whichever header the details draw (lab `m:mcp`: 16 from the purpose).
        style={
          props.pushed
            ? [styles.stacked, { gap: space.s12, marginTop: space.s8 }]
            : [styles.row, { gap: space.s16, marginTop: space.s8 }]
        }
        testID={`${props.testID}:detail-action`}
      >
        <View style={props.pushed ? styles.stretch : null}>{primary}</View>
        {note === null ? null : (
          <View style={props.pushed ? null : styles.slot}>{note}</View>
        )}
      </View>
    );
  const ContainedPage = host.ContainedPage ?? PassThrough;
  return (
    <View
      style={styles.fill}
      testID={`${props.testID}:detail:${props.itemKey}`}
    >
      <ScrollView
        style={styles.fill}
        {...(props.detailScrollOffset ? {
          ref: scrollRef,
          onContentSizeChange: restoreScroll,
          onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => {
            if (props.detailScrollOffset) props.detailScrollOffset.current = event.nativeEvent.contentOffset.y;
          },
        } : {})}
        // The details' header carries its own top space; the title row then sits level with the close button.
        contentContainerStyle={[
          { paddingTop: space.s8, paddingBottom: space.s24, gap: space.s24 },
          edge,
        ]}
      >
        <ContainedPage>
          {/* The details pad their content by the body's edge: a public page header or section inside adds none. */}
          <HappierColumnEdgeContext.Provider value={edge.paddingHorizontal}>
            <DetailActionContext.Provider value={headAction}>
              {props.renderDetail(props.item, {
                pushed: props.pushed,
                added: props.added,
              })}
            </DetailActionContext.Provider>
          </HappierColumnEdgeContext.Provider>
        </ContainedPage>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  tools: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  // Grows from a short basis, so the search and its source share one row in the catalog's list column.
  search: { flexGrow: 1, flexBasis: 120, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  stacked: { flexDirection: 'column', alignItems: 'stretch' },
  stretch: { alignSelf: 'stretch' },
  slot: { flex: 1, minWidth: 0 },
  footerRule: { borderTopWidth: StyleSheet.hairlineWidth },
  listFooter: { borderTopWidth: StyleSheet.hairlineWidth },
});
