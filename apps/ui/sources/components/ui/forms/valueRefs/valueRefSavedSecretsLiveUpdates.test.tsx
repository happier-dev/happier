import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { installValueRefsCommonModuleMocks } from '@/components/ui/forms/valueRefs/valueRefsTestHelpers';
import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';


(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let liveSecrets: SavedSecret[] = [];
const liveSecretListeners = new Set<() => void>();
const modalShowSpy = vi.hoisted(() => vi.fn());

function updateLiveSecrets(next: SavedSecret[]) {
    liveSecrets = next;
    for (const listener of liveSecretListeners) {
        listener();
    }
}

function resetLiveSecrets() {
    liveSecrets = [];
    liveSecretListeners.clear();
}

installValueRefsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: modalShowSpy,
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const { createPassThroughComponent } = await import('@/dev/testkit/mocks/components');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: <T,>(obj: { ios?: T; web?: T; default?: T }) => obj.ios ?? obj.web ?? obj.default,
            },
            Pressable: createPassThroughComponent('Pressable'),
            Text: createPassThroughComponent('Text'),
            View: createPassThroughComponent('View'),
            TextInput: React.forwardRef<{ focus: () => void }, Record<string, unknown>>((props, ref) => {
                if (ref && typeof ref === 'object') {
                    ref.current = { focus: () => {} };
                }
                return React.createElement('TextInput', props);
            }),
        });
    },
    storage: async (_importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettingMutable: ((name: string) => {
                if (name !== 'secrets') {
                    throw new Error(`Unexpected setting key in test: ${name}`);
                }

                const ReactModule = require('react') as typeof React;
                const [, forceUpdate] = ReactModule.useReducer((value: number) => value + 1, 0);

                ReactModule.useEffect(() => {
                    const listener = () => forceUpdate();
                    liveSecretListeners.add(listener);
                    return () => {
                        liveSecretListeners.delete(listener);
                    };
                }, []);

                return [liveSecrets, updateLiveSecrets] as const;
            }) as typeof import('@/sync/domains/state/storage').useSettingMutable,
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    ...createPassThroughModule(['Text', 'TextInput']),
}));

vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));

vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));

vi.mock('@/components/ui/lists/ItemRowActions', () => createPassThroughModule(['ItemRowActions']));

vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));

vi.mock('@/components/ui/forms/InlineAddExpander', () => ({
    InlineAddExpander: ({
        children,
        isOpen,
        onOpenChange,
        title,
        saveDisabled,
        onSave,
    }: {
        children?: React.ReactNode;
        isOpen: boolean;
        onOpenChange: (next: boolean) => void;
        title: string;
        saveDisabled?: boolean;
        onSave?: () => void;
    }) => React.createElement(
        React.Fragment,
        null,
        React.createElement('Item', {
            title,
            onPress: () => onOpenChange(!isOpen),
        }),
        isOpen ? React.createElement(
            'View',
            null,
            children,
            React.createElement('Pressable', {
                accessibilityLabel: 'common.save',
                disabled: saveDisabled,
                onPress: onSave,
            }),
        ) : null,
    ),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => createPassThroughModule(['DropdownMenu']));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

describe('value ref saved secrets live updates', () => {
    beforeEach(() => {
        resetLiveSecrets();
    });

    afterEach(() => {
        vi.clearAllMocks();
        resetLiveSecrets();
    });

    it('SavedSecretPickerModal reflects secrets added after the modal opens', async () => {
        const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');

        const screen = await renderScreen(React.createElement(SavedSecretPickerModal, {
                    onClose: vi.fn(),
                    selectedId: null,
                    onSelectId: vi.fn(),
                }));

        expect(findTestInstanceByTypeWithProps(screen.tree, 'Item', { title: 'secrets.emptyTitle' })).toBeTruthy();
        expect(findTestInstanceByTypeWithProps(screen.tree, 'Item', { title: 'qa_picker_live_modal' })).toBeUndefined();

        await act(async () => {
            updateLiveSecrets([{
                id: 'secret-live',
                name: 'qa_picker_live_modal',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'secret-value' },
                createdAt: 1,
                updatedAt: 1,
            }]);
        });

        expect(findTestInstanceByTypeWithProps(screen.tree, 'Item', { title: 'secrets.emptyTitle' })).toBeUndefined();
        expect(findTestInstanceByTypeWithProps(screen.tree, 'Item', { title: 'qa_picker_live_modal' })).toBeTruthy();
    });

    it('ValueRefEditorModal resolves saved-secret names from the live secrets store', async () => {
        const { ValueRefEditorModal } = await import('./ValueRefEditorModal');

        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
                    onClose: vi.fn(),
                    kind: 'header',
                    initialKey: 'Authorization',
                    initialValueRef: { t: 'savedSecret', secretId: 'secret-live' },
                    secrets: [],
                    onChangeSecrets: vi.fn(),
                    onSubmit: () => true,
                }));

        expect(screen.findByTestId('mcp.valueRefEditor.secret')?.props.title).toBe('settings.mcpServersValueSecretSelect');
        expect(screen.findByTestId('mcp.valueRefEditor.secret')?.props.subtitle).toBe('secret-live');

        await act(async () => {
            updateLiveSecrets([{
                id: 'secret-live',
                name: 'qa_value_ref_live_secret',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'secret-value' },
                createdAt: 1,
                updatedAt: 1,
            }]);
        });

        expect(screen.findByTestId('mcp.valueRefEditor.secret')?.props.title).toBe('qa_value_ref_live_secret');
        expect(screen.findByTestId('mcp.valueRefEditor.secret')?.props.subtitle).toBe('secret-live');
    });

    it('ValueRefEditorModal opens the saved-secret picker with shared chrome', async () => {
        const { ValueRefEditorModal } = await import('./ValueRefEditorModal');
        const { SavedSecretPickerModal } = await import('./SavedSecretPickerModal');

        const screen = await renderScreen(React.createElement(ValueRefEditorModal, {
                    onClose: vi.fn(),
                    kind: 'header',
                    initialKey: 'Authorization',
                    initialValueRef: { t: 'literal', v: 'token' },
                    secrets: [],
                    onChangeSecrets: vi.fn(),
                    onSubmit: () => true,
                }));

        const dropdownMenu = screen.findByType('DropdownMenu' as any);

        await act(async () => {
            dropdownMenu.props.onSelect('savedSecret');
        });

        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        expect(modalShowSpy.mock.calls[0]?.[0]).toMatchObject({
            component: SavedSecretPickerModal,
            chrome: {
                kind: 'card',
                title: 'settings.mcpServersPickSecretTitle',
                dimensions: { size: 'lg' },
            },
            closeOnBackdrop: true,
        });
    });
});
