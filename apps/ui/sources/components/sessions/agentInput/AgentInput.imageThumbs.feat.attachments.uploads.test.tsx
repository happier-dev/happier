import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalShowSpy = vi.fn((config: unknown) => {
    void config;
    return 'modal-1';
});

vi.mock('react-native', async () => {
    const actual = await import('@/dev/reactNativeStub');
    return {
        ...actual,
        TurboModuleRegistry: {
            ...(actual.TurboModuleRegistry ?? null),
            get: () => ({}),
            getEnforcing: () => ({}),
        },
        Platform: {
            OS: 'web',
            select: (x: any) => x?.web ?? x?.default ?? x?.ios ?? x?.android ?? null,
        },
        useWindowDimensions: () => ({ width: 800, height: 600 }),
        Dimensions: {
            get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
        },
    };
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => React.createElement('MultiTextInput', props, null),
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => { },
    hapticsError: () => { },
}));

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/modal', () => ({
    Modal: {
        show: (config: unknown) => modalShowSpy(config),
        alert: vi.fn(),
        confirm: vi.fn(),
        prompt: vi.fn(),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

const featureEnabledState: Record<string, boolean> = { voice: false };

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] === true,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    return {
        ...actual,
    useSetting: (key: string) => {
        if (key === 'profiles') return [];
        if (key === 'agentInputEnterToSend') return true;
        if (key === 'agentInputActionBarLayout') return 'wrap';
        if (key === 'agentInputChipDensity') return 'labels';
        if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
        return null;
    },
    useSessionMessages: () => ({ messages: [], isLoaded: true }),
    useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
    useSessionMessagesById: () => ({}),
    useSessionMessagesVersion: () => 0,
    useSessionMessagesReducerState: () => null,
    };
});

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => (selector: any) => selector({ sessionMessages: {} }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    resolveAgentIdFromFlavorNoDefault: () => null,
    getAgentCore: () => ({
        displayNameKey: 'agents.codex',
        toolRendering: { hideUnknownToolsByDefault: false },
        model: { supportsSelection: false, allowedModes: [] },
        permissions: { modeGroup: 'codexLike' },
        sessionModes: { kind: 'legacy' },
    }),
}));

describe('AgentInput (image attachment thumbnails)', () => {
    it('opens a larger preview when an image thumbnail is pressed', async () => {
        const { AgentInput } = await import('./AgentInput');
        const attachments = [
            {
                key: 'a1',
                label: 'file.png',
                status: 'pending',
                preview: { kind: 'image', uri: 'blob:test' },
                onRemove: () => { },
            },
            {
                key: 'a2',
                label: 'second.png',
                status: 'pending',
                preview: { kind: 'image', uri: 'blob:second' },
                onRemove: () => { },
            },
        ] as any;

        modalShowSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(React.createElement(AgentInput, {
                value: '',
                placeholder: 'placeholder',
                onChangeText: () => { },
                onSend: () => { },
                autocompletePrefixes: [],
                autocompleteSuggestions: async () => [],
                attachments,
                hasSendableAttachments: true,
            }));
        });

        const thumbnail = tree!.root.findByProps({ testID: 'agent-input-attachment-image:a1' });
        expect(typeof thumbnail.props.onPress).toBe('function');

        act(() => {
            thumbnail.props.onPress();
        });

        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        const modalConfig = (modalShowSpy.mock.calls[0]?.[0] ?? null) as null | {
            component?: unknown;
            props?: Readonly<{
                images?: ReadonlyArray<Readonly<{ uri: string; title: string }>>;
                initialIndex?: number;
            }>;
        };
        expect(modalConfig?.component).toBeDefined();
        expect(modalConfig?.props).toEqual(expect.objectContaining({
            initialIndex: 0,
            images: [
                { kind: 'direct', uri: 'blob:test', title: 'file.png' },
                { kind: 'direct', uri: 'blob:second', title: 'second.png' },
            ],
        }));
    }, 120_000);

    it('renders a thumbnail tile for image attachments', async () => {
        const { AgentInput } = await import('./AgentInput');
        const attachments = [
            {
                key: 'a1',
                label: 'file.png',
                status: 'pending',
                preview: { kind: 'image', uri: 'blob:test' },
                onRemove: () => { },
            },
        ] as any;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(React.createElement(AgentInput, {
                value: '',
                placeholder: 'placeholder',
                onChangeText: () => { },
                onSend: () => { },
                autocompletePrefixes: [],
                autocompleteSuggestions: async () => [],
                attachments,
                hasSendableAttachments: true,
            }));
        });

        expect(() => tree!.root.findByProps({ testID: 'agent-input-attachment-image:a1' })).not.toThrow();
    });

    it('uses button accessibility semantics for attachment image thumbnails', async () => {
        const { AgentInput } = await import('./AgentInput');
        const attachments = [
            {
                key: 'a1',
                label: 'file.png',
                status: 'pending',
                preview: { kind: 'image', uri: 'blob:test' },
                onRemove: () => { },
            },
        ] as any;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(React.createElement(AgentInput, {
                value: '',
                placeholder: 'placeholder',
                onChangeText: () => { },
                onSend: () => { },
                autocompletePrefixes: [],
                autocompleteSuggestions: async () => [],
                attachments,
                hasSendableAttachments: true,
            }));
        });

        expect(tree!.root.findByProps({ testID: 'agent-input-attachment-image:a1' }).props.accessibilityRole).toBe('button');
    });

    it('disables image remove while uploading', async () => {
        const { AgentInput } = await import('./AgentInput');
        const attachments = [
            {
                key: 'a1',
                label: 'file.png',
                status: 'uploading',
                preview: { kind: 'image', uri: 'blob:test' },
                onRemove: () => { },
            },
        ] as any;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(React.createElement(AgentInput, {
                value: '',
                placeholder: 'placeholder',
                onChangeText: () => { },
                onSend: () => { },
                autocompletePrefixes: [],
                autocompleteSuggestions: async () => [],
                attachments,
                hasSendableAttachments: true,
            }));
        });

        const removeButton = tree!.root.findByProps({ testID: 'agent-input-attachment-remove:a1' });
        expect(removeButton.props.disabled).toBe(true);
    });
});
