import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  historyMoveUp: vi.fn(),
  historyMoveDown: vi.fn(),
  historyReset: vi.fn(),

  suggestionMoveUp: vi.fn(),
  suggestionMoveDown: vi.fn(),

  onChangeText: vi.fn(),
  onSend: vi.fn(),
}));

vi.mock('react-native', async () => {
  const rn = await import('@/dev/reactNativeStub');
  return {
    ...rn,
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
      React.createElement('View', props, props.children),
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
      React.createElement('Text', props, props.children),
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
      React.createElement('Pressable', props, props.children),
    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
      React.createElement('ScrollView', props, props.children),
    ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props, null),
    Platform: { ...rn.Platform, OS: 'web', select: (v: any) => v.web ?? v.default ?? null },
    useWindowDimensions: () => ({ width: 900, height: 600 }),
    Dimensions: {
      get: () => ({ width: 900, height: 600, scale: 1, fontScale: 1 }),
    },
  };
});

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

vi.mock('@expo/vector-icons', () => ({
  Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
  Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
  useSetting: (key: string) => {
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
    agentInputEnterToSend: true,
    agentInputActionBarLayout: 'wrap',
    agentInputChipDensity: 'labels',
    sessionPermissionModeApplyTiming: 'immediate',
    agentInputHistoryScope: 'perSession',
  }),
  useSessionMessages: () => ({ messages: [], isLoaded: true }),
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
  useUserMessageHistory: () => ({
    moveUp: (...args: any[]) => mocks.historyMoveUp(...args),
    moveDown: (...args: any[]) => mocks.historyMoveDown(...args),
    reset: (...args: any[]) => mocks.historyReset(...args),
  }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
  AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
  DEFAULT_AGENT_ID: 'codex',
  resolveAgentIdFromFlavor: () => null,
  getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
  getModelOptionsForSession: () => [{ value: 'default', label: 'Default' }],
  supportsFreeformModelSelectionForSession: () => false,
}));

vi.mock('@/sync/domains/models/describeEffectiveModelMode', () => ({
  describeEffectiveModelMode: () => ({ effectiveModelId: 'default' }),
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

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
  MultiTextInput: (props: Record<string, unknown>) => React.createElement('MultiTextInput', props, null),
}));

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

vi.mock('@/components/autocomplete/useActiveWord', () => ({
  useActiveWord: () => ({ word: '', start: 0, end: 0 }),
}));

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
  useActiveSuggestions: () => [[], -1, mocks.suggestionMoveUp, mocks.suggestionMoveDown],
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
  applySuggestion: (text: string) => ({ text, cursorPosition: text.length }),
}));

vi.mock('@/components/ui/popover', () => ({
  Popover: () => null,
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

function findMultiTextInput(tree: renderer.ReactTestRenderer) {
  const nodes = tree.root.findAllByType('MultiTextInput' as any);
  expect(nodes.length).toBe(1);
  return nodes[0]!;
}

describe('AgentInput (history navigation)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('intercepts ArrowUp at start-of-input on web and applies history text', async () => {
    mocks.historyMoveUp.mockReturnValue('previous message');

    const { AgentInput } = await import('./AgentInput');
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(
        <AgentInput
          value="draft"
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          sessionId="s1"
          metadata={null}
          disabled={false}
          showAbortButton={false}
        />
      );
    });

    const input = findMultiTextInput(tree!);
    // Ensure AgentInput has selection state set to start-of-input.
    await act(async () => {
      input.props.onStateChange?.({ text: 'draft', selection: { start: 0, end: 0 } });
    });

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({ key: 'ArrowUp', shiftKey: false });
    });

    expect(handled).toBe(true);
    expect(mocks.historyMoveUp).toHaveBeenCalledWith('draft');
    expect(mocks.onChangeText).toHaveBeenCalledWith('previous message');
  });

  it('does not intercept ArrowUp when cursor is mid-text', async () => {
    mocks.historyMoveUp.mockReturnValue('previous message');

    const { AgentInput } = await import('./AgentInput');
    let tree: renderer.ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(
        <AgentInput
          value="draft"
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          sessionId="s1"
          metadata={null}
          disabled={false}
          showAbortButton={false}
        />
      );
    });

    const input = findMultiTextInput(tree!);
    await act(async () => {
      input.props.onStateChange?.({ text: 'draft', selection: { start: 2, end: 2 } });
    });

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({ key: 'ArrowUp', shiftKey: false });
    });

    expect(handled).toBe(false);
    expect(mocks.historyMoveUp).not.toHaveBeenCalled();
    expect(mocks.onChangeText).not.toHaveBeenCalled();
  });
});
