import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
vi.mock('@expo/vector-icons', async () => ({
    ...(await import('@/dev/testkit')).createExpoVectorIconsMock(),
    // Reproduce the native icon export boundary failure without replacing browser logic.
    Ionicons: undefined,
}));
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: key => key }));

describe('Session browser icon boundary', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
    beforeAll(prepareSessionFilesViewTestkit);
    afterEach(async () => { standardCleanup(); await fixture?.dispose(); });
    it('remains usable when the Ionicons export is unavailable', async () => {
        fixture = await createSessionFilesViewFixture({ rootPath: '/missing-icon-browser' });
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        const screen = await fixture.render(<SessionRepositoryTreeBrowserView sessionId="s1" serverId={fixture.scope.serverId} onOpenFile={() => {}} />);
        expect(screen.findByTestId('repository-tree-search')).toBeTruthy();
        expect(screen.findByTestId('repository-tree-view-menu')).toBeTruthy();
    });
});
