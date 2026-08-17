/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let backdropBlurEnabled = true;

function flattenRnStyle(style: any): React.CSSProperties | undefined {
    if (style == null) return undefined;
    if (Array.isArray(style)) {
        const merged: Record<string, unknown> = {};
        for (const entry of style) {
            const flattened = flattenRnStyle(entry);
            if (!flattened) continue;
            Object.assign(merged, flattened);
        }
        return merged as React.CSSProperties;
    }
    if (typeof style === 'object') {
        return style as React.CSSProperties;
    }
    return undefined;
}

function createFileDragEvent(type: string, files: readonly File[] = []): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
        configurable: true,
        value: {
            files,
            items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
            types: ['Files'],
        },
    });
    return event;
}

installAgentInputCommonModuleMocks({
    icons: async () => ({
        Ionicons: (props: any) => React.createElement('span', props),
        Octicons: (props: any) => React.createElement('span', props),
    }),
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
            View: React.forwardRef<HTMLDivElement, any>(function View(props, ref) {
                const {
                    accessibilityHint: _accessibilityHint,
                    accessibilityLabel: _accessibilityLabel,
                    accessibilityRole: _accessibilityRole,
                    accessibilityState: _accessibilityState,
                    children,
                    collapsable: _collapsable,
                    onLayout: _onLayout,
                    pointerEvents: _pointerEvents,
                    style,
                    testID,
                    ...rest
                } = props;
                return React.createElement(
                    'div',
                    {
                        ...rest,
                        ref,
                        style: flattenRnStyle(style),
                        'data-testid': testID,
                    },
                    children,
                );
            }),
            Text: React.forwardRef<HTMLSpanElement, any>(function Text(props, ref) {
                const {
                    accessibilityHint: _accessibilityHint,
                    accessibilityLabel: _accessibilityLabel,
                    accessibilityRole: _accessibilityRole,
                    accessibilityState: _accessibilityState,
                    children,
                    selectable: _selectable,
                    style,
                    testID,
                    ...rest
                } = props;
                return React.createElement(
                    'span',
                    {
                        ...rest,
                        ref,
                        style: flattenRnStyle(style),
                        'data-testid': testID,
                    },
                    children,
                );
            }),
            Pressable: React.forwardRef<HTMLButtonElement, any>(function Pressable(props, ref) {
                const {
                    accessibilityHint: _accessibilityHint,
                    accessibilityLabel,
                    accessibilityRole,
                    accessibilityState: _accessibilityState,
                    children,
                    hitSlop: _hitSlop,
                    onPress,
                    style,
                    testID,
                    ...rest
                } = props;
                return React.createElement(
                    'button',
                    {
                        ...rest,
                        ref,
                        type: 'button',
                        'aria-label': accessibilityLabel,
                        role: accessibilityRole,
                        onClick: onPress,
                        style: flattenRnStyle(style),
                        'data-testid': testID,
                    },
                    children,
                );
            }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
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
});

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: React.forwardRef(function MultiTextInput(props: Record<string, unknown>, ref) {
        React.useImperativeHandle(ref, () => ({
            blur: () => { },
            focus: () => { },
            setTextAndSelection: () => { },
        }), []);

        return React.createElement('textarea', {
            'data-testid': props.testID,
            placeholder: props.placeholder,
            readOnly: props.editable === false,
            value: props.value,
            onChange: () => { },
        });
    }),
}));

vi.mock('@/hooks/ui/useWebFileDropZone', async () => await import('@/hooks/ui/useWebFileDropZone.web'));

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
    getStorage: () => Object.assign(
        (selector: any) => selector({ sessionMessages: {} }),
        {
            getState: () => ({
                localSettings: {
                    uiContentWidthMode: 'comfortable',
                },
            }),
        },
    ),
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/store/hooks')>(),
    useLocalSetting: (key: string) => {
        if (key === 'uiBackdropBlurEnabled') return backdropBlurEnabled;
        return 1;
    },
    useSessionServerId: () => null,
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
}));

