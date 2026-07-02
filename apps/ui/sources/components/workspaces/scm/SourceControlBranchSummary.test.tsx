import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';

import { installSessionFilesCommonModuleMocks } from '@/components/sessions/files/sessionFilesTestHelpers';


// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const octiconsRenderMock = vi.hoisted(() => vi.fn());

function buildBranchSummaryTheme() {
    return {
        colors: {
            border: { default: '#000' },
            input: { background: '#111' },
            surface: { base: '#111', inset: '#222' },
            text: { primary: '#fff', secondary: '#aaa' },
            textLink: '#0af',
        },
    };
}

installSessionFilesCommonModuleMocks({
    icons: () => ({
        Octicons: (props: any) => {
            octiconsRenderMock(props.name);
            return React.createElement('Octicons', props);
        },
        Ionicons: 'Ionicons',
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                select: (value: any) => value?.default ?? null,
            },
        });
    },
});

describe('SourceControlBranchSummary', () => {
    it('skips rendering counters when parent rerenders with unchanged summary props', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        const scmStatusFiles = {
            branch: 'feature/refactor',
            upstream: 'origin/feature/refactor',
            ahead: 3,
            behind: 1,
            includedFiles: [],
            pendingFiles: [],
            totalIncluded: 2,
            totalPending: 3,
        };

        function Wrapper(props: Readonly<{ tick: number }>) {
            void props.tick;
            const theme = buildBranchSummaryTheme();
            return <SourceControlBranchSummary theme={theme} scmStatusFiles={scmStatusFiles} variant="rail" />;
        }

        octiconsRenderMock.mockClear();
        const screen = await renderScreen(<Wrapper tick={0} />);
        const initialIconRenderCount = octiconsRenderMock.mock.calls.length;

        await act(async () => {
            screen.tree.update(<Wrapper tick={1} />);
        });

        expect(octiconsRenderMock).toHaveBeenCalledTimes(initialIconRenderCount);
    });

    it('renders a provided branch trigger in rail mode', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SourceControlBranchSummary
                    variant="rail"
                    theme={buildBranchSummaryTheme()}
                    branchTrigger={React.createElement('BranchTrigger', { testID: 'branch-trigger' })}
                    scmStatusFiles={{
                        branch: 'dev',
                        includedFiles: [],
                        pendingFiles: [],
                        totalIncluded: 0,
                        totalPending: 0,
                    }}
                />)).tree;

        const branchTriggers = tree!.findAllByType('BranchTrigger' as any);
        expect(branchTriggers).toHaveLength(1);
    });

    it('renders branch and staged/unstaged summary', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SourceControlBranchSummary
                    theme={buildBranchSummaryTheme()}
                    scmStatusFiles={{
                        branch: 'main',
                        includedFiles: [],
                        pendingFiles: [],
                        totalIncluded: 2,
                        totalPending: 3,
                    }}
                />)).tree;

        const texts = tree!.findAllByType('Text' as any).map((node) => node.props.children);
        expect(texts).toContain('main');
        expect(texts).toContain('files.branchSummary.staged');
        expect(texts).toContain('files.branchSummary.unstaged');
    });

    it('renders upstream tracking and ahead/behind counters when available', async () => {
        const { SourceControlBranchSummary } = await import('./SourceControlBranchSummary');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SourceControlBranchSummary
                    theme={buildBranchSummaryTheme()}
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
                />)).tree;

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
        tree = (await renderScreen(<SourceControlBranchSummary
                    theme={buildBranchSummaryTheme()}
                    scmStatusFiles={{
                        branch: 'main',
                        changeSetModel: 'working-copy',
                        includedFiles: [],
                        pendingFiles: [],
                        totalIncluded: 0,
                        totalPending: 1,
                    }}
                />)).tree;

        const texts = tree!.findAllByType('Text' as any).map((node) => node.props.children);
        expect(texts).toContain('files.branchSummary.included');
        expect(texts).toContain('files.branchSummary.pending');
        expect(texts).not.toContain('files.branchSummary.staged');
        expect(texts).not.toContain('files.branchSummary.unstaged');
    });
});
