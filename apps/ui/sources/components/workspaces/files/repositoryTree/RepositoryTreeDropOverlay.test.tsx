import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installRepositoryTreeCommonModuleMocks } from './repositoryTreeTestHelpers';

const localSettingState = vi.hoisted(() => ({
    uiBackdropBlurEnabled: true,
}));

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (name: string) => {
        if (name === 'uiBackdropBlurEnabled') {
            return localSettingState.uiBackdropBlurEnabled;
        }
        return null;
    },
}));

installRepositoryTreeCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (value: any) => value?.web ?? value?.default ?? null,
            },
        });
    },
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (style == null) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, value) => {
            return {
                ...acc,
                ...flattenStyle(value),
            };
        }, {});
    }
    if (typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('RepositoryTreeDropOverlay', () => {
    it('applies web blur styling when backdrop blur is enabled', async () => {
        localSettingState.uiBackdropBlurEnabled = true;
        const { RepositoryTreeDropOverlay } = await import('./RepositoryTreeDropOverlay');
        const screen = await renderScreen(<RepositoryTreeDropOverlay visible destinationLabel="src" />);

        const viewNodes = screen.findAllByType('View' as any);
        const contentNode = viewNodes.find((node) => {
            const style = flattenStyle(node.props.style);
            return style.backdropFilter === 'blur(6px)';
        });
        expect(contentNode).toBeTruthy();
        expect(flattenStyle(contentNode?.props.style).backgroundColor).toBe('#F8F8F8');
    });

    it('removes web blur styling when backdrop blur is disabled', async () => {
        localSettingState.uiBackdropBlurEnabled = false;
        const { RepositoryTreeDropOverlay } = await import('./RepositoryTreeDropOverlay');
        const screen = await renderScreen(<RepositoryTreeDropOverlay visible destinationLabel="src" />);

        const viewNodes = screen.findAllByType('View' as any);
        const contentNode = viewNodes.find((node) => {
            const style = flattenStyle(node.props.style);
            return style.backdropFilter === 'blur(6px)';
        });
        expect(contentNode).toBeUndefined();
        const contentWithoutBlur = viewNodes.find((node) => {
            const style = flattenStyle(node.props.style);
            return style.paddingHorizontal === 14 && style.paddingVertical === 10;
        });
        expect(flattenStyle(contentWithoutBlur?.props.style).backgroundColor).toBe('#f0f0f0');
        localSettingState.uiBackdropBlurEnabled = true;
    });
});
