import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installCodeBlockCommonModuleMocks } from './codeBlockTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installCodeBlockCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        // A distinctive part radius proves the frame reads the theme's code block token.
        return createUnistylesMock({ theme: { parts: { codeBlock: { radius: 37 } } } });
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }));
vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => 1 }));

describe('CodeBlockViewFrame part radius', () => {
    it('rounds the frame with the theme code block radius', async () => {
        const { CodeBlockViewFrame } = await import('./CodeBlockViewFrame');
        const { useUnistyles } = await import('react-native-unistyles');
        const { glassSurfaceBackgroundColor } = await import('@/components/ui/glass/glassSurfacePaint');

        const screen = await renderScreen(<CodeBlockViewFrame code={'x'} language={null} wrap={false} showCopyButton={false}>
                    <React.Fragment>child</React.Fragment>
                </CodeBlockViewFrame>);

        const flatten = (style: unknown): Record<string, unknown> => {
            if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
            return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
        };
        const rounded = screen.tree.root.findAll((node) => typeof node.type === 'string' && flatten(node.props?.style).borderRadius === 37);
        expect(rounded.length).toBeGreaterThan(0);
        const { theme } = useUnistyles();
        expect(flatten(rounded[0].props.style).backgroundColor).toBe(glassSurfaceBackgroundColor(theme.colors.surface.inset, 'content', true));
        expect(flatten(rounded[0].props.style).opacity).toBeUndefined();
    });
});
