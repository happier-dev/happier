import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Platform: { select: (value: any) => value?.default ?? null },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('GitBranchSummary', () => {
    it('renders branch and staged/unstaged summary', async () => {
        const { GitBranchSummary } = await import('./GitBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <GitBranchSummary
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa' } }}
                    gitStatusFiles={{
                        branch: 'main',
                        stagedFiles: [],
                        unstagedFiles: [],
                        totalStaged: 2,
                        totalUnstaged: 3,
                    }}
                />
            );
        });

        const texts = tree!.root.findAllByType('Text' as any).map((node) => node.props.children);
        expect(texts).toContain('main');
    });

    it('renders upstream tracking and ahead/behind counters when available', async () => {
        const { GitBranchSummary } = await import('./GitBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <GitBranchSummary
                    theme={{ colors: { divider: '#000', text: '#fff', textSecondary: '#aaa' } }}
                    gitStatusFiles={{
                        branch: 'feature/refactor',
                        upstream: 'origin/feature/refactor',
                        ahead: 3,
                        behind: 1,
                        stagedFiles: [],
                        unstagedFiles: [],
                        totalStaged: 0,
                        totalUnstaged: 1,
                    }}
                />
            );
        });

        const textContent = tree!
            .root
            .findAllByType('Text' as any)
            .map((node) => {
                const value = node.props.children;
                if (Array.isArray(value)) {
                    return value.join('');
                }
                return String(value);
            });

        expect(textContent.some((text) => text.includes('origin/feature/refactor'))).toBe(true);
        expect(textContent.some((text) => text.includes('Ahead 3'))).toBe(true);
        expect(textContent.some((text) => text.includes('Behind 1'))).toBe(true);
    });
});
