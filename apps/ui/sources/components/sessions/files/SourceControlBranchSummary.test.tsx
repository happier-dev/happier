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

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('SourceControlBranchSummary', () => {
    it('renders branch and staged/unstaged summary', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlBranchSummary
                    theme={{
                        colors: {
                            divider: '#000',
                            input: { background: '#111' },
                            surfaceHigh: '#222',
                            text: '#fff',
                            textSecondary: '#aaa',
                        },
                    }}
                    scmStatusFiles={{
                        branch: 'main',
                        includedFiles: [],
                        pendingFiles: [],
                        totalIncluded: 2,
                        totalPending: 3,
                    }}
                />
            );
        });

        const texts = tree!.root.findAllByType('Text' as any).map((node) => node.props.children);
        expect(texts).toContain('main');
        expect(texts).toContain('files.branchSummary.staged');
        expect(texts).toContain('files.branchSummary.unstaged');
    });

    it('renders upstream tracking and ahead/behind counters when available', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlBranchSummary
                    theme={{
                        colors: {
                            divider: '#000',
                            input: { background: '#111' },
                            surfaceHigh: '#222',
                            text: '#fff',
                            textSecondary: '#aaa',
                        },
                    }}
                    scmStatusFiles={{
                        branch: 'feature/refactor',
                        upstream: 'origin/feature/refactor',
                        ahead: 3,
                        behind: 1,
                        includedFiles: [],
                        pendingFiles: [],
                        totalIncluded: 0,
                        totalPending: 1,
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

        expect(textContent.some((text) => text.includes('files.branchSummary.upstreamLabel'))).toBe(true);
        expect(textContent.some((text) => text.includes('files.branchSummary.ahead'))).toBe(true);
        expect(textContent.some((text) => text.includes('files.branchSummary.behind'))).toBe(true);
    });

    it('renders included/pending labels for working-copy change set model', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlBranchSummary
                    theme={{
                        colors: {
                            divider: '#000',
                            input: { background: '#111' },
                            surfaceHigh: '#222',
                            text: '#fff',
                            textSecondary: '#aaa',
                        },
                    }}
                    scmStatusFiles={{
                        branch: 'main',
                        changeSetModel: 'working-copy',
                        includedFiles: [],
                        pendingFiles: [],
                        totalIncluded: 0,
                        totalPending: 1,
                    }}
                />
            );
        });

        const texts = tree!.root.findAllByType('Text' as any).map((node) => node.props.children);
        expect(texts).toContain('files.branchSummary.included');
        expect(texts).toContain('files.branchSummary.pending');
        expect(texts).not.toContain('files.branchSummary.staged');
        expect(texts).not.toContain('files.branchSummary.unstaged');
    });
});