async function renderAgentInput(props: Readonly<{ onAttachmentsAdded: (files: readonly File[]) => void }>) {
    const { AgentInput } = await import('./AgentInput');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(React.createElement(AgentInput, {
            value: '',
            placeholder: 'placeholder',
            onChangeText: () => { },
            onSend: () => { },
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            onAttachmentsAdded: props.onAttachmentsAdded,
            hasSendableAttachments: false,
        }));
    });

    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="new-session-composer-input"]');
    if (!input) {
        throw new Error('expected new-session-composer-input to render');
    }

    const dropSurface = input.parentElement?.parentElement;
    if (!(dropSurface instanceof HTMLElement)) {
        throw new Error('expected composer drop surface to render');
    }

    return {
        container,
        dropSurface,
        root,
    };
}

describe('AgentInput (attachments drag overlay)', () => {
    it('does not apply web backdrop blur when the local backdrop blur setting is disabled', async () => {
        backdropBlurEnabled = false;
        const rendered = await renderAgentInput({ onAttachmentsAdded: () => { } });

        try {
            await act(async () => {
                rendered.dropSurface.dispatchEvent(createFileDragEvent('dragenter'));
            });

            const overlay = rendered.container.querySelector<HTMLElement>('[data-testid="agent-input-drop-overlay"]');
            expect(overlay).not.toBeNull();
            expect(overlay?.style.backdropFilter).toBeUndefined();
            expect(overlay?.style.backgroundColor).toBeTruthy();
            expect(overlay?.style.backgroundColor).not.toBe('rgba(0, 0, 0, 0.45)');
        } finally {
            backdropBlurEnabled = true;
            await act(async () => {
                rendered.root.unmount();
            });
            rendered.container.remove();
        }
    });

    it('renders a drop overlay when files are dragged over the composer panel', async () => {
        backdropBlurEnabled = true;
        const rendered = await renderAgentInput({ onAttachmentsAdded: () => { } });

        try {
            await act(async () => {
                rendered.dropSurface.dispatchEvent(createFileDragEvent('dragenter'));
            });

            const overlay = rendered.container.querySelector('[data-testid="agent-input-drop-overlay"]');
            expect(overlay).not.toBeNull();
            expect((overlay as HTMLElement).style.backdropFilter).toBe('blur(2px)');
            expect(((overlay as HTMLElement).style as CSSStyleDeclaration & { WebkitBackdropFilter?: string }).WebkitBackdropFilter).toBe('blur(2px)');
        } finally {
            await act(async () => {
                rendered.root.unmount();
            });
            rendered.container.remove();
        }
    });

    it('adds attachments when files are dropped on the composer panel outside the textarea', async () => {
        const onAttachmentsAdded = vi.fn();
        const rendered = await renderAgentInput({ onAttachmentsAdded });
        const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });

        try {
            await act(async () => {
                rendered.dropSurface.dispatchEvent(createFileDragEvent('dragenter', [file]));
                rendered.dropSurface.dispatchEvent(createFileDragEvent('dragover', [file]));
                rendered.dropSurface.dispatchEvent(createFileDragEvent('drop', [file]));
            });

            expect(onAttachmentsAdded).toHaveBeenCalledWith([file]);
        } finally {
            await act(async () => {
                rendered.root.unmount();
            });
            rendered.container.remove();
        }
    });

    it('uses DataTransfer item files when dropped FileList is empty', async () => {
        const onAttachmentsAdded = vi.fn();
        const rendered = await renderAgentInput({ onAttachmentsAdded });
        const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', {
            configurable: true,
            value: {
                files: [],
                items: [{ kind: 'file', getAsFile: () => file }],
                types: ['Files'],
            },
        });

        try {
            await act(async () => {
                rendered.dropSurface.dispatchEvent(event);
            });

            expect(onAttachmentsAdded).toHaveBeenCalledWith([file]);
        } finally {
            await act(async () => {
                rendered.root.unmount();
            });
            rendered.container.remove();
        }
    });
});
