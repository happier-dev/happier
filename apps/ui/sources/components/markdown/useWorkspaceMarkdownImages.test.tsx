import { describe, expect, it, vi } from 'vitest';
import * as consent from '@/sync/domains/settings/remoteImageConsent';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';

import { act, renderHook } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { useWorkspaceMarkdownImages } from './useWorkspaceMarkdownImages';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

describe('workspace Markdown image consent wiring', () => {
    it('keeps images opted out until the document has an explicit Machine context', async () => {
        const hook = await renderHook<ReturnType<typeof useWorkspaceMarkdownImages>, WorkspaceScopeBase | null>(scope => useWorkspaceMarkdownImages({ scope, filePath: 'docs/README.md' }), { initialProps: null });
        try {
            expect(hook.getCurrent()).toEqual({});
            await hook.rerender({ serverId: 'markdown-home', machineId: 'markdown-machine', rootPath: '/repo' });
            expect(hook.getCurrent().images?.resolve('./shot.png')).toEqual({ kind: 'workspace', path: 'docs/shot.png' });
            await hook.rerender(null);
            expect(hook.getCurrent()).toEqual({});
        } finally { await hook.unmount(); }
    });

    it('does zero consent projections or renders for unrelated device preferences and updates on explicit consent', async () => {
        // Observe calls without replacing consent logic; the real store publishes both changes.
        const reads = vi.spyOn(consent, 'hasRemoteImageConsent');
        const counter = createRenderCommitCounter();
        const state = getStorage().getState();
        const previous = state.localSettings;
        const scope = { serverId: 'markdown-count-home', machineId: 'markdown-count-machine', rootPath: '/repo' };
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useWorkspaceMarkdownImages({ scope, filePath: 'README.md' });
        });
        try {
            reads.mockClear();
            counter.reset();
            await act(async () => {
                getStorage().getState().applyLocalSettings({ uiFontScale: previous.uiFontScale === 1 ? 1.1 : 1 }, { source: 'ui' });
            });
            expect(reads).toHaveBeenCalledTimes(0);
            expect(counter.read()).toEqual({ renders: 0, commits: 0 });
            await act(async () => { hook.getCurrent().images.onLoadRemote(); });
            expect(hook.getCurrent().images.remoteLoaded).toBe(true);
            expect(reads.mock.calls.length).toBeGreaterThan(0);
            expect(counter.read().commits).toBe(1);
        } finally {
            await hook.unmount();
            reads.mockRestore();
            getStorage().getState().applyLocalSettings({ uiFontScale: previous.uiFontScale, remoteImageConsentV1: previous.remoteImageConsentV1 }, { source: 'ui' });
        }
    });

    it('writes only on explicit Load, persists by workspace/file, and preserves another document choice', async () => {
        const state = getStorage().getState();
        const previous = state.localSettings.remoteImageConsentV1;
        state.applyLocalSettings({ remoteImageConsentV1: [] }, { source: 'ui' });
        const scope = { serverId: 'markdown-home', machineId: 'markdown-machine', rootPath: '/work/repo' };
        const first = await renderHook(() => useWorkspaceMarkdownImages({ scope, filePath: 'docs/README.md' }));
        const second = await renderHook(() => useWorkspaceMarkdownImages({ scope, filePath: 'README.md' }));
        try {
            expect(first.getCurrent().images.remoteLoaded).toBe(false);
            expect(getStorage().getState().localSettings.remoteImageConsentV1).toEqual([]);
            expect(first.getCurrent().images.resolve('./shot.png')).toEqual({ kind: 'workspace', path: 'docs/shot.png' });
            await act(async () => { first.getCurrent().images.onLoadRemote(); });
            expect(first.getCurrent().images.remoteLoaded).toBe(true);
            expect(second.getCurrent().images.remoteLoaded).toBe(false);
            await act(async () => { second.getCurrent().images.onLoadRemote(); });
            expect(loadLocalSettings().remoteImageConsentV1).toHaveLength(2);
            const reopened = await renderHook(() => useWorkspaceMarkdownImages({ scope, filePath: 'docs/README.md' }));
            try { expect(reopened.getCurrent().images.remoteLoaded).toBe(true); }
            finally { await reopened.unmount(); }
            const otherWorkspace = await renderHook(() => useWorkspaceMarkdownImages({ scope: { ...scope, rootPath: '/other/repo' }, filePath: 'docs/README.md' }));
            try { expect(otherWorkspace.getCurrent().images.remoteLoaded).toBe(false); }
            finally { await otherWorkspace.unmount(); }
        } finally {
            await first.unmount();
            await second.unmount();
            getStorage().getState().applyLocalSettings({ remoteImageConsentV1: previous }, { source: 'ui' });
        }
    });
});
