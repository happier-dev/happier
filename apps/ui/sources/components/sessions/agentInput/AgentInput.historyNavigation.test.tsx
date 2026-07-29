import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import {
  TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS,
  TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT,
} from '@/components/ui/forms/largeTextInputPolicy';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  historyMoveUp: vi.fn(),
  historyMoveDown: vi.fn(),
  historyReset: vi.fn(),
  historyWarmup: vi.fn(),
  historyIsBrowsing: vi.fn(),
  historyHasRetainedSession: vi.fn(),
  historyPause: vi.fn(),

  suggestionMoveUp: vi.fn(),
  suggestionMoveDown: vi.fn(),

  onChangeText: vi.fn(),
  onSend: vi.fn(),
  recordLargeTextInputDiagnostic: vi.fn(),
}));

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
        if (key in localSettingState.values) return localSettingState.values[key as keyof typeof localSettingState.values];
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
        keyboardShortcutsV2Enabled: localSettingState.values.keyboardShortcutsV2Enabled,
        keyboardSingleKeyShortcutsEnabled: localSettingState.values.keyboardSingleKeyShortcutsEnabled,
        keyboardShortcutOverridesV1: localSettingState.values.keyboardShortcutOverridesV1,
        keyboardShortcutDisabledCommandIdsV1: localSettingState.values.keyboardShortcutDisabledCommandIdsV1,
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

