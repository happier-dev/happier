import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { useRepositoryTreeBrowserState } from './repositoryTreeBrowserState';

it('keeps reveal exceptions within their owning scope', async () => {
    let api: ReturnType<typeof useRepositoryTreeBrowserState> | undefined;
    function Test({ scope }: { scope: string }) {
        api = useRepositoryTreeBrowserState(scope);
        return null;
    }
    const screen = await renderScreen(<Test scope="s1" />);
    await act(async () => { api?.revealPath('build/ignored.js'); });
    expect(api?.revealedPaths).toEqual(['build/ignored.js']);
    await act(async () => { screen.update(<Test scope="s2" />); });
    expect(api?.revealedPaths).toEqual([]);
});
