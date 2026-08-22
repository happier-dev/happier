import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const localSettingState = vi.hoisted(() => ({
  values: {
    uiBackdropBlurEnabled: 1,
    keyboardShortcutsV2Enabled: true,
    keyboardSingleKeyShortcutsEnabled: true,
    keyboardShortcutOverridesV1: {},
    keyboardShortcutDisabledCommandIdsV1: [] as readonly string[],
  },
}));

installAgentInputCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
      Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
      Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
      ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ScrollView', props, props.children),
      ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props, null),
      Platform: {
        OS: 'web',
        select: (v: any) => v.web ?? v.default ?? null,
      },
      useWindowDimensions: () => ({ width: 900, height: 600 }),
      Dimensions: {
        get: () => ({ width: 900, height: 600, scale: 1, fontScale: 1 }),
      },
    });
  },
  icons: () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
    Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
  }),
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
  },
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      useSetting: (key: string) => {
        if (key in localSettingState.values) {
          return localSettingState.values[key as keyof typeof localSettingState.values];
        }
        if (key === 'profiles') return [];
        if (key === 'agentInputEnterToSend') return true;
        if (key === 'agentInputActionBarLayout') return 'wrap';
        if (key === 'agentInputChipDensity') return 'labels';
        if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
        if (key === 'agentInputHistoryScope') return 'perSession';
        return null;
      },
      useSettings: () => ({
        profiles: [],
        keyboardShortcutsV2Enabled: true,
        keyboardSingleKeyShortcutsEnabled: true,
        keyboardShortcutOverridesV1: {},
        keyboardShortcutDisabledCommandIdsV1: [],
        agentInputEnterToSend: true,
        agentInputActionBarLayout: 'wrap',
        agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate',
        agentInputHistoryScope: 'perSession',
      }),
      useSessionMessages: () => ({ messages: [], isLoaded: true }),
      useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
      useSessionMessagesById: () => ({}),
      useSessionMessagesVersion: () => 0,
      useSessionMessagesReducerState: () => null,
    });
  },
});

vi.mock('@/sync/store/hooks', () => ({
  useLocalSetting: (key: keyof typeof localSettingState.values) => localSettingState.values[key] ?? 1,
}));

vi.mock('expo-image', () => ({
  Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
  PermissionFooter: () => null,
}));

vi.mock('@/utils/system/userInteractionDiagnostics', () => ({
  recordLargeTextInputDiagnostic: () => {},
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
  useUserMessageHistory: () => ({
    moveUp: () => false,
    moveDown: () => false,
    reset: () => {},
    warmup: () => {},
    isBrowsing: () => false,
    hasRetainedSession: () => false,
    pause: () => {},
  }),
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
  applySuggestion: (text: string) => ({ text, cursorPosition: text.length }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
  getAgentIconSvgXml: () => null,
  getAgentIconSource: () => null,
  getAgentIconTintColor: () => undefined,
  AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
  DEFAULT_AGENT_ID: 'codex',
  resolveAgentIdFromFlavor: () => null,
  getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
  findModelOptionForEffectiveModelId: () => null,
  getModelOptionsForSession: () => [{ value: 'default', label: 'Default' }],
  supportsFreeformModelSelectionForSession: () => false,
}));

vi.mock('@/sync/domains/models/describeEffectiveModelMode', () => ({
  describeEffectiveModelMode: () => ({ selectedModelId: 'default', appliedModelId: null, effectiveModelId: 'default' }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
  getPermissionModeBadgeLabelForAgentType: () => 'Default',
  getPermissionModeLabelForAgentType: () => 'Default',
  getPermissionModeOptionsForSession: () => [{ value: 'default', label: 'Default' }],
  getPermissionModeTitleForAgentType: () => 'Permissions',
}));

vi.mock('@/sync/domains/permissions/describeEffectivePermissionMode', () => ({
  describeEffectivePermissionMode: () => ({ effectiveMode: 'default', notes: [] }),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => {
  const MultiTextInput = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({
      setTextAndSelection: () => {},
      setSelection: () => {},
      getText: () => (typeof props.value === 'string' ? props.value : ''),
      flushPendingTextChange: () => (typeof props.value === 'string' ? props.value : ''),
      focus: () => {},
      blur: () => {},
    }));
    return React.createElement('MultiTextInput', props, null);
  });
  MultiTextInput.displayName = 'MockMultiTextInput';
  return { MultiTextInput };
});

vi.mock('@/components/ui/forms/Switch', () => ({
  Switch: (props: Record<string, unknown>) => React.createElement('Switch', props, null),
}));

vi.mock('@/components/ui/theme/haptics', () => ({
  hapticsLight: () => {},
  hapticsError: () => {},
}));

vi.mock('@/components/ui/feedback/Shaker', () => ({
  Shaker: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
  StatusDot: () => null,
}));

vi.mock('@/components/plugins/actions/ActionInputFormModal', () => ({
  ActionInputFormModal: () => null,
}));

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
  useActiveSuggestions: () => [[], -1, () => {}, () => {}],
}));