vi.mock('@/utils/system/userInteractionDiagnostics', () => ({
  recordLargeTextInputDiagnostic: (...args: unknown[]) => mocks.recordLargeTextInputDiagnostic(...args),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
  useUserMessageHistory: () => ({
    moveUp: (...args: any[]) => mocks.historyMoveUp(...args),
    moveDown: (...args: any[]) => mocks.historyMoveDown(...args),
    reset: (...args: any[]) => mocks.historyReset(...args),
    warmup: (...args: any[]) => mocks.historyWarmup(...args),
    isBrowsing: (...args: any[]) => mocks.historyIsBrowsing(...args),
    hasRetainedSession: (...args: any[]) => mocks.historyHasRetainedSession(...args),
    pause: (...args: any[]) => mocks.historyPause(...args),
  }),
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
    findModelOptionForEffectiveModelId: (options: any, effectiveModelId: any) =>
        options?.find?.((option: any) => option.value === effectiveModelId)
            ?? options?.find?.((option: any) => option.value === String(effectiveModelId ?? '').replace(/\[[^\]]*\]$/u, ''))
            ?? null,
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

type MockMultiTextInputSelection = Readonly<{ start: number; end: number }>;
type MockMultiTextInputProps = Record<string, unknown> & Readonly<{
  onChangeText?: (text: string) => void;
  onStateChange?: (state: Readonly<{ text: string; selection: MockMultiTextInputSelection }>) => void;
  onSelectionChange?: (selection: MockMultiTextInputSelection) => void;
}>;

vi.mock('@/components/ui/forms/MultiTextInput', () => {
  const MultiTextInput = React.forwardRef((props: MockMultiTextInputProps, ref) => {
    React.useImperativeHandle(ref, () => ({
      setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
        props.onChangeText?.(text);
        props.onStateChange?.({ text, selection });
        props.onStateChange?.({ text, selection });
        props.onSelectionChange?.(selection);
      },
      setSelection: (selection: MockMultiTextInputSelection) => {
        const text = typeof props.value === 'string' ? props.value : '';
        props.onStateChange?.({ text, selection });
        props.onSelectionChange?.(selection);
      },
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

function findMultiTextInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const nodes = screen.findAll((node) => (node.type as any) === 'MultiTextInput');
  expect(nodes.length).toBe(1);
  return nodes[0]!;
}

function findAllByTestID(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
  return screen.findAll((node) => String(node.type) === 'Pressable' && node.props?.testID === testID);
}

describe('AgentInput (history navigation)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.historyIsBrowsing.mockReturnValue(false);
    mocks.historyHasRetainedSession.mockReturnValue(false);
    localSettingState.values = {
      uiBackdropBlurEnabled: 1,
      keyboardShortcutsV2Enabled: true,
      keyboardSingleKeyShortcutsEnabled: true,
      keyboardShortcutOverridesV1: {},
      keyboardShortcutDisabledCommandIdsV1: [],
    };
  });

  it('sends on Enter when there are sendable attachments (web enter-to-send)', async () => {
    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(
      <AgentInput
        value=""
        onChangeText={mocks.onChangeText}
        placeholder="p"
        onSend={mocks.onSend}
        autocompletePrefixes={[]}
        autocompleteSuggestions={async () => []}
        isSendDisabled={false}
        disabled={false}
        showAbortButton={false}
        hasSendableAttachments={true}
      />
    );

    const input = findMultiTextInput(screen);

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({ key: 'Enter', shiftKey: false });
    });

    expect(handled).toBe(true);
    expect(mocks.onSend).toHaveBeenCalledTimes(1);
    expect(mocks.historyReset).toHaveBeenCalledTimes(1);
  });

  it('records large-text send flush metadata before sending', async () => {
    const { AgentInput } = await import('./AgentInput');
    const largePrompt = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
    const screen = await renderScreen(
      <AgentInput
        value={largePrompt}
        onChangeText={mocks.onChangeText}
        placeholder="p"
        onSend={mocks.onSend}
        autocompletePrefixes={[]}
        autocompleteSuggestions={async () => []}
        isSendDisabled={false}
        disabled={false}
        showAbortButton={false}
      />
    );

    const input = findMultiTextInput(screen);

    await act(async () => {
      input.props.onKeyPress?.({ key: 'Enter', shiftKey: false });
    });

    expect(mocks.recordLargeTextInputDiagnostic).toHaveBeenCalledWith({
      phase: 'send-flush',
      platform: 'web',
      surface: 'agentInput',
      textLength: largePrompt.length,
      selection: { start: largePrompt.length, end: largePrompt.length },
      valueLength: largePrompt.length,
      liveTextLength: largePrompt.length,
    });
  });

  it('does not send on Enter when sending is disabled', async () => {
    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
          value="draft"
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          isSendDisabled={true}
          disabled={false}
          showAbortButton={false}
        />);

    const input = findMultiTextInput(screen);

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({ key: 'Enter', shiftKey: false });
    });

    expect(handled).toBe(false);
    expect(mocks.onSend).not.toHaveBeenCalled();
    expect(mocks.historyReset).not.toHaveBeenCalled();
  });

  it('uses immediate-send bypass on Cmd+Enter (web)', async () => {
    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(
      <AgentInput
        sessionId="s1"
        value="draft"
        onChangeText={mocks.onChangeText}
        placeholder="p"
        onSend={mocks.onSend}
        autocompletePrefixes={[]}
        autocompleteSuggestions={async () => []}
        isSendDisabled={false}
        disabled={false}
        showAbortButton={false}
      />
    );

    const input = findMultiTextInput(screen);

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({
        key: 'Enter',
        shiftKey: false,
        metaKey: true,
        platformOS: 'web',
        webPlatform: 'MacIntel',
      });
    });

    expect(handled).toBe(true);
    expect(mocks.onSend).toHaveBeenCalledTimes(1);
    expect(mocks.onSend).toHaveBeenCalledWith({ forceImmediate: true });
  });

  it('uses immediate-send bypass on Ctrl+Enter for non-Apple web platforms', async () => {
    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(
      <AgentInput
        sessionId="s1"
        value="draft"
        onChangeText={mocks.onChangeText}
        placeholder="p"
        onSend={mocks.onSend}
        autocompletePrefixes={[]}
        autocompleteSuggestions={async () => []}
        isSendDisabled={false}
        disabled={false}
        showAbortButton={false}
      />
    );

    const input = findMultiTextInput(screen);

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({
        key: 'Enter',
        shiftKey: false,
        ctrlKey: true,
        platformOS: 'web',
        webPlatform: 'Win32',
      });
    });

    expect(handled).toBe(true);
    expect(mocks.onSend).toHaveBeenCalledTimes(1);
    expect(mocks.onSend).toHaveBeenCalledWith({ forceImmediate: true });
  });

  it('does not optimistically clear existing-session text before send acknowledgement', async () => {
    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(
      <AgentInput
        sessionId="s1"
        value="draft"
        onChangeText={mocks.onChangeText}
        placeholder="p"
        onSend={mocks.onSend}
        autocompletePrefixes={[]}
        autocompleteSuggestions={async () => []}
        isSendDisabled={false}
        disabled={false}
        showAbortButton={false}
      />
    );

    const input = findMultiTextInput(screen);

    await act(async () => {
      input.props.onKeyPress?.({ key: 'Enter', shiftKey: false });
    });

    expect(mocks.onSend).toHaveBeenCalledTimes(1);
    expect(mocks.onChangeText).not.toHaveBeenCalledWith('');
  });

  it('uses the pending-send shortcut delivery intent', async () => {
    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(
      <AgentInput
        sessionId="s1"
        value="draft"
        onChangeText={mocks.onChangeText}
        placeholder="p"
        onSend={mocks.onSend}
        autocompletePrefixes={[]}
        autocompleteSuggestions={async () => []}
        isSendDisabled={false}
        disabled={false}
        showAbortButton={false}
      />
    );

    const input = findMultiTextInput(screen);

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({
        key: 'Enter',
        code: 'Enter',
        shiftKey: true,
        metaKey: true,
        platformOS: 'web',
        webPlatform: 'MacIntel',
      });
    });

    expect(handled).toBe(true);
    expect(mocks.onSend).toHaveBeenCalledTimes(1);
    expect(mocks.onSend).toHaveBeenCalledWith({ deliveryIntent: 'server_pending' });
  });

  it('does not treat Ctrl+Enter as immediate-send on Apple web platforms', async () => {
    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(
      <AgentInput
        sessionId="s1"
        value="draft"
        onChangeText={mocks.onChangeText}
        placeholder="p"
        onSend={mocks.onSend}
        autocompletePrefixes={[]}
        autocompleteSuggestions={async () => []}
        isSendDisabled={false}
        disabled={false}
        showAbortButton={false}
      />
    );

    const input = findMultiTextInput(screen);

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({
        key: 'Enter',
        shiftKey: false,
        ctrlKey: true,
        platformOS: 'web',
        webPlatform: 'MacIntel',
      });
    });

    expect(handled).toBe(false);
    expect(mocks.onSend).not.toHaveBeenCalled();
  });

  it('does not cycle permission mode when the mode cycle shortcut is disabled', async () => {
    localSettingState.values.keyboardShortcutDisabledCommandIdsV1 = ['mode.cycle'];
    const onPermissionModeChange = vi.fn();
    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(
      <AgentInput
        sessionId="s1"
        value="draft"
        onChangeText={mocks.onChangeText}
        placeholder="p"
        onSend={mocks.onSend}
        autocompletePrefixes={[]}
        autocompleteSuggestions={async () => []}
        isSendDisabled={false}
        disabled={false}
        showAbortButton={false}
        onPermissionModeChange={onPermissionModeChange}
      />
    );

    const input = findMultiTextInput(screen);

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({ key: 'Tab', code: 'Tab', shiftKey: true });
    });

    expect(handled).toBe(false);
    expect(onPermissionModeChange).not.toHaveBeenCalled();
  });

  it('does not cycle permission mode when keyboard shortcuts V2 is disabled', async () => {
    localSettingState.values.keyboardShortcutsV2Enabled = false;
    const onPermissionModeChange = vi.fn();
    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(
      <AgentInput
        sessionId="s1"
        value="draft"
        onChangeText={mocks.onChangeText}
        placeholder="p"
        onSend={mocks.onSend}
        autocompletePrefixes={[]}
        autocompleteSuggestions={async () => []}
        isSendDisabled={false}
        disabled={false}
        showAbortButton={false}
        onPermissionModeChange={onPermissionModeChange}
      />
    );

    const input = findMultiTextInput(screen);

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({ key: 'Tab', code: 'Tab', shiftKey: true });
    });

    expect(handled).toBe(false);
    expect(onPermissionModeChange).not.toHaveBeenCalled();
  });

  it('intercepts ArrowUp at start-of-input on web and applies history text', async () => {
    mocks.historyMoveUp.mockReturnValue('previous message');

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
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
        />);

    const input = findMultiTextInput(screen);
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

  it('uses live key event selection so ArrowUp at the real input start enters history immediately', async () => {
    mocks.historyMoveUp.mockReturnValue('previous message');

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
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
        />);

    const input = findMultiTextInput(screen);
    await act(async () => {
      input.props.onStateChange?.({ text: 'draft', selection: { start: 5, end: 5 } });
    });

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({
        key: 'ArrowUp',
        shiftKey: false,
        inputState: { text: 'draft', selection: { start: 0, end: 0 } },
      });
    });

    expect(handled).toBe(true);
    expect(mocks.historyMoveUp).toHaveBeenCalledWith('draft');
    expect(mocks.onChangeText).toHaveBeenCalledWith('previous message');
  });

  it('does not enter history when live key event selection is mid-text even if stale state says start', async () => {
    mocks.historyMoveUp.mockReturnValue('previous message');

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
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
        />);

    const input = findMultiTextInput(screen);
    await act(async () => {
      input.props.onStateChange?.({ text: 'draft', selection: { start: 0, end: 0 } });
    });

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({
        key: 'ArrowUp',
        shiftKey: false,
        inputState: { text: 'draft', selection: { start: 2, end: 2 } },
      });
    });

    expect(handled).toBe(false);
    expect(mocks.historyMoveUp).not.toHaveBeenCalled();
    expect(mocks.onChangeText).not.toHaveBeenCalled();
  });

  it('uses the controlled value after the parent clears the composer before history navigation', async () => {
    mocks.historyMoveUp.mockReturnValue('previous message');

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
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
        />);

    let input = findMultiTextInput(screen);
    await act(async () => {
      input.props.onStateChange?.({ text: 'draft', selection: { start: 5, end: 5 } });
    });

    await act(async () => {
      screen.tree.update(<AgentInput
          value=""
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          sessionId="s1"
          metadata={null}
          disabled={false}
          showAbortButton={false}
        />);
    });

    input = findMultiTextInput(screen);
    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({ key: 'ArrowUp', shiftKey: false });
    });

    expect(handled).toBe(true);
    expect(mocks.historyMoveUp).toHaveBeenCalledWith('');
    expect(mocks.onChangeText).toHaveBeenCalledWith('previous message');
  });

  it('does not intercept ArrowUp when cursor is mid-text', async () => {
    mocks.historyMoveUp.mockReturnValue('previous message');

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
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
        />);

    const input = findMultiTextInput(screen);
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

  it('continues ArrowUp history navigation while browsing even when the cursor is at the end', async () => {
    mocks.historyIsBrowsing.mockReturnValue(true);
    mocks.historyMoveUp.mockReturnValue('older message');

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
          value="previous message"
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          sessionId="s1"
          metadata={null}
          disabled={false}
          showAbortButton={false}
        />);

    const input = findMultiTextInput(screen);
    await act(async () => {
      input.props.onStateChange?.({ text: 'previous message', selection: { start: 16, end: 16 } });
    });

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({ key: 'ArrowUp', shiftKey: false });
    });

    expect(handled).toBe(true);
    expect(mocks.historyMoveUp).toHaveBeenCalledWith('previous message');
    expect(mocks.onChangeText).toHaveBeenCalledWith('older message');
  });

  it('does not enter history browsing from idle ArrowDown at the end of the input', async () => {
    mocks.historyIsBrowsing.mockReturnValue(false);
    mocks.historyMoveDown.mockReturnValue('should not be used');

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
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
        />);

    const input = findMultiTextInput(screen);
    await act(async () => {
      input.props.onStateChange?.({ text: 'draft', selection: { start: 5, end: 5 } });
    });

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({ key: 'ArrowDown', shiftKey: false });
    });

    expect(handled).toBe(false);
    expect(mocks.historyMoveDown).not.toHaveBeenCalled();
  });

  it('passes the current edited history text to ArrowDown while browsing', async () => {
    mocks.historyIsBrowsing.mockReturnValue(true);
    mocks.historyMoveDown.mockReturnValue('draft');

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
          value="previous message"
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          sessionId="s1"
          metadata={null}
          disabled={false}
          showAbortButton={false}
        />);

    const input = findMultiTextInput(screen);

    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({
        key: 'ArrowDown',
        shiftKey: false,
        inputState: {
          text: 'edited recalled message',
          selection: { start: 23, end: 23 },
        },
      });
    });

    expect(handled).toBe(true);
    expect(mocks.historyMoveDown).toHaveBeenCalledWith('edited recalled message');
    expect(mocks.onChangeText).toHaveBeenCalledWith('draft');
  });

  it('resumes a paused retained history session from ArrowDown at the input end', async () => {
    mocks.historyIsBrowsing.mockReturnValue(false);
    mocks.historyHasRetainedSession.mockReturnValue(true);
    mocks.historyMoveDown.mockReturnValue('draft');

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
          value="edited recalled message"
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          sessionId="s1"
          metadata={null}
          disabled={false}
          showAbortButton={false}
        />);

    const input = findMultiTextInput(screen);
    let handled: any = null;
    await act(async () => {
      handled = input.props.onKeyPress?.({
        key: 'ArrowDown',
        shiftKey: false,
        inputState: {
          text: 'edited recalled message',
          selection: { start: 23, end: 23 },
        },
      });
    });

    expect(handled).toBe(true);
    expect(mocks.historyMoveDown).toHaveBeenCalledWith('edited recalled message');
    expect(mocks.onChangeText).toHaveBeenCalledWith('draft');
  });

  it('pauses retained history browsing when the user moves the cursor', async () => {
    mocks.historyIsBrowsing.mockReturnValue(true);
    mocks.historyHasRetainedSession.mockReturnValue(true);

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
          value="previous message"
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          sessionId="s1"
          metadata={null}
          disabled={false}
          showAbortButton={false}
        />);

    const input = findMultiTextInput(screen);
    await act(async () => {
      input.props.onStateChange?.({ text: 'previous message', selection: { start: 4, end: 4 } });
    });

    expect(mocks.historyPause).toHaveBeenCalledWith('previous message');
    expect(mocks.historyReset).not.toHaveBeenCalled();
  });

  it('does not exit history browsing for the state change caused by applying a history entry', async () => {
    mocks.historyIsBrowsing.mockReturnValue(true);
    mocks.historyMoveUp.mockReturnValue('older message');

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
          value="previous message"
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          sessionId="s1"
          metadata={null}
          disabled={false}
          showAbortButton={false}
        />);

    const input = findMultiTextInput(screen);
    await act(async () => {
      input.props.onStateChange?.({ text: 'previous message', selection: { start: 0, end: 0 } });
    });
    mocks.historyReset.mockClear();

    await act(async () => {
      input.props.onKeyPress?.({ key: 'ArrowUp', shiftKey: false });
    });

    expect(mocks.historyReset).not.toHaveBeenCalled();
  });

  it('warms session history when the composer receives focus', async () => {
    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
          value=""
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          sessionId="s1"
          metadata={null}
          disabled={false}
          showAbortButton={false}
        />);

    const input = findMultiTextInput(screen);
    await act(async () => {
      input.props.onFocus?.();
    });

    expect(mocks.historyWarmup).toHaveBeenCalledTimes(1);
  });

  it('passes persisted input scroll and selection callbacks to the text input', async () => {
    const { AgentInput } = await import('./AgentInput');
    const onScrollYChange = vi.fn();
    const onSelectionChangePersist = vi.fn();
    const screen = await renderScreen(<AgentInput
          value="draft"
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          disabled={false}
          showAbortButton={false}
          inputPersistence={{
            initialScrollY: 44,
            initialSelection: { start: 1, end: 3 },
            restoreToken: 'session:s1:1',
            onScrollYChange,
            onSelectionChangePersist,
          }}
        />);

    const input = findMultiTextInput(screen);
    expect(input.props.initialScrollY).toBe(44);
    expect(input.props.scrollRestoreToken).toBe('session:s1:1');
    expect(input.props.onScrollYChange).toBe(onScrollYChange);

    await act(async () => {
      input.props.onStateChange?.({
        text: 'draft',
        selection: { start: 2, end: 4 },
      });
    });

    expect(onSelectionChangePersist).toHaveBeenCalledWith({ start: 2, end: 4 }, 5);
  });

  it('records large-text selection restore metadata without prompt contents', async () => {
    const { AgentInput } = await import('./AgentInput');
    const largePrompt = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
    await renderScreen(<AgentInput
          value={largePrompt}
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          disabled={false}
          showAbortButton={false}
          inputPersistence={{
            initialSelection: { start: 4, end: 4 },
            restoreToken: 'session:s1:restore',
            onScrollYChange: vi.fn(),
            onSelectionChangePersist: vi.fn(),
          }}
        />);

    expect(mocks.recordLargeTextInputDiagnostic).toHaveBeenCalledWith({
      phase: 'selection-restore',
      platform: 'web',
      surface: 'agentInput',
      textLength: largePrompt.length,
      selection: { start: 4, end: 4 },
      valueLength: largePrompt.length,
    });
    expect(JSON.stringify(mocks.recordLargeTextInputDiagnostic.mock.calls)).not.toContain(largePrompt);
  });

  it('buffers continuous oversized edits from parent state while keeping the full local input value', async () => {
    vi.useFakeTimers();
    const { AgentInput } = await import('./AgentInput');
    const largePrompt = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
    const editedPrompt = `${largePrompt}y`;
    const renderElement = (abortVisible: boolean) => (
      <AgentInput
        value={largePrompt}
        onChangeText={mocks.onChangeText}
        placeholder="p"
        onSend={mocks.onSend}
        autocompletePrefixes={[]}
        autocompleteSuggestions={async () => []}
        isSendDisabled={false}
        disabled={false}
        showAbortButton={abortVisible}
      />
    );
    const screen = await renderScreen(renderElement(false));
    let input = findMultiTextInput(screen);

    await act(async () => {
      input.props.onStateChange?.({
        text: editedPrompt,
        selection: { start: editedPrompt.length, end: editedPrompt.length },
      });
      input.props.onChangeText?.(editedPrompt);
    });

    expect(mocks.onChangeText).not.toHaveBeenCalled();

    await act(async () => {
      screen.tree.update(renderElement(true));
    });

    input = findMultiTextInput(screen);
    expect(input.props.value).toBe(editedPrompt);

    await act(async () => {
      vi.advanceTimersByTime(TEXT_INPUT_LARGE_TEXT_CHANGE_DEBOUNCE_MS);
    });

    expect(mocks.onChangeText).toHaveBeenCalledTimes(1);
    expect(mocks.onChangeText).toHaveBeenCalledWith(editedPrompt);
  });

  it('flushes the latest oversized local edit before sending', async () => {
    vi.useFakeTimers();
    const { AgentInput } = await import('./AgentInput');
    const largePrompt = 'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1);
    const editedPrompt = `${largePrompt}y`;
    const screen = await renderScreen(
      <AgentInput
        value={largePrompt}
        onChangeText={mocks.onChangeText}
        placeholder="p"
        onSend={mocks.onSend}
        autocompletePrefixes={[]}
        autocompleteSuggestions={async () => []}
        isSendDisabled={false}
        disabled={false}
        showAbortButton={false}
      />
    );
    const input = findMultiTextInput(screen);

    await act(async () => {
      input.props.onStateChange?.({
        text: editedPrompt,
        selection: { start: editedPrompt.length, end: editedPrompt.length },
      });
      input.props.onChangeText?.(editedPrompt);
    });

    expect(mocks.onChangeText).not.toHaveBeenCalled();

    await act(async () => {
      input.props.onKeyPress?.({ key: 'Enter', shiftKey: false });
    });

    expect(mocks.onChangeText).toHaveBeenCalledTimes(1);
    expect(mocks.onChangeText).toHaveBeenCalledWith(editedPrompt);
    expect(mocks.onSend).toHaveBeenCalledTimes(1);
    expect(mocks.onSend).toHaveBeenCalledWith({ inputTextOverride: editedPrompt });
  });

  it('shows an expansion toggle when persisted expansion is available and input content overflows', async () => {
    const { AgentInput } = await import('./AgentInput');
    const onToggle = vi.fn();
    const screen = await renderScreen(<AgentInput
          sessionId="s1"
          value="large draft"
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          disabled={false}
          showAbortButton={false}
          inputExpansion={{
            expanded: false,
            collapsedMaxHeight: 80,
            onToggle,
          }}
        />);

    const input = findMultiTextInput(screen);
    expect(findAllByTestID(screen, 'agent-input-expand-toggle')).toHaveLength(0);

    await act(async () => {
      input.props.onContentHeightChange?.(96);
    });

    const toggles = findAllByTestID(screen, 'agent-input-expand-toggle');
    expect(toggles).toHaveLength(1);

    await act(async () => {
      toggles[0]!.props.onPress();
    });

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does not pause history browsing for extra textarea events after applying a history entry', async () => {
    mocks.historyIsBrowsing.mockReturnValue(true);
    mocks.historyHasRetainedSession.mockReturnValue(true);
    mocks.historyMoveUp.mockReturnValue('older message');

    const { AgentInput } = await import('./AgentInput');
    const screen = await renderScreen(<AgentInput
          value="previous message"
          onChangeText={mocks.onChangeText}
          placeholder="p"
          onSend={mocks.onSend}
          autocompletePrefixes={[]}
          autocompleteSuggestions={async () => []}
          sessionId="s1"
          metadata={null}
          disabled={false}
          showAbortButton={false}
        />);

    const input = findMultiTextInput(screen);
    await act(async () => {
      input.props.onStateChange?.({ text: 'previous message', selection: { start: 0, end: 0 } });
    });
    mocks.historyPause.mockClear();

    await act(async () => {
      input.props.onKeyPress?.({ key: 'ArrowUp', shiftKey: false });
      input.props.onStateChange?.({ text: 'older message', selection: { start: 13, end: 13 } });
    });

    expect(mocks.historyPause).not.toHaveBeenCalled();
  });
});
