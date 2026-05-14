import * as React from 'react';
import renderer from 'react-test-renderer';
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
                icon: renderDropdownItemIcon({ name: 'refresh-outline', color: '#999' }),
            },
            {
                id: 'default',
                title: 'Use CLI settings',
                icon: renderDropdownItemIcon({ name: 'layers-outline', color: '#999' }),
            },
            {
                id: '__custom__',
                title: 'Custom…',
                subtitle: 'Enter a model id',
                icon: renderDropdownItemIcon({ name: 'create-outline', color: '#999' }),
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
});
