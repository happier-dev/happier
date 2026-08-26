import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import type { ComposerStructuredInputMention } from './structuredInputMentions';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MockSelection = Readonly<{ start: number; end: number }>;
type MockTextInputState = Readonly<{ text: string; selection: MockSelection }>;
type MockMultiTextInputProps = Readonly<{
    value?: string;
    onChangeText?: (text: string) => void;
    onStateChange?: (state: MockTextInputState) => void;
    onKeyPress?: (event: { key: string; shiftKey?: boolean; inputState?: MockTextInputState }) => boolean;
}> & Record<string, unknown>;

const multiTextInputMockState = vi.hoisted(() => ({
    liveText: null as string | null,
    /** Every selection the composer pushed into the input, in order. */
    appliedSelections: [] as Array<Readonly<{ start: number; end: number }>>,
}));

const autocompleteMockState = vi.hoisted(() => ({
    suggestions: [] as Array<{
        kind: 'skill' | 'slashCommand';
        key: string;
        text: string;
        label?: string;
        structuredInput?: Readonly<{
            kind: 'skill';
            name: string;
            displayName?: string;
        }>;
    }>,
    selected: -1,
    respectQuery: false,
    lastQuery: null as string | null,
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
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => null,
        });
    },
    storageStore: async () => ({
        getStorage: () => Object.assign(
            (selector?: (state: unknown) => unknown) => {
                const state = { sessionMessages: {}, localSettings: { uiFontScale: 1, uiContentWidthMode: 'wide' } };
                return typeof selector === 'function' ? selector(state) : state;
            },
            { getState: () => ({ localSettings: { uiFontScale: 1, uiContentWidthMode: 'wide' } }) },
        ),
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
        features: { capabilities: { session: { messages: { role: false } } } },
    }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiBackdropBlurEnabled') return 1;
        if (key === 'uiFontScale') return 1;
        return null;
    },
    useActiveServerAccountScope: () => null,
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

