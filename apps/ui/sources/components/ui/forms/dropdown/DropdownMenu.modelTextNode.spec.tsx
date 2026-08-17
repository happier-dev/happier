import * as React from 'react';
import renderer from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderDropdownItemIcon } from '@/components/settings/pickers/renderDropdownItemIcon';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';
import { installDropdownCommonModuleMocks } from './dropdownTestHelpers';

const installDropdownReactNativeMock = async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Text: 'Text',
        TextInput: 'TextInput',
        Pressable: 'Pressable',
        ActivityIndicator: 'ActivityIndicator',
        Dimensions: {
            get: () => ({ width: 1280, height: 800, scale: 1, fontScale: 1 }),
        },
    });
};

const installDropdownModalMock = async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: vi.fn(),
            prompt: vi.fn(async () => null),
        },
    }).module;
};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

installDropdownCommonModuleMocks({
    reactNative: installDropdownReactNativeMock,
    modal: installDropdownModalMock,
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), eyebrow: () => ({}), keyHint: () => ({}) },
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: ({ children }: any) => (typeof children === 'function' ? children({ maxHeight: 320, maxWidth: 320 }) : children),
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('DropdownMenu model-style text node guard', () => {
    it('does not emit raw period text nodes under non-Text parents when a model-id dropdown is open', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');

        const items = [
            {
                id: '__refresh_models__',
                title: 'Refresh models',
                subtitle: 'Fetch the latest model list.',
                icon: renderDropdownItemIcon({ name: 'arrow-clockwise', color: '#999' }),
            },
            {
                id: 'default',
                title: 'Use CLI settings',
                icon: renderDropdownItemIcon({ name: 'stack-simple', color: '#999' }),
            },
            {
                id: '__custom__',
                title: 'Custom…',
                subtitle: 'Enter a model id',
                icon: renderDropdownItemIcon({ name: 'pencil-simple', color: '#999' }),
            },
        ];

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<DropdownMenu
                    open={true}
                    onOpenChange={() => {}}
                    items={items}
                    onSelect={() => {}}
                    search={true}
                    searchPlaceholder="Search models"
                    rowKind="item"
                    showCategoryTitles={false}
                    selectedId="gpt-5.3-codex-spark/medium"
                    itemTrigger={{
                        title: 'Voice agent chat model id',
                        subtitleFormatter: () => 'Used when the voice agent chat model source is set to Custom model.',
                        detailFormatter: () => 'gpt-5.3-codex-spark/medium',
                    }}
                />)).tree;

        expect(collectUnexpectedRawTextNodes(tree.toJSON())).toEqual([]);
    });

    it('opens its Item trigger exactly once with Enter or Space, then Escape closes without selecting a manifest', async () => {
        const { DropdownMenu } = await import('./DropdownMenu');
        const onSelect = vi.fn();
        const onOpenChange = vi.fn();

        function VoiceManifestSelect() {
            const [open, setOpen] = React.useState(false);
            return <DropdownMenu
                open={open}
                onOpenChange={(next) => {
                    onOpenChange(next);
                    setOpen(next);
                }}
                items={[
                    { id: 'default', title: 'Default manifest' },
                    { id: 'custom', title: 'Custom manifest' },
                ]}
                onSelect={onSelect}
                search
                itemTrigger={{
                    title: 'Voice manifest',
                    itemProps: { testID: 'voice-manifest-select' },
                }}
            />;
        }

        const screen = await renderScreen(<VoiceManifestSelect />);
        const trigger = () => screen.findByTestId('voice-manifest-select');
        const keyEvent = (key: string) => ({
            key,
            nativeEvent: { key },
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        });

        const enter = keyEvent('Enter');
        await act(async () => trigger()?.props.onKeyDown(enter));
        await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });

        expect(onOpenChange).toHaveBeenCalledTimes(1);
        expect(onOpenChange).toHaveBeenLastCalledWith(true);
        expect(enter.preventDefault).toHaveBeenCalledOnce();
        expect(onSelect).not.toHaveBeenCalled();

        const escape = keyEvent('Escape');
        await act(async () => {
            screen.findByType('TextInput' as any).props.onKeyPress(escape);
        });

        expect(onOpenChange).toHaveBeenCalledTimes(2);
        expect(onOpenChange).toHaveBeenLastCalledWith(false);
        expect(escape.preventDefault).toHaveBeenCalledOnce();
        expect(onSelect).not.toHaveBeenCalled();

        const space = keyEvent(' ');
        await act(async () => trigger()?.props.onKeyDown(space));
        await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });

        expect(onOpenChange).toHaveBeenCalledTimes(3);
        expect(onOpenChange).toHaveBeenLastCalledWith(true);
        expect(space.preventDefault).toHaveBeenCalledOnce();
        expect(onSelect).not.toHaveBeenCalled();
    });
});
