import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installCodeBlockCommonModuleMocks } from './codeBlockTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installCodeBlockCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }));
vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => 1 }));

const flatten = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
};

describe('CodeBlockViewFrame marked lines', () => {
    it('draws a marked line on the failure band at that line, behind the code, and none when wrapped', async () => {
        const { CodeBlockViewFrame, CODE_BLOCK_LINE_HEIGHT } = await import('./CodeBlockViewFrame');
        const { useUnistyles } = await import('react-native-unistyles');
        const screen = await renderScreen(<CodeBlockViewFrame code={'40 a\n41 b\n42 c'} showHeaderRow={false} scrollTestID="excerpt" markedLines={[3]}>
            <React.Fragment>code</React.Fragment>
        </CodeBlockViewFrame>);
        const band = screen.findByTestId('excerpt-marked-3');
        expect(band).not.toBeNull();
        const style = flatten(band!.props.style);
        expect(style.top).toBe(2 * CODE_BLOCK_LINE_HEIGHT);
        expect(style.height).toBe(CODE_BLOCK_LINE_HEIGHT);
        expect(style.backgroundColor).toBe(useUnistyles().theme.colors.state.danger.background);
        // A wrapped block has no one-line rows to place a band on.
        const wrapped = await renderScreen(<CodeBlockViewFrame code={'40 a'} wrap showHeaderRow={false} scrollTestID="wrapped" markedLines={[1]}>
            <React.Fragment>code</React.Fragment>
        </CodeBlockViewFrame>);
        expect(wrapped.findByTestId('wrapped-marked-1')).toBeNull();
    }, 240_000);
});
