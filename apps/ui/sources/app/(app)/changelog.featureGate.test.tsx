import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mmkvAccess = vi.hoisted(() => ({
    getNumber: vi.fn((..._args: unknown[]) => {
        throw new Error('MMKV.getNumber should not be called when changelog UI is disabled');
    }),
    set: vi.fn((..._args: unknown[]) => {
        throw new Error('MMKV.set should not be called when changelog UI is disabled');
    }),
}));

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getNumber(...args: any[]) {
            return mmkvAccess.getNumber(...args);
        }
        set(...args: any[]) {
            return mmkvAccess.set(...args);
        }
    }

    return { MMKV };
});

vi.mock('react-native', () => ({
    View: (props: any) => React.createElement('View', props, props.children),
    Text: (props: any) => React.createElement('Text', props, props.children),
    ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => {
            const theme = {
                colors: {
                    surface: '#fff',
                    surfaceHigh: '#fff',
                    text: '#000',
                    textSecondary: '#666',
                    textLink: '#00f',
                },
            };
            const runtime = {};
            return typeof styles === 'function' ? styles(theme, runtime) : styles;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#fff',
                text: '#000',
                textSecondary: '#666',
                textLink: '#00f',
            },
        },
    }),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: 'MarkdownView',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('ChangelogScreen (feature gate)', () => {
    const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;

    beforeEach(() => {
        vi.resetModules();
        mmkvAccess.getNumber.mockClear();
        mmkvAccess.set.mockClear();
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.changelog';
    });

    afterEach(() => {
        if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
    });

    it('returns null when disabled by build policy', async () => {
        const mod = await import('./changelog');
        const ChangelogScreen = mod.default;

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ChangelogScreen));
        });

        expect(tree.toJSON()).toBeNull();
    });
});
