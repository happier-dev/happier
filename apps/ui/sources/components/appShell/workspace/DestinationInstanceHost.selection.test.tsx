import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import { createRenderCommitCounter, renderScreen, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { DestinationInstanceContext, useDestinationInstance } from './destinationInstanceContext';

afterEach(standardCleanup);

it('does not commit a retained route reader for unread file params, and publishes a real selected change', async () => {
    const counter = createRenderCommitCounter();
    let selected: unknown;
    function Review() {
        selected = useDestinationInstance(value => value?.ref.params.reviewTarget ?? null);
        useRenderCommitCounter(counter);
        return null;
    }
    const child = <Review />;
    const isFocused = () => true;
    const host = (path: string, reviewTarget = 'workingTree') => <DestinationInstanceContext.Provider value={{
        tabId: 'project', ref: { kind: 'project', params: { projectId: 'project', path, reviewTarget } },
        pathname: '/project/project', focused: true, visible: true, isFocused,
    }}>{child}</DestinationInstanceContext.Provider>;
    const screen = await renderScreen(host('a.ts'));
    expect(counter.read().commits).toBeGreaterThan(0);
    counter.reset();
    for (const path of ['b.ts', 'c.ts', 'a.ts']) await screen.update(host(path));
    expect(counter.read()).toEqual({ renders: 0, commits: 0 });
    await screen.update(host('a.ts', 'commit'));
    expect(selected).toBe('commit');
    expect(counter.read()).toEqual({ renders: 1, commits: 1 });
});
