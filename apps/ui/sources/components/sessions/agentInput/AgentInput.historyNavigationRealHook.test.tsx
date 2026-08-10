import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HistoryFixtureMessage = Readonly<{
    id: string;
    createdAt: number;
    text: string;
}>;

type MockSelection = Readonly<{ start: number; end: number }>;
type MockTextInputState = Readonly<{ text: string; selection: MockSelection }>;
type MockMultiTextInputProps = Readonly<{
    onChangeText?: (text: string) => void;
    onStateChange?: (state: MockTextInputState) => void;
    onSelectionChange?: (selection: MockSelection) => void;
}> & Record<string, unknown>;

const fixtureState = vi.hoisted(() => ({
    messagesBySessionId: {} as Record<string, readonly HistoryFixtureMessage[]>,
    latestValue: '',
}));

function buildMessagesById(messages: readonly HistoryFixtureMessage[]) {
    return Object.fromEntries(messages.map((message) => [
        message.id,
        {
            kind: 'user-text' as const,
            id: message.id,
            localId: null,
            createdAt: message.createdAt,
            text: message.text,
        },
    ]));
}

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
            ActivityIndicator: (props: Record<string, unknown>) =>
                React.createElement('ActivityIndicator', props, null),
            Platform: {
                OS: 'web',
                select: (value: Record<string, unknown>) => value.web ?? value.default ?? null,
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
            useSessionTranscriptIds: (sessionId: string) => ({
                ids: (fixtureState.messagesBySessionId[sessionId] ?? []).map((message) => message.id),
                isLoaded: true,
            }),
            useSessionMessagesById: (sessionId: string) =>
                buildMessagesById(fixtureState.messagesBySessionId[sessionId] ?? []),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => null,
        });
    },
    storageStore: async () => ({
        getStorage: () => (selector?: (state: unknown) => unknown) => {
            const sessionMessages = Object.fromEntries(
                Object.entries(fixtureState.messagesBySessionId).map(([sessionId, messages]) => [
                    sessionId,
                    {
                        messageIdsOldestFirst: messages.map((message) => message.id),
                        messagesById: buildMessagesById(messages),
                    },
                ]),
            );
            const state = { sessionMessages, localSettings: { uiFontScale: 1 } };
            return typeof selector === 'function' ? selector(state) : state;
        },
    }),
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        fetchUserMessageHistoryPage: vi.fn(),
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-1',
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => ({
        status: 'ready',
        features: {
            capabilities: {
                session: {
                    messages: {
                        role: false,
                    },
                },
            },
        },
    }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiBackdropBlurEnabled') return 1;
        if (key === 'uiFontScale') return 1;
        return null;
    },
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSvgXml: () => null,
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => undefined,
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
    getAgentBehavior: () => ({
        sessionUsage: {
            supportsExactContextUsageBadge: false,
        },
    }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
    findModelOptionForEffectiveModelId: (options: readonly any[], id: string) =>
        (options ?? []).find((o: any) => o.value === id) ?? (options ?? []).find((o: any) => o.extendedContextModelId === id) ?? null,
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
    const MultiTextInput = React.forwardRef((props: MockMultiTextInputProps, ref) => {
        React.useImperativeHandle(ref, () => ({
            setTextAndSelection: (text: string, selection: MockSelection) => {
                props.onChangeText?.(text);
                const state = { text, selection };
                props.onStateChange?.(state);
                props.onStateChange?.(state);
                props.onStateChange?.(state);
                props.onSelectionChange?.(selection);
            },
            setSelection: (selection: MockSelection) => {
                const text = typeof props.value === 'string' ? props.value : '';
                props.onStateChange?.({ text, selection });
                props.onSelectionChange?.(selection);
            },
            focus: () => {},
            blur: () => {},
            measureInWindow: () => {},
            getReactNodeTag: () => null,
            getInputElement: () => null,
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

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, () => {}, () => {}],
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
    applySuggestion: (text: string) => ({ text, cursorPosition: text.length }),
}));

function findMultiTextInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const input = screen.findByTestId('session-composer-input');
    expect(input).toBeTruthy();
    if (!input) throw new Error('session-composer-input not found');
    return input;
}

describe('AgentInput history navigation with real useUserMessageHistory', () => {
    afterEach(() => {
        fixtureState.messagesBySessionId = {};
        fixtureState.latestValue = '';
        vi.clearAllMocks();
    });

    it('continues per-session ArrowUp traversal after web history apply events settle', async () => {
        const { AgentInput } = await import('./AgentInput');
        function ControlledAgentInput(props: Readonly<{ sessionId: string }>) {
            const [value, setValue] = React.useState('');
            fixtureState.latestValue = value;

            return (
                <AgentInput
                    value={value}
                    onChangeText={setValue}
                    placeholder="p"
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId={props.sessionId}
                    metadata={null}
                    disabled={false}
                    showAbortButton={false}
                />
            );
        }

        fixtureState.messagesBySessionId = {
            s1: [
                { id: 'older', createdAt: 10, text: 'older current-session prompt' },
                { id: 'newer', createdAt: 20, text: 'newer current-session prompt' },
            ],
            s2: [
                { id: 'other', createdAt: 30, text: 'other-session prompt' },
            ],
        };

        const screen = await renderScreen(<ControlledAgentInput sessionId="s1" />);
        let input = findMultiTextInput(screen);

        await act(async () => {
            input.props.onStateChange?.({ text: '', selection: { start: 0, end: 0 } });
        });

        await act(async () => {
            expect(input.props.onKeyPress?.({
                key: 'ArrowUp',
                code: 'ArrowUp',
                shiftKey: false,
                inputState: { text: '', selection: { start: 0, end: 0 } },
            })).toBe(true);
        });

        expect(fixtureState.latestValue).toBe('newer current-session prompt');

        input = findMultiTextInput(screen);
        await act(async () => {
            expect(input.props.onKeyPress?.({
                key: 'ArrowUp',
                code: 'ArrowUp',
                shiftKey: false,
                inputState: {
                    text: 'newer current-session prompt',
                    selection: {
                        start: 'newer current-session prompt'.length,
                        end: 'newer current-session prompt'.length,
                    },
                },
            })).toBe(true);
        });

        expect(fixtureState.latestValue).toBe('older current-session prompt');
        await screen.unmount();
    });
});
