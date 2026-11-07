import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
// Load the real UI graph during collection, outside each test's behavior deadline.
import { CapabilityAddDetailAction, CapabilityAddModalBody } from './CapabilityAddModal';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Keep responsive classification real; only React Native's window measurements are a boundary.
const viewport = vi.hoisted(() => ({ width: 1200, height: 800 }));
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  const dimensions = () => ({ ...viewport, scale: 1, fontScale: 1 });
  return createReactNativeWebMock({
    Dimensions: { get: dimensions },
    useWindowDimensions: dimensions,
  });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(() => {
  standardCleanup();
  viewport.width = 1200;
  viewport.height = 800;
});

type Skill = Readonly<{ name: string; description: string }>;
const SKILLS: readonly Skill[] = [
  { name: 'docx', description: 'Create and edit Word documents.' },
  { name: 'pdf', description: 'Read, fill and merge PDF files.' },
];

async function renderBody(
  primary: (
    skill: Skill,
  ) => Promise<Readonly<{ itemId: string; then?: 'close' | 'stay' }>>,
  catalogOverrides: Readonly<Record<string, unknown>> = {},
  footerOverrides: Readonly<Record<string, unknown>> = {},
  configOverrides: Readonly<Record<string, unknown>> = {},
) {
  const onClose = vi.fn();
  const onAdded = vi.fn();
  const setChrome = vi.fn();
  const config = {
    title: 'Add a skill',
    modes: [
      {
        key: 'browse',
        label: 'Browse',
        icon: 'magnifying-glass' as const,
        kind: 'catalog' as const,
      },
    ],
    catalog: {
      query: '',
      onQueryChange: () => {},
      searchPlaceholder: 'Search skills',
      items: SKILLS,
      itemKey: (skill: Skill) => skill.name,
      anatomy: buildCapabilityCollectionAnatomy<Skill>({
        title: (skill) => skill.name,
        description: (skill) => skill.description,
        facts: () => ({}),
        accessibilityLabel: (skill) => skill.name,
        testID: (skill) => `row:${skill.name}`,
      }),
      loading: false,
      empty: null,
      ...catalogOverrides,
    },
    renderDetail: (skill: Skill) => (
      <React.Fragment>{skill.description}<CapabilityAddDetailAction /></React.Fragment>
    ),
    detailFooter: (skill: Skill) => ({
      primary: { label: 'Add to library', onPress: () => primary(skill) },
      ...footerOverrides,
    }),
    onAdded,
    testID: 'add',
    ...configOverrides,
  };
  const screen = await renderScreen(
    <CapabilityAddModalBody config={config as never} onClose={onClose} setChrome={setChrome} />,
  );
  const nodes = (testID: string) =>
    screen.findAll((node) => node.props?.testID === testID);
  const pressable = (testID: string) =>
    screen.findAll(
      (node) =>
        node.props?.testID === testID &&
        typeof node.props?.onPress === 'function',
    )[0];
  /** Choose a row as its press does: through the Collection model's own open action. */
  const select = async (name: string) => {
    const collection = screen.findAll(
      (node) => node.props?.testID === 'add:collection' && typeof node.props?.model?.actions?.open === 'function',
    )[0];
    if (!collection) throw new Error('collection not rendered');
    await act(async () => {
      collection.props.model.actions.open(name);
    });
  };
  const pressPrimary = async () => {
    const button = pressable('add:primary');
    if (!button) throw new Error('primary is not pressable');
    await act(async () => {
      await button.props.onPress();
    });
  };
  const press = async (testID: string) => {
    const button = pressable(testID);
    if (!button) throw new Error(`${testID} is not pressable`);
    await act(async () => {
      await button.props.onPress();
    });
  };
  const header = () => screen.findAll(node => node.props.testID === 'modal-card-header'
    && Object.hasOwn(node.props, 'title'))[0]!.props;
  const updateItems = (items: readonly Skill[], query = '') => screen.update(
    <CapabilityAddModalBody config={{ ...config, catalog: { ...config.catalog, items, query } } as never}
      onClose={onClose} setChrome={setChrome} />,
  );
  return { screen, nodes, select, pressPrimary, press, onClose, onAdded, header, updateItems };
}

