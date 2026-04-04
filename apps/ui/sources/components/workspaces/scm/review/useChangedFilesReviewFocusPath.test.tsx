import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useChangedFilesReviewFocusPath } from './useChangedFilesReviewFocusPath';
import { flushHookEffects, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(props: Readonly<{
    focusPath: string | null;
    reviewFiles: readonly ScmFileStatus[];
    expandPath: (path: string) => void;
    scrollToPath: (path: string) => void;
}>) {
    useChangedFilesReviewFocusPath({
        focusPath: props.focusPath,
        reviewFiles: props.reviewFiles,
        expandPath: props.expandPath,
        scrollToPath: props.scrollToPath,
    });
    return React.createElement('Harness');
}

describe('useChangedFilesReviewFocusPath', () => {
    it('applies focus scrolling only once per focusPath value even if the file list identity changes', async () => {
        vi.useFakeTimers();
        const expandPath = vi.fn();
        const scrollToPath = vi.fn();

        const file = { fullPath: 'src/a.ts' } as any as ScmFileStatus;

        const screen = await renderScreen(<Harness focusPath="src/a.ts" reviewFiles={[file]} expandPath={expandPath} scrollToPath={scrollToPath} />);
        const tree: Awaited<ReturnType<typeof renderScreen>>['tree'] = screen.tree;

        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 60 });

        expect(expandPath).toHaveBeenCalledTimes(1);
        expect(scrollToPath).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree.update(
                <Harness
                    focusPath="src/a.ts"
                    reviewFiles={[{ ...file }]}
                    expandPath={expandPath}
                    scrollToPath={scrollToPath}
                />
            );
        });

        await flushHookEffects({ cycles: 1, turns: 1, advanceTimersMs: 60 });

        expect(expandPath).toHaveBeenCalledTimes(1);
        expect(scrollToPath).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
    });
});
