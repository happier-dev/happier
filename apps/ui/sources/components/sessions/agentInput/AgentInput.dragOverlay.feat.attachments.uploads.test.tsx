import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createStoreHooksModuleMock, renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastMultiTextInputProps: any = null;
let backdropBlurEnabled = true;

type StoreHooksModule = typeof import('@/sync/store/hooks');

function flattenStyle(style: unknown): Record<string, unknown> {
    if (style == null) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, value) => ({
            ...acc,
            ...flattenStyle(value),
        }), {});
    }
    if (typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            TurboModuleRegistry: {
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
        });
    },
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
                return null;
            },
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => null,
        });
    },
    storeHooks: (importOriginal) =>
        createStoreHooksModuleMock({
            importOriginal,
            overrides: {
                useLocalSetting: ((key) => {
                    if (key === 'uiBackdropBlurEnabled') return backdropBlurEnabled;
                    return 1;
                }) as StoreHooksModule['useLocalSetting'],
                useSessionServerId: () => null,
            },
        }),
});

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => {
        lastMultiTextInputProps = props;
        return React.createElement('MultiTextInput', props, null);
    },
}));

vi.mock('@/hooks/ui/useWebFileDropZone', async () => {
    return await import('@/hooks/ui/useWebFileDropZone.web');
});

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


vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => (selector: any) => selector({ sessionMessages: {} }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSvgXml: () => null,
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => undefined,
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
    getAgentBehavior: (agentId: string) => ({
        sessionUsage: {
            supportsExactContextUsageBadge: agentId !== 'codex' && agentId !== 'gemini',
        },
    }),
}));

async function activatePanelDropZone(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const { WebDropTargetView } = await import('@/components/sessions/files/repositoryTree/WebDropTargetView');
    const dropTarget = screen.findByType(WebDropTargetView as any);
    await act(async () => {
        dropTarget.props.onDragEnter({
            dataTransfer: { types: ['Files'] },
        });
    });
    return dropTarget;
}

describe('AgentInput (attachments drag overlay)', () => {
    it('does not apply backdrop blur when the local backdrop blur appearance setting is disabled', async () => {
        backdropBlurEnabled = false;
        const { AgentInput } = await import('./AgentInput');

        lastMultiTextInputProps = null;

        const screen = await renderScreen(React.createElement(AgentInput, {
            value: '',
            placeholder: 'placeholder',
            onChangeText: () => { },
            onSend: () => { },
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            onAttachmentsAdded: () => { },
            hasSendableAttachments: false,
        }));

        await activatePanelDropZone(screen);

        const overlay = screen.findByTestId('agent-input-drop-overlay');
        const overlayStyle = flattenStyle(overlay?.props.style);
        expect(overlayStyle.backdropFilter).toBeUndefined();
        expect(overlayStyle.WebkitBackdropFilter).toBeUndefined();
        expect(typeof overlayStyle.backgroundColor).toBe('string');
        backdropBlurEnabled = true;
    }, 120_000);

    it('renders a drop overlay when files are dragged over the input', async () => {
        backdropBlurEnabled = true;
        const { AgentInput } = await import('./AgentInput');

        lastMultiTextInputProps = null;

        const screen = await renderScreen(React.createElement(AgentInput, {
            value: '',
            placeholder: 'placeholder',
            onChangeText: () => { },
            onSend: () => { },
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            onAttachmentsAdded: () => { },
            hasSendableAttachments: false,
        }));

        expect(lastMultiTextInputProps).not.toBeNull();

        await activatePanelDropZone(screen);

        const overlay = screen.findByTestId('agent-input-drop-overlay');
        if (!overlay) {
            throw new Error('expected agent-input-drop-overlay to render');
        }
        expect(overlay.props.pointerEvents).toBe('none');
        const overlayStyle = flattenStyle(overlay.props.style);
        expect(overlayStyle.backdropFilter).toBe('blur(2px)');
        expect(overlayStyle.WebkitBackdropFilter).toBe('blur(2px)');
    }, 120_000);

    it('accepts dropped files from the full composer panel', async () => {
        backdropBlurEnabled = true;
        const { AgentInput } = await import('./AgentInput');
        const { WebDropTargetView } = await import('@/components/sessions/files/repositoryTree/WebDropTargetView');
        const onAttachmentsAdded = vi.fn();
        const file = {
            name: 'notes.txt',
            size: 12,
            type: 'text/plain',
            lastModified: 1,
        } as File;

        const screen = await renderScreen(React.createElement(AgentInput, {
            value: '',
            placeholder: 'placeholder',
            onChangeText: () => { },
            onSend: () => { },
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            onAttachmentsAdded,
            hasSendableAttachments: false,
            attachments: [{
                key: 'existing',
                label: 'existing.txt',
                onRemove: () => { },
            }],
        }));

        const dropTarget = screen.findByType(WebDropTargetView as any);
        expect(dropTarget.props.testID).toBe('agent-input-drop-zone');

        await act(async () => {
            dropTarget.props.onDragEnter({
                dataTransfer: { types: ['Files'] },
            });
        });

        expect(screen.findByTestId('agent-input-drop-overlay')).toBeTruthy();

        await act(async () => {
            dropTarget.props.onDrop({
                preventDefault: vi.fn(),
                dataTransfer: {
                    types: ['Files'],
                    files: [file],
                },
            });
        });

        expect(onAttachmentsAdded).toHaveBeenCalledWith([file]);
    }, 120_000);
});