vi.mock('@/components/ui/forms/MultiTextInput', () => {
    const readLiveText = (props: MockMultiTextInputProps): string => multiTextInputMockState.liveText ?? (typeof props.value === 'string' ? props.value : '');
    const MultiTextInput = React.forwardRef((props: MockMultiTextInputProps, ref) => {
        React.useImperativeHandle(ref, () => ({
            setTextAndSelection: (text: string, selection: MockSelection) => {
                multiTextInputMockState.liveText = text;
                props.onChangeText?.(text);
                props.onStateChange?.({ text, selection });
            },
            setSelection: (selection: MockSelection) => {
                multiTextInputMockState.appliedSelections.push(selection);
                const text = readLiveText(props);
                props.onStateChange?.({ text, selection });
            },
            getText: () => readLiveText(props),
            flushPendingTextChange: () => {
                const text = readLiveText(props);
                props.onChangeText?.(text);
                props.onStateChange?.({ text, selection: { start: text.length, end: text.length } });
                return text;
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

vi.mock('@/components/ui/commandMenu', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/ui/commandMenu')>(),
    CommandMenu: () => null,
    useCommandMenuKeyboard: (args: Readonly<{
        open: boolean;
        onSelect: () => void;
    }>) => ({
        handleKey: (event: { key: string }) => {
            if (args.open && event.key === 'Enter') {
                args.onSelect();
                return true;
            }
            return false;
        },
    }),
}));

vi.mock('@/components/ui/popover', () => ({
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: { web: { target: 'body' }, native: true },
    Popover: (props: Record<string, unknown> & { children?: React.ReactNode | ((args: Record<string, unknown>) => React.ReactNode) }) =>
        React.createElement(
            'Popover',
            props,
            typeof props.children === 'function' ? props.children({}) : props.children,
        ),
    PopoverScope: (props: { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
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
    useActiveSuggestions: (query: string | null) => {
        autocompleteMockState.lastQuery = query;
        const suggestions = !autocompleteMockState.respectQuery || query !== null
            ? autocompleteMockState.suggestions
            : [];
        return [suggestions, autocompleteMockState.selected, () => {}, () => {}];
    },
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
    applySuggestion: (
        text: string,
        selection: Readonly<{ start: number; end: number }>,
        suggestionText: string,
    ) => {
        let start = selection.start;
        while (start > 0 && !/\s/.test(text[start - 1] ?? '')) {
            start -= 1;
        }
        const nextText = `${text.slice(0, start)}${suggestionText}${text.slice(selection.end)}`;
        return { text: nextText, cursorPosition: start + suggestionText.length };
    },
}));

const reviewMention = {
    kind: 'skill',
    tokenText: '$review',
    name: 'review',
} satisfies ComposerStructuredInputMention;

const staleMention = {
    kind: 'skill',
    tokenText: '$gone',
    name: 'gone',
} satisfies ComposerStructuredInputMention;

const selectionRestoreBaseProps = {
    onChangeText: () => {},
    placeholder: 'p',
    onSend: () => {},
    autocompleteKinds: [],
    autocompleteSuggestions: async () => [],
    sessionId: 'session-a',
    metadata: null,
    disabled: false,
    showAbortButton: false,
};

/** A stale word-range, exactly what a double-tap/autocorrect leaves behind. */
const selectionRestorePersistence = {
    initialSelection: { start: 4, end: 11 },
    onScrollYChange: () => {},
    onSelectionChangePersist: () => {},
};

function findMultiTextInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const nodes = screen.findAll((node) => (node.type as unknown) === 'MultiTextInput');
    expect(nodes.length).toBe(1);
    return nodes[0]!;
}

describe('AgentInput structured input persistence', () => {
    afterEach(() => {
        vi.clearAllMocks();
        autocompleteMockState.suggestions = [];
        autocompleteMockState.selected = -1;
        autocompleteMockState.respectQuery = false;
        autocompleteMockState.lastQuery = null;
        multiTextInputMockState.liveText = null;
        multiTextInputMockState.appliedSelections = [];
    });

    it('reconciles controlled structured mentions when the external value changes', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onStructuredInputMentionsChange = vi.fn();
        const baseProps = {
            onChangeText: () => {},
            placeholder: 'p',
            onSend: () => {},
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            sessionId: 'session-a',
            metadata: null,
            disabled: false,
            showAbortButton: false,
            onStructuredInputMentionsChange,
        };
        const screen = await renderScreen(React.createElement(AgentInput, {
            ...baseProps,
            value: 'Ask $review $gone',
            structuredInputMentions: [reviewMention, staleMention],
        }));

        await act(async () => {
            screen.tree.update(React.createElement(AgentInput, {
                ...baseProps,
                value: 'Ask $review',
                structuredInputMentions: [reviewMention, staleMention],
            }));
        });

        expect(onStructuredInputMentionsChange).toHaveBeenCalledWith([reviewMention]);
        await screen.unmount();
    });

    it('sends selected structured mention metadata before controlled props rerender', async () => {
        autocompleteMockState.suggestions = [{
            kind: 'skill',
            key: 'skill-review',
            text: '$review',
            label: 'Review',
            structuredInput: {
                kind: 'skill',
                name: 'review',
                displayName: 'Review',
            },
        }];
        autocompleteMockState.selected = 0;
        const { AgentInput } = await import('./AgentInput');
        const onSend = vi.fn();
        const onChangeText = vi.fn();
        const onStructuredInputMentionsChange = vi.fn();
        const screen = await renderScreen(React.createElement(AgentInput, {
            value: 'Ask $r',
            onChangeText,
            placeholder: 'p',
            onSend,
            autocompleteKinds: ['skill'] as const,
            autocompleteSuggestions: async () => autocompleteMockState.suggestions,
            sessionId: 'session-a',
            metadata: null,
            disabled: false,
            showAbortButton: false,
            structuredInputMentions: [],
            onStructuredInputMentionsChange,
        }));

        const input = findMultiTextInput(screen);
        await act(async () => {
            expect(input.props.onKeyPress?.({ key: 'Enter' })).toBe(true);
        });

        expect(onSend).not.toHaveBeenCalled();
        expect(onChangeText).toHaveBeenCalledWith('Ask $review');
        expect(onStructuredInputMentionsChange).toHaveBeenCalledWith([
            expect.objectContaining({
                kind: 'skill',
                tokenText: '$review',
                name: 'review',
            }),
        ]);

        await screen.pressByTestIdAsync('session-composer-send');

        expect(onSend).toHaveBeenCalledWith({
            inputTextOverride: 'Ask $review',
            structuredInputMetaOverrides: {
                happierStructuredInputV1: {
                    v: 1,
                    skillMentions: [{
                        name: 'review',
                        displayName: 'Review',
                    }],
                },
            },
        });
        await screen.unmount();
    });

    it('keeps autocomplete available for large live input text without pushing the full text into render state', async () => {
        autocompleteMockState.suggestions = [{
            kind: 'slashCommand',
            key: 'slash-run',
            text: '/run',
            label: 'Run',
        }];
        autocompleteMockState.selected = 0;
        autocompleteMockState.respectQuery = true;
        const { AgentInput } = await import('./AgentInput');
        const onSend = vi.fn();
        const onChangeText = vi.fn();
        const liveText = `${'x'.repeat(210_000)} /r`;
        multiTextInputMockState.liveText = liveText;
        const screen = await renderScreen(React.createElement(AgentInput, {
            value: '',
            onChangeText,
            placeholder: 'p',
            onSend,
            autocompleteKinds: ['slashCommand'] as const,
            autocompleteSuggestions: async () => autocompleteMockState.suggestions,
            sessionId: 'session-a',
            metadata: null,
            disabled: false,
            showAbortButton: false,
        }));

        const input = findMultiTextInput(screen);
        await act(async () => {
            input.props.onFocus?.();
            input.props.onStateChange?.({
                text: liveText,
                selection: { start: liveText.length, end: liveText.length },
            });
        });

        expect(autocompleteMockState.lastQuery).toBe('/r');

        await act(async () => {
            expect(input.props.onKeyPress?.({
                key: 'Enter',
                inputState: {
                    text: liveText,
                    selection: { start: liveText.length, end: liveText.length },
                },
            })).toBe(true);
        });

        expect(onSend).not.toHaveBeenCalled();
        expect(onChangeText).toHaveBeenLastCalledWith(`${'x'.repeat(210_000)} /run`);
        await screen.unmount();
    });

    it('sends the flushed live input text when controlled props have not caught up', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onSend = vi.fn();
        const onChangeText = vi.fn();
        const liveText = 'x'.repeat(210_000);
        multiTextInputMockState.liveText = liveText;
        const screen = await renderScreen(React.createElement(AgentInput, {
            value: '',
            onChangeText,
            placeholder: 'p',
            onSend,
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            sessionId: 'session-a',
            metadata: null,
            disabled: false,
            showAbortButton: false,
        }));

        const input = findMultiTextInput(screen);
        await act(async () => {
            expect(input.props.onKeyPress?.({
                key: 'Enter',
                inputState: {
                    text: liveText,
                    selection: { start: liveText.length, end: liveText.length },
                },
            })).toBe(true);
        });

        expect(onChangeText).toHaveBeenCalledWith(liveText);
        expect(onSend).toHaveBeenCalledWith({ inputTextOverride: liveText });
        await screen.unmount();
    });

    it('carries the live new-session text in the send event even when controlled props match', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onSend = vi.fn();
        const onChangeText = vi.fn();
        const liveText = 'first prompt owned by the send event';
        multiTextInputMockState.liveText = liveText;
        const screen = await renderScreen(React.createElement(AgentInput, {
            value: liveText,
            onChangeText,
            placeholder: 'p',
            onSend,
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            metadata: null,
            disabled: false,
            showAbortButton: false,
        }));

        const input = findMultiTextInput(screen);
        await act(async () => {
            expect(input.props.onKeyPress?.({
                key: 'Enter',
                inputState: {
                    text: liveText,
                    selection: { start: liveText.length, end: liveText.length },
                },
            })).toBe(true);
        });

        expect(onSend).toHaveBeenCalledWith({ inputTextOverride: liveText });
        await screen.unmount();
    });

    it('restores the persisted selection at open', async () => {
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(React.createElement(AgentInput, {
            ...selectionRestoreBaseProps,
            value: 'Ask $review please',
            inputPersistence: {
                ...selectionRestorePersistence,
                restoreToken: 'session-a:scope:0:pending',
            },
        }));

        expect(multiTextInputMockState.appliedSelections).toEqual([{ start: 4, end: 11 }]);
        await screen.unmount();
    });

    it('never re-applies the persisted selection once the user has edited the draft', async () => {
        // The persisted value is whatever the input last reported, so it can be a
        // RANGE (double-tap, autocorrect, spell-check). Re-applying it after the
        // user types selects an existing word and the next keystroke replaces it,
        // silently corrupting the draft. A later restore generation — the basis
        // latch adopting after an async draft load, or a send-failure rollback —
        // must not resurrect it.
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(React.createElement(AgentInput, {
            ...selectionRestoreBaseProps,
            value: 'Ask $review please',
            inputPersistence: {
                ...selectionRestorePersistence,
                restoreToken: 'session-a:scope:0:pending',
            },
        }));

        const input = findMultiTextInput(screen);
        await act(async () => {
            input.props.onChangeText?.('Ask $review please and more');
        });

        await act(async () => {
            screen.tree.update(React.createElement(AgentInput, {
                ...selectionRestoreBaseProps,
                value: 'Ask $review please',
                inputPersistence: {
                    ...selectionRestorePersistence,
                    restoreToken: 'session-a:scope:0:adopted',
                },
            }));
        });

        expect(multiTextInputMockState.appliedSelections).toEqual([{ start: 4, end: 11 }]);
        await screen.unmount();
    });
});
