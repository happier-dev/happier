import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastMultiTextInputProps: any = null;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
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

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            surface: '#fff',
            surfaceSelected: '#f2f2f2',
            surfacePressed: '#eee',
            divider: '#ddd',
            text: '#000',
            textSecondary: '#666',
            groupped: { sectionTitle: '#666', background: '#fff' },
            header: { background: '#fff', tint: '#000' },
            button: {
                primary: { background: '#000', tint: '#fff', disabled: '#999' },
                secondary: { tint: '#000', surface: '#fff' },
            },
            shadow: { color: '#000', opacity: 0.2 },
            modal: { border: '#ddd' },
            switch: { track: { inactive: '#ccc', active: '#4ade80' }, thumb: { active: '#fff' } },
            input: { background: '#eee', text: '#000' },
            status: { error: '#ff3b30' },
            box: { error: { background: '#fee', border: '#f99', text: '#900' } },
            radio: { active: '#000', inactive: '#ddd', dot: '#000' },
            success: '#0a0',
            textDestructive: '#a00',
            permission: {
                acceptEdits: '#0a0',
                bypass: '#f90',
                plan: '#09f',
                readOnly: '#999',
                safeYolo: '#0af',
                yolo: '#f0a',
            },
            permissionButton: {
                allow: { background: '#0f0' },
                deny: { background: '#f00' },
                allowAll: { background: '#00f' },
            },
        },
    };

    return {
        StyleSheet: {
            create: (styles: any) => (typeof styles === 'function' ? styles(theme, {}) : styles),
            configure: () => { },
        },
        useUnistyles: () => ({ theme }),
    };
});

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => {
        lastMultiTextInputProps = props;
        return React.createElement('MultiTextInput', props, null);
    },
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'profiles') return [];
        if (key === 'agentInputEnterToSend') return true;
        if (key === 'agentInputActionBarLayout') return 'wrap';
        if (key === 'agentInputChipDensity') return 'labels';
        if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
        return null;
    },
    useSessionMessages: () => ({ messages: [], isLoaded: true }),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => (selector: any) => selector({ sessionMessages: {} }),
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

describe('AgentInput (attachments drag overlay)', () => {
    it('renders a drop overlay when files are dragged over the input', async () => {
        const { AgentInput } = await import('./AgentInput');

        lastMultiTextInputProps = null;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(AgentInput, {
                    value: '',
                    placeholder: 'placeholder',
                    onChangeText: () => { },
                    onSend: () => { },
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    onAttachmentsAdded: () => { },
                    hasSendableAttachments: false,
                }),
            );
        });

        expect(lastMultiTextInputProps).not.toBeNull();

        await act(async () => {
            lastMultiTextInputProps?.onFileDragActiveChange?.(true);
        });

        const overlay = tree!.root.findByProps({ testID: 'agent-input-drop-overlay' });
        expect(overlay.props.pointerEvents).toBe('none');
    });
});
