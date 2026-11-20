/**
 * Lab A2 (owner pick 2026-11-18, decisions in BOARD 19:50Z): the selected model's band says where it runs.
 * One serving source is a plain value with nothing to press; two are a two-part switch; three or more are a
 * field select whose menu also lists hidden, signed-out and needs-key sources. The count comes from the
 * grouping selector only. The star saves effort deliberately; a differing session Thinking shows one quiet
 * "Favorite N uses High · Update" note. "Running" lives in the header line only, never as a row mark.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

const { SessionModelPicker } = await import('./SessionModelPicker');
const { sessionModelSelectionKey } = await import('./sessionModelSelectionKey');
const { DropdownMenu } =
  await import('@/components/ui/forms/dropdown/DropdownMenu');
const { OptionPickerOverlay } = await import('@/components/sessions/pickers/OptionPickerOverlay');
const { SelectionList } = await import('@/components/ui/selectionList');

const AGENT = 'agent:happier.agent.claude/claude';
const SONNET = { vendor: 'anthropic', vendorModelId: 'claude-sonnet-5-5' };
const native = (modelId: string) => ({
  agentTargetKey: AGENT,
  providerConnectionId: null,
  modelId,
});
const apiKey = ProviderConnectionIdSchema.parse('pc_api_key');
const gateway = ProviderConnectionIdSchema.parse('pc_gateway');
const hidden = ProviderConnectionIdSchema.parse('pc_hidden');

function group(
  connectionId: typeof apiKey,
  providerName: string,
  connectionName: string,
  rows: readonly Readonly<{
    modelId: string;
    name: string;
    endpointHealth?: 'available' | 'unauthorized';
  }>[],
) {
  return {
    connectionId,
    providerName,
    connectionName,
    connectionRole: 'named' as const,
    connectionDisplayNameMode: 'custom' as const,
    connectionRevision: 1,
    authorization: { authorized: true as const },
    manualModelPolicy: 'catalog-only' as const,
    supportsFreeformModelIds: false,
    suppressedConnectedServiceIds: [],
    modelLoadAction: 'descriptor_absent' as const,
    rows: rows.map(({ modelId, name, endpointHealth }) => ({
      ref: {
        agentTargetKey: AGENT,
        providerConnectionId: connectionId,
        modelId,
      },
      descriptor: { id: modelId, name, upstreamRef: SONNET },
      sources: { manual: false, static: true, probe: false },
      confidence: 'verified_static' as const,
      compatibility: {
        result: {
          status: 'verified' as const,
          selectedProtocol: 'anthropic-messages' as const,
          evidence: {
            sourceUrls: ['https://example.test/docs'],
            verifiedAt: '2026-11-18',
          },
        },
        compatibilityFingerprint: `compatibility:v1:${connectionId}`,
        confirmed: true,
      },
      endpointHealth: endpointHealth ?? ('available' as const),
      catalog: { stale: false },
      loadState: 'unknown' as const,
      visibility: 'visible' as const,
    })),
  };
}

const thinking = (effectiveValue: string) => [
  {
    option: {
      id: 'reasoning_effort',
      name: 'Thinking',
      type: 'select' as const,
      currentValue: effectiveValue,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
    effectiveValue,
    isPending: false,
  },
];

type PickerProps = React.ComponentProps<typeof SessionModelPicker>;
function picker(overrides: Partial<PickerProps>) {
  return (
    <SessionModelPicker
      multiColumn
      agentTargetKey={AGENT}
      nativeSourceLabel="Claude subscription · Work pool"
      nativeModels={[
        { value: 'claude-opus-5-5', label: 'Opus 5.5' },
        {
          value: 'claude-sonnet-5-5',
          label: 'Sonnet 5.5',
          upstreamRef: SONNET,
        },
      ]}
      providerGroups={[]}
      providerProjectionAuthoritative
      selected={native('claude-sonnet-5-5')}
      selectedOptionControls={thinking('medium')}
      onSelectOptionControlValue={() => {}}
      onSelect={() => {}}
      {...overrides}
    />
  );
}

const ROW = 'model-picker-runs-through';
const texts = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
  screen
    .findAll((node) => typeof node.children?.[0] === 'string')
    .map((node) => node.children.join(''));

describe('SessionModelPicker Runs through', () => {
  it.each([
    { modifier: 'metaKey', withSearch: true },
    { modifier: 'ctrlKey', withSearch: false },
  ] as const)('picks the saved favorite and closes with $modifier plus a digit', async ({ modifier, withSearch }) => {
    const favorite = native('claude-opus-5-5');
    const select = vi.fn(async () => true);
    const close = vi.fn();
    const search = new EventTarget();
    const overrides = {
      ...(withSearch ? { nativeModels: [
        { value: favorite.modelId, label: 'Opus 5.5' },
        ...Array.from({ length: 10 }, (_, index) => ({ value: `model-${index}`, label: `Model ${index}` })),
      ] } : {}),
      favoriteReasoningEffortByKey: new Map([[sessionModelSelectionKey(favorite), 'high']]),
      onSelectFavoriteModel: select,
      onRequestClose: close,
    };
    const screen = await renderScreen(picker(overrides), {
      createNodeMock: (element) => element.props.testID === 'model-picker-overlay-search' ? search : null,
    });
    try {
      const list = screen.findHostByTestId('model-picker-overlay-selection-list');
      expect(screen.findHostByTestId('model-picker-overlay-search') !== null).toBe(withSearch);
      const press = async (key: string) => {
        const event = Object.assign(new Event('keydown', { cancelable: true }), { key, [modifier]: true });
        await act(async () => {
          if (withSearch) search.dispatchEvent(event);
          else list!.props.onKeyDown(event);
        });
        return event.defaultPrevented;
      };
      expect(await press('ArrowDown')).toBe(true);
      expect(await press('9')).toBe(false);
      expect(select).not.toHaveBeenCalled();

      await press('1');
      expect(select).toHaveBeenCalledExactlyOnceWith(favorite, 'high');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it('names one source as a plain value with its usage: no button, no menu (owner 11-18 decision 4)', async () => {
    const screen = await renderScreen(
      picker({ selected: native('claude-opus-5-5') }),
    );
    try {
      expect(screen.findByTestId(`${ROW}:value`)).not.toBeNull();
      expect(texts(screen)).toContain('Claude subscription · Work pool');
      expect(screen.findByTestId(`${ROW}:switch`)).toBeNull();
      // Nothing to press or tab to: one source is a value, not a choice.
      expect(screen.findByTestId(`${ROW}:sources`)).toBeNull();
      expect(screen.findByTestId(`${ROW}:value-press`)).toBeNull();
      expect(screen.root.findAll((node) => node.type === DropdownMenu
        && String(node.props.items?.[0]?.testID ?? '').startsWith(`${ROW}:menu`))).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("titles each favourite with its saved Thinking, and names a closed favourite's source on its description line only", async () => {
    const gatewaySonnet = { agentTargetKey: AGENT, providerConnectionId: gateway, modelId: 'claude-sonnet-5-5' };
    const screen = await renderScreen(
      picker({
        selected: native('claude-opus-5-5'),
        providerGroups: [group(gateway, 'OpenRouter', 'Work', [{ modelId: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }])],
        favoriteEntries: [
          { ref: native('claude-opus-5-5'), reasoningEffort: 'high' },
          { ref: gatewaySonnet, reasoningEffort: 'medium' },
        ],
        favoriteKeys: new Set([sessionModelSelectionKey(native('claude-opus-5-5')), sessionModelSelectionKey(gatewaySonnet)]),
        onToggleFavorite: () => {},
      }),
    );
    try {
      const overlay = screen.root.findAll((node) => node.type === OptionPickerOverlay)[0]!;
      const favorites = overlay.props.sections.find((section: { id: string }) => section.id === 'favorites');
      const row = (ref: object) => favorites.options.find((option: { value: object }) => (
        sessionModelSelectionKey(option.value as never) === sessionModelSelectionKey(ref as never)));
      expect(row(native('claude-opus-5-5'))).toMatchObject({ label: 'Opus 5.5', labelSuffix: 'High' });
      const closed = row(gatewaySonnet);
      expect(closed).toMatchObject({ label: 'Sonnet 5.5', labelSuffix: 'Medium' });
      expect(String(closed.description)).toMatch(/^via OpenRouter/);
    } finally {
      await screen.unmount();
    }
  });

  it('drops the chosen tile\'s "via" source: Runs through already says it', async () => {
    const gatewaySonnet = { agentTargetKey: AGENT, providerConnectionId: gateway, modelId: 'claude-sonnet-5-5' };
    const screen = await renderScreen(
      picker({
        selected: gatewaySonnet,
        providerGroups: [group(gateway, 'OpenRouter', 'Work', [{ modelId: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }])],
        favoriteEntries: [{ ref: gatewaySonnet, reasoningEffort: 'high' }],
        favoriteKeys: new Set([sessionModelSelectionKey(gatewaySonnet)]),
        onToggleFavorite: () => {},
      }),
    );
    try {
      const overlay = screen.root.findAll((node) => node.type === OptionPickerOverlay)[0]!;
      const chosen = overlay.props.sections.find((section: { id: string }) => section.id === 'favorites').options[0];
      expect(chosen.labelSuffix).toBe('High');
      expect(String(chosen.description ?? '')).not.toMatch(/via/);
    } finally {
      await screen.unmount();
    }
  });

  it('shows the keys-only footer, naming ⌘1–9 only when favourites are bound to digits', async () => {
    const favorite = native('claude-opus-5-5');
    const footerIds = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root
      .findAll((node) => node.type === SelectionList)[0]!.props.rootStep.footerHints?.map((hint: { id: string }) => hint.id);
    const bound = await renderScreen(picker({
      favoriteEntries: [{ ref: favorite, reasoningEffort: 'high' }],
      favoriteKeys: new Set([sessionModelSelectionKey(favorite)]),
      onToggleFavorite: () => {},
      onSelectFavoriteModel: vi.fn(async () => true),
      onRequestClose: () => {},
    }));
    try {
      expect(footerIds(bound)).toEqual(['move', 'choose', 'favorite', 'close']);
    } finally {
      await bound.unmount();
    }
    const unbound = await renderScreen(picker({}));
    try {
      expect(footerIds(unbound)).toEqual(['move', 'choose', 'close']);
    } finally {
      await unbound.unmount();
    }
  });

  it("offers two serving sources as a two-part switch that picks the other source's exact model", async () => {
    const onSelect = vi.fn();
    const screen = await renderScreen(
      picker({
        onSelect,
        providerGroups: [
          group(apiKey, 'Anthropic API key', 'Personal', [
            { modelId: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
          ]),
        ],
      }),
    );
    try {
      expect(screen.findByTestId(`${ROW}:switch`)).not.toBeNull();
      const other = screen.findAll(
        (node) =>
          typeof node.props?.testID === 'string' &&
          node.props.testID.startsWith(`${ROW}:switch:`) &&
          typeof node.props.onPress === 'function' &&
          node.props.accessibilityState?.checked === false,
      )[0];
      act(() => {
        other!.props.onPress();
      });
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          providerConnectionId: apiKey,
          modelId: 'claude-sonnet-5-5',
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it('turns three or more serving sources into a select whose menu also lists hidden and needs-key sources', async () => {
    const onSelect = vi.fn();
    const screen = await renderScreen(
      picker({
        onSelect,
        providerGroups: [
          group(apiKey, 'Anthropic API key', 'Personal', [
            { modelId: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
          ]),
          group(gateway, 'OpenRouter', 'Work', [
            {
              modelId: 'anthropic/claude-sonnet-5.5',
              name: 'Sonnet 5.5',
              endpointHealth: 'unauthorized',
            },
          ]),
        ],
        hiddenSources: [
          {
            connectionId: hidden,
            providerName: 'Vercel AI Gateway',
            connectionName: 'Team',
            connectionRole: 'named',
            connectionDisplayNameMode: 'custom',
            modelCount: 1,
            upstreamModels: [
              { upstreamRef: SONNET, endpointHealth: 'available' },
            ],
          },
        ],
        sourceBrowse: { machineId: null, serverId: null },
      }),
    );
    try {
      expect(screen.findByTestId(`${ROW}:switch`)).toBeNull();
      const menu = screen.root.findAll(
        (node) =>
          node.type === DropdownMenu &&
          String(node.props.items?.[0]?.testID ?? '').startsWith(
            `${ROW}:menu`,
          ),
      )[0]!;
      // Every serving source, then the one that needs a key; their states come from the Runs-through
      // content model (SessionModelRunsThrough.test.tsx), which this harness has no connections for.
      expect(menu.props.items).toHaveLength(4);
      const api = menu.props.items.find((item: { title: string }) =>
        item.title.includes('Anthropic API key'),
      );
      act(() => {
        menu.props.onSelect(api.id);
      });
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ providerConnectionId: apiKey }),
      );
    } finally {
      await screen.unmount();
    }
  });
});

describe('SessionModelPicker favourite Thinking', () => {
  it('says once when the session Thinking differs from the favourite and re-saves it on Update', async () => {
    const onUpdate = vi.fn();
    const sonnet = native('claude-sonnet-5-5');
    const key = sessionModelSelectionKey(sonnet);
    const screen = await renderScreen(
      picker({
        favoriteKeys: new Set([key]),
        favoriteReasoningEffortByKey: new Map([[key, 'high']]),
        onToggleFavorite: () => {},
        onUpdateFavoriteModelReasoningEffort: onUpdate,
      }),
    );
    try {
      expect(texts(screen)).toContain('Favorite 1 uses High');
      const update = screen.findByTestId('model-picker-favorite-effort-update');
      act(() => {
        update!.props.onPress();
      });
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'claude-sonnet-5-5' }),
        'medium',
      );
    } finally {
      await screen.unmount();
    }
  });

  it('stays quiet when the favourite already uses the session Thinking', async () => {
    const sonnet = native('claude-sonnet-5-5');
    const key = sessionModelSelectionKey(sonnet);
    const screen = await renderScreen(
      picker({
        favoriteKeys: new Set([key]),
        favoriteReasoningEffortByKey: new Map([[key, 'medium']]),
        onToggleFavorite: () => {},
        onUpdateFavoriteModelReasoningEffort: () => {},
      }),
    );
    try {
      expect(
        screen.findByTestId('model-picker-favorite-effort-update'),
      ).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});

describe('SessionModelPicker running line', () => {
  it('names the running and the next model in the header, with no running mark on a row', async () => {
    const screen = await renderScreen(
      picker({
        reportedModel: { ref: native('claude-opus-5-5'), status: 'running' },
      }),
    );
    try {
      expect(texts(screen)).toContain(
        'Running: Opus 5.5. Next message: Sonnet 5.5',
      );
      expect(
        screen.findAll(
          (node) =>
            typeof node.props?.testID === 'string' &&
            node.props.testID.startsWith(
              'model-picker-overlay-option-status-icon:',
            ),
        ),
      ).toEqual([]);
    } finally {
      await screen.unmount();
    }
  });
});
