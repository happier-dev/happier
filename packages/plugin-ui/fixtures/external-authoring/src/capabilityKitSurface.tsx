import { useState } from 'react';
import {
  CapabilityAddBody,
  CapabilityAddDetailAction,
  CapabilityBlockingBanner,
  CapabilityDetailHeader,
  CapabilityFacts,
  CapabilityStatusChip,
  CapabilityListingSections,
  Collection,
  Button,
  PageHeader,
  WhereItsOnControl,
  capabilityCollectionAnatomy,
  pickMostBlockingCapabilityStatus,
  useHappierCollection,
  type CapabilityAddConfig,
  type CapabilityStatus,
  type WhereItsOnIntent,
  type WhereItsOnRule,
} from '@happier-dev/plugin-ui/components';

type Extension = Readonly<{
  id: string;
  name: string;
  purpose: string;
  scope: string;
  toolCount: number;
  statuses: readonly CapabilityStatus[];
}>;

/**
 * A plugin that manages installable extensions renders them with Happier's capability kit: the list anatomy,
 * one extension's header, its blocking notice, and its facts. The author owns the data and the fixes.
 */
export function CapabilityKitExample(
  props: Readonly<{ onSignIn?: (id: string) => void; onWhere?: (intent: WhereItsOnIntent) => void }>,
) {
  const [signedIn, setSignedIn] = useState<readonly string[]>([]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  // The plugin owns its rules; the control says the person's choice and the plugin applies it.
  const [everywhere, setEverywhere] = useState<'on' | 'off'>('on');
  const [rules, setRules] = useState<readonly WhereItsOnRule[]>([{ place: { t: 'allMachines' }, agentId: 'gemini', on: false }]);
  const applyWhere = (intent: WhereItsOnIntent) => {
    props.onWhere?.(intent);
    if (intent.kind === 'everywhere') setEverywhere(intent.state);
    else if (intent.kind === 'add' && intent.place.t !== 'workspace') {
      const place = intent.place;
      setRules((current) => [...current, { place, ...(intent.agentId ? { agentId: intent.agentId } : {}), on: intent.state === 'on' }]);
    } else if (intent.kind === 'remove')
      setRules((current) => current.filter((rule) => !(rule.agentId === intent.agentId && JSON.stringify(rule.place) === JSON.stringify(intent.place))));
  };
  const signIn = (id: string) => {
    props.onSignIn?.(id);
    setSignedIn((current) => [...current, id]);
  };
  const extensions: readonly Extension[] = [
    {
      id: 'linear',
      name: 'Linear',
      purpose: 'Read and update the issues your team works on.',
      scope: 'Everywhere',
      toolCount: 12,
      statuses: signedIn.includes('linear')
        ? []
        : [
            { kind: 'update' },
            {
              kind: 'signin',
              fix: { kind: 'sign_in', onPress: () => signIn('linear') },
            },
          ],
    },
    {
      id: 'figma',
      name: 'Figma',
      purpose: 'Read frames and comments from shared files.',
      scope: '2 projects',
      toolCount: 8,
      statuses: [],
    },
  ];
  const model = useHappierCollection({ items: extensions, keyOf: (item) => item.id, openKey, onOpenChange: setOpenKey });
  const status = (item: Extension) =>
    pickMostBlockingCapabilityStatus(item.statuses);
  const linear = extensions[0]!;
  const linearStatus = pickMostBlockingCapabilityStatus(
    linear.statuses,
    'header',
  );
  return (
    <>
      <CapabilityDetailHeader
        testID="author-capability.header"
        title={linear.name}
        purpose={linear.purpose}
        facts={{
          source: { kind: 'registry', label: 'Extension registry' },
          trust: 'runs_scripts',
          cost: { toolCount: 12, tokensPerTurn: 2400 },
        }}
        status={linearStatus}
        mono="ext/linear"
      />
      {linearStatus ? (
        <CapabilityBlockingBanner
          testID="author-capability.banner"
          status={linearStatus}
          title="Linear is signed out"
          body="Sessions can’t use its tools until you sign in."
        />
      ) : null}
      <CapabilityStatusChip
        testID="author-capability.chip"
        status={{
          kind: 'error',
          machineName: 'build-box',
          detail: 'node is missing',
        }}
        placement="header"
      />
      <CapabilityFacts
        testID="author-capability.facts"
        source={{ kind: 'you' }}
        trust="text_only"
        cost={{ tokensWhenUsed: 1200 }}
      />
      <WhereItsOnControl
        testID="author-capability.where"
        kind="mcp_server"
        everywhere={everywhere}
        rules={rules}
        places={{
          agents: [{ id: 'claude', name: 'Claude' }, { id: 'gemini', name: 'Gemini' }],
          machines: [{ id: 'build-box', name: 'build-box', online: true }],
        }}
        availability={[{ machineId: 'build-box', agents: [{ agentId: 'claude', enabled: true }] }]}
        onIntent={applyWhere}
      />
      <Collection
      model={model}
      accessibilityLabel="Extensions"
      presentation="list"
      detail="auto"
      headerPlacement="list"
      header={<PageHeader title="Extensions" />}
      renderDetail={(key) => {
        const item = extensions.find((candidate) => candidate.id === key);
        return item ? <CapabilityDetailHeader title={item.name} purpose={item.purpose}
          facts={{ source: { kind: 'registry', label: 'Extension registry' }, trust: 'has_files' }}
          testID={`author-capability.detail.${item.id}`} /> : null;
      }}
      minListWidth={240}
      minDetailWidth={240}
      preferredListRatio={0.5}
      anatomy={capabilityCollectionAnatomy<Extension>({
        title: (item) => item.name,
        description: (item) => item.purpose,
        whereSummary: (item) => item.scope,
        count: (item) => item.toolCount,
        facts: () => ({ source: { kind: 'registry', label: 'Extension registry' }, trust: 'has_files' }),
        status,
        accessibilityLabel: (item) => item.name,
        testID: (item) => `author-capability.row.${item.id}`,
      })}
    />
    </>
  );
}

type Listing = Readonly<{ id: string; name: string; summary: string }>;

/**
 * The same plugin adds extensions from its own page: the shared Add body (tabs, the catalog list with details beside
 * it, the install action). The page around it and its header are the plugin's.
 */
export function CapabilityAddExample(
  props: Readonly<{
    onInstall?: (id: string) => void;
    onClose?: () => void;
    /** The caller can publish its asynchronously loaded rows without remounting the body. */
    listings?: readonly Listing[];
    loading?: boolean;
    initialItemKey?: string;
    loadMore?: CapabilityAddConfig<Listing>['catalog']['loadMore'];
  }>,
) {
  const [query, setQuery] = useState('');
  const [catalogDemanded, setCatalogDemanded] = useState(true);
  const listings: readonly Listing[] = props.listings ?? [
    { id: 'linear', name: 'Linear', summary: 'Issues and projects.' },
    { id: 'figma', name: 'Figma', summary: 'Frames and comments.' },
  ];
  const shown = listings.filter((listing) => listing.name.toLowerCase().includes(query.toLowerCase()));
  const config: CapabilityAddConfig<Listing> = {
    title: 'Add an extension',
    onCatalogDemandChange: setCatalogDemanded,
    ...(props.initialItemKey === undefined ? {} : { initialItemKey: props.initialItemKey }),
    modes: [{ key: 'browse', label: 'Browse', icon: 'search', kind: 'catalog' },
      { key: 'input', label: 'Your own', icon: 'file', kind: 'input', renderBody: ctx => <>{ctx.tools()}</> }],
    catalog: {
      query,
      onQueryChange: setQuery,
      searchPlaceholder: 'Search extensions',
      items: shown,
      itemKey: (item) => item.id,
      anatomy: capabilityCollectionAnatomy<Listing>({
        title: (item) => item.name,
        description: (item) => item.summary,
        facts: () => ({ source: { kind: 'registry', label: 'Extension registry' }, trust: 'text_only' }),
        accessibilityLabel: (item) => item.name,
        testID: (item) => `author-add.row.${item.id}`,
      }),
      loading: catalogDemanded && (props.loading ?? false),
      ...(props.loadMore === undefined ? {} : { loadMore: props.loadMore }),
      empty: ({ selectMode }) => <Button title="Add your own" onPress={() => selectMode('input')} />,
    },
    renderDetail: (item) => <>
      <CapabilityDetailHeader title={item.name} purpose={item.summary}
        facts={{ source: { kind: 'you' }, trust: 'text_only' }}
        testID={`author-add.detail.${item.id}`} />
      <CapabilityAddDetailAction />
      <CapabilityListingSections testID={`author-add.listing.${item.id}`}
        facts={{ version: '1.4.0', sourceTitle: 'Extension registry', license: 'MIT',
          links: { repository: 'https://github.com/acme/linear-extension.git' } }} />
    </>,
    detailFooter: (item) => ({
      primary: {
        label: 'Install',
        onPress: async () => {
          props.onInstall?.(item.id);
          return { itemId: item.id, then: 'stay' };
        },
      },
      afterAdd: {},
    }),
    testID: 'author-add',
  };
  return <CapabilityAddBody config={config} onClose={() => props.onClose?.()}
    renderLayout={({ modes, level, body }) => <>
      <PageHeader title={level.kind === 'registries' ? level.header.title : 'Add an extension'}
        actions={level.kind === 'root' ? modes : <Button title="Back" variant="secondary" onPress={level.back} />} />
      {body}
    </>} />;
}