vi.mock('@/components/ui/popover', () => ({
  MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: {
    web: true,
    native: true,
    matchAnchorWidth: false,
    anchorAlign: 'start',
  },
  Popover: () => null,
  PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
  FloatingOverlay: () => null,
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
  useScrollEdgeFades: () => ({
    canScrollX: false,
    visibility: { left: false, right: false },
    onViewportLayout: () => {},
    onContentSizeChange: () => {},
    onScroll: () => {},
    onMomentumScrollEnd: () => {},
  }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
  ScrollEdgeFades: () => null,
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
  ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
  SourceControlStatusBadge: () => null,
  useHasMeaningfulScmStatus: () => false,
}));

function flattenStyle(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (Array.isArray(value)) {
    return value.reduce<Record<string, unknown>>(
      (result, entry) => ({ ...result, ...flattenStyle(entry) }),
      {},
    );
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function findNode(
  screen: Awaited<ReturnType<typeof renderScreen>>,
  hostType: string,
  testID: string,
) {
  const nodes = screen.findAll((node) => String(node.type) === hostType && node.props?.testID === testID);
  expect(nodes.length).toBe(1);
  return nodes[0]!;
}

const DECORATION_ID = 'acme.fixture:mounted-1:references';

const decorations = [{
  id: DECORATION_ID,
  key: 'references',
  decorations: {
    revision: 1,
    ranges: [
      {
        range: { start: 0, end: 5 },
        treatment: { kind: 'link' as const, url: 'https://example.com/first' },
        label: 'First reference',
      },
      {
        range: { start: 6, end: 12 },
        treatment: { kind: 'link' as const, url: 'https://example.com/second' },
        label: 'Second reference',
      },
      {
        range: { start: 13, end: 19 },
        treatment: 'warning' as const,
        label: 'Heads up',
      },
    ],
  },
}];

async function renderComposerWithDecorations() {
  const { AgentInput } = await import('./AgentInput');
  return renderScreen(
    <AgentInput
      value="alpha bravo charlie"
      onChangeText={() => {}}
      placeholder="p"
      onSend={() => {}}
      autocompleteKinds={[]}
      autocompleteSuggestions={async () => []}
      disabled={false}
      showAbortButton={false}
      composerDecorations={decorations as never}
    />,
  );
}

describe('AgentInput composer decoration interactive targets', () => {
  it('gives composer link decorations the canonical minimum target without overlapping their stacked neighbour', async () => {
    const screen = await renderComposerWithDecorations();
    const expectedMinimum = resolveMinimumInteractiveTargetSize('web');

    for (const index of [0, 1]) {
      const link = findNode(screen, 'Pressable', `agent-input-composer-decoration:${DECORATION_ID}:${index}`);
      const style = flattenStyle(
        typeof link.props.style === 'function' ? link.props.style({ pressed: false }) : link.props.style,
      );
      expect(style.minWidth).toBeGreaterThanOrEqual(expectedMinimum);
      expect(style.minHeight).toBeGreaterThanOrEqual(expectedMinimum);

      // The decoration row stacks its entries with a small gap. A hit-slop
      // floor would expand each target past that gap and into its neighbour,
      // trading one accessibility defect for another; a layout floor cannot.
      expect(link.props.hitSlop ?? null).toBeNull();
    }

    // The floor belongs to interactive treatments only: a presentational
    // decoration keeps its compact composer-feedback size.
    const nonInteractive = findNode(screen, 'View', `agent-input-composer-decoration:${DECORATION_ID}:2`);
    const nonInteractiveStyle = flattenStyle(nonInteractive.props.style);
    expect(nonInteractiveStyle.minWidth).toBeUndefined();
    expect(nonInteractiveStyle.minHeight).toBeUndefined();
  });
});