describe('CapabilityAddModalBody', () => {
  it('publishes Catalog demand only while its mode is presented outside source management', async () => {
    const { Pressable } = await import('react-native');
    const demand = vi.fn();
    const body = await renderBody(async skill => ({ itemId: skill.name }), {}, {}, {
      onCatalogDemandChange: demand,
      modes: [
        { key: 'browse', label: 'Browse', icon: 'magnifying-glass', kind: 'catalog' },
        { key: 'write', label: 'Write', icon: 'pencil', kind: 'input', renderBody: () => null },
      ],
      sources: {
        renderSelect: ({ openRegistries }: { openRegistries: (intent: 'manage') => void }) =>
          <Pressable testID="demand:manage" onPress={() => openRegistries('manage')} />,
        renderRegistriesView: ({ back }: { back: () => void }) => <Pressable testID="demand:back" onPress={back} />,
        registriesHeader: { title: 'Registries' },
      },
    });
    expect(demand.mock.calls).toEqual([[true]]);
    await body.press('add:mode:browse');
    expect(demand.mock.calls).toEqual([[true]]);
    await body.press('demand:manage');
    expect(demand.mock.calls).toEqual([[true], [false]]);
    await body.press('demand:back');
    await body.press('add:mode:write');
    expect(demand.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it('lands on the first displayed group without installing and keeps implicit detail out of a stacked view', async () => {
    const primary = vi.fn(async (skill: Skill) => ({ itemId: skill.name }));
    const body = await renderBody(primary, {
      groups: [{ key: 'recommended', title: 'Recommended', itemKeys: ['pdf'] },
        { key: 'other', title: 'Other', itemKeys: ['docx'] }],
    });
    const measure = async (width: number) => {
      const stage = body.screen.findAll(node => node.props.testID === 'add:collection:stage'
        && typeof node.props.onLayout === 'function')[0]!;
      await act(async () => stage.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 600 } } }));
    };
    await measure(1080);
    expect(body.nodes('add:detail:pdf').length).toBeGreaterThan(0);
    expect(body.nodes('add:detail:docx')).toHaveLength(0);
    expect(primary).not.toHaveBeenCalled();
    await measure(390);
    expect(body.nodes('add:detail:pdf')).toHaveLength(0);
    await body.select('pdf');
    expect(body.nodes('add:detail:pdf').length).toBeGreaterThan(0);
    await measure(1080);
    expect(body.nodes('add:detail:pdf').length).toBeGreaterThan(0);
  });

  it('keeps a late primary acknowledgement on its item instead of closing a newly selected preview', async () => {
    let complete: ((result: { itemId: string }) => void) | undefined;
    const body = await renderBody(() => new Promise(resolve => { complete = resolve; }));
    await body.select('docx');
    await body.pressPrimary();
    await body.select('pdf');
    await act(async () => { complete?.({ itemId: 'created-docx' }); });
    expect(body.nodes('add:detail:pdf').length).toBeGreaterThan(0);
    expect(body.onClose).not.toHaveBeenCalled();
    expect(body.onAdded).not.toHaveBeenCalled();
  });

  it.each(['fallback', 'empty'] as const)('completes Add when refresh withdraws its selected result (%s)', async (remaining) => {
    let complete: ((result: { itemId: string }) => void) | undefined;
    const body = await renderBody(() => new Promise(resolve => { complete = resolve; }));
    await body.select('docx');
    await body.pressPrimary();
    // Successful Add can remove a Found row before the operation's response settles.
    await body.updateItems(remaining === 'fallback' ? SKILLS.slice(1) : []);
    expect(body.nodes('add:detail:docx')).toHaveLength(0);
    await act(async () => { complete?.({ itemId: 'created-docx' }); });
    expect(body.onClose).toHaveBeenCalledTimes(1);
    expect(body.onAdded).toHaveBeenCalledWith({ itemId: 'created-docx' });
  });

  it('keeps a new search open when the previous result finishes adding', async () => {
    let complete: ((result: { itemId: string }) => void) | undefined;
    const body = await renderBody(() => new Promise(resolve => { complete = resolve; }));
    await body.select('docx');
    await body.pressPrimary();
    await body.updateItems(SKILLS.slice(1), 'pdf');
    await act(async () => { complete?.({ itemId: 'created-docx' }); });
    expect(body.onClose).not.toHaveBeenCalled();
    expect(body.onAdded).not.toHaveBeenCalled();
  });

  it('loads the next catalog page explicitly without running a listing action or losing the selected item', async () => {
    const loadMore = vi.fn(async () => {});
    const primary = vi.fn(async (skill: Skill) => ({ itemId: skill.name }));
    const body = await renderBody(primary, { loadMore: { label: 'More', loading: false, onPress: loadMore } });
    await body.select('pdf');
    expect(loadMore).not.toHaveBeenCalled();
    await body.press('add:load-more');
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(body.nodes('add:detail:pdf').length).toBeGreaterThan(0);
    expect(primary).not.toHaveBeenCalled();
  });

  it('opens the details for the selected row, adds, then closes onto the new item', async () => {
    const body = await renderBody(async (skill) => ({
      itemId: `skill-${skill.name}`,
    }));
    await body.select('docx');
    expect(body.nodes('add:detail:docx').length).toBeGreaterThan(0);
    await body.pressPrimary();
    expect(body.onClose).toHaveBeenCalledTimes(1);
    expect(body.onAdded).toHaveBeenCalledWith({ itemId: 'skill-docx' });
  });

  it('keeps the dialog open on the added item when the primary asks to stay', async () => {
    const body = await renderBody(async (skill) => ({
      itemId: `skill-${skill.name}`,
      then: 'stay',
    }));
    await body.select('pdf');
    await body.pressPrimary();
    expect(body.onClose).not.toHaveBeenCalled();
    expect(body.onAdded).not.toHaveBeenCalled();
    expect(body.nodes('add:detail:pdf').length).toBeGreaterThan(0);
  });

  it('after a stay add, the footer offers the added item and Done, and Done closes the dialog', async () => {
    const openAdded = vi.fn();
    const body = await renderBody(
      async (skill) => ({ itemId: `skill-${skill.name}`, then: 'stay' }),
      {},
      { afterAdd: { open: { label: 'Open pdf', onPress: openAdded } } },
    );
    await body.select('pdf');
    expect(body.nodes('add:done')).toHaveLength(0);
    await body.pressPrimary();
    expect(body.nodes('add:primary')).toHaveLength(0);
    await body.press('add:open-added');
    expect(openAdded).toHaveBeenCalledTimes(1);
    expect(body.onClose).toHaveBeenCalledTimes(1);
    await body.press('add:done');
    expect(body.onClose).toHaveBeenCalledTimes(2);
    expect(body.onAdded).not.toHaveBeenCalled();
  });

  it('pins the list footer while no details are open', async () => {
    const body = await renderBody(async () => ({ itemId: 'x' }), { footer: 'The registry checks each entry.' });
    expect(body.nodes('add:list-footer').length).toBeGreaterThan(0);
    await body.select('docx');
    expect(body.nodes('add:list-footer')).toHaveLength(0);
  });

  it('shows a failed add on the footer line and keeps the details', async () => {
    const body = await renderBody(async () => {
      throw new Error('registry_unreachable');
    });
    await body.select('docx');
    await body.pressPrimary();
    expect(body.nodes('add:primary-error').length).toBeGreaterThan(0);
    expect(body.onClose).not.toHaveBeenCalled();
    expect(body.nodes('add:detail:docx').length).toBeGreaterThan(0);
  });

  it('keeps a failed registry as one line with its own Retry while the other rows stay', async () => {
    const onRetry = vi.fn();
    const { screen } = await renderBody(async () => ({ itemId: 'x' }), {
      sourceFailures: [{ sourceId: 'acme', message: 'Acme · Limited until 14:05', onRetry }],
    });
    // The state card that draws the line (the Add body's source-failure slot renders it).
    const line = screen.findAll((node) => node.props?.testID === 'add:sourceFailure:acme' && node.props.action !== undefined)[0];
    expect(line?.props.title).toBe('Acme · Limited until 14:05');
    await act(async () => { await line!.props.action.onPress(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the failure itself, not "no results", when every registry failed', async () => {
    const { screen } = await renderBody(async () => ({ itemId: 'x' }), {
      items: [],
      empty: <React.Fragment>No skills match</React.Fragment>,
      sourceFailures: [{ sourceId: 'acme', message: 'Acme · Token rejected', onRetry: () => {} }],
    });
    const collection = screen.findAll((node) => node.props?.testID === 'add:collection' && 'empty' in (node.props ?? {}))[0];
    expect(JSON.stringify(collection?.props.empty?.props?.children?.[0]?.props?.title)).toBe('"Acme · Token rejected"');
    expect(screen.findAll((node) => node.props?.testID === 'add:sourceFailure:acme')).not.toHaveLength(0);
  });

  it('takes the Registries header back off when the person returns from Registries', async () => {
    const { Pressable } = await import('react-native');
    const sources = {
      renderSelect: ({ openRegistries }: { openRegistries: (intent: 'manage' | 'add') => void }) => (
        <Pressable testID="open-registries" onPress={() => openRegistries('manage')} />
      ),
      renderRegistriesView: ({ back }: { back: () => void }) => <Pressable testID="registries-back" onPress={back} />,
      registriesHeader: { title: 'Registries', subtitle: 'Where Browse looks for skills.' },
    };
    const { press, header } = await renderBody(async () => ({ itemId: 'x' }), {}, {}, { sources });
    await press('open-registries');
    expect(header()).toMatchObject({ title: 'Registries', subtitle: 'Where Browse looks for skills.' });
    await press('registries-back');
    expect(header()).toMatchObject({ title: 'Add a skill', leading: null });
    expect(header().subtitle).toBeUndefined();
  });

  it('on a phone, open details put only the way back in the header, without the dialog subtitle beside it', async () => {
    viewport.width = 390;
    viewport.height = 844;
    const body = await renderBody(async (skill) => ({ itemId: skill.name }), {}, {}, { subtitle: 'From a registry, a link or your own files.' });
    expect(body.header()).toMatchObject({ title: 'Add a skill', subtitle: 'From a registry, a link or your own files.' });
    await body.select('docx');
    const chrome = body.header();
    expect(chrome.title).toBeNull();
    expect(chrome.subtitle).toBeNull();
    expect(chrome.leading).not.toBeNull();
  });

  it('lets Escape return a phone detail to its list, whatever has focus', async () => {
    viewport.width = 390;
    const { dispatchEscapeToLayerStack } = await import('@/keyboard/escape');
    const body = await renderBody(async (skill) => ({ itemId: skill.name }));
    await body.select('docx');
    expect(body.nodes('add:detail:docx').length).toBeGreaterThan(0);
    let handled = false;
    await act(async () => {
      handled = dispatchEscapeToLayerStack({
        key: 'Escape',
        target: null,
        preventDefault: () => {},
        stopPropagation: () => {},
      });
    });
    expect(handled).toBe(true);
    expect(body.nodes('add:detail:docx')).toHaveLength(0);
    expect(body.onClose).not.toHaveBeenCalled();
  });
});
