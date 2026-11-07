import { describe, expect, it, vi } from 'vitest';
import * as consent from '@/sync/domains/settings/remoteImageConsent';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';

import { act, renderHook } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { createPersistentUiState } from '@/sync/domains/state/persistentUiState';
import { useWorkspaceMarkdownImages } from './useWorkspaceMarkdownImages';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

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
            expect(reads).toHaveBeenCalledTimes(0);
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
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        const first = await renderHook(() => useWorkspaceMarkdownImages({ scope, filePath: 'docs/README.md' }));
        const secondCounter = createRenderCommitCounter();
        const second = await renderHook(() => {
            useRenderCommitCounter(secondCounter);
            return useWorkspaceMarkdownImages({ scope, filePath: 'README.md' });
        });
        try {
            expect(writes).toHaveBeenCalledTimes(0);
            expect(first.getCurrent().images.remoteLoaded).toBe(false);
            expect(getStorage().getState().localSettings.remoteImageConsentV1).toEqual([]);
            expect(first.getCurrent().images.resolve('./shot.png')).toEqual({ kind: 'workspace', path: 'docs/shot.png' });
            secondCounter.reset();
            await act(async () => { first.getCurrent().images.onLoadRemote(); });
            expect(first.getCurrent().images.remoteLoaded).toBe(true);
            expect(second.getCurrent().images.remoteLoaded).toBe(false);
            expect(secondCounter.read()).toEqual({ renders: 0, commits: 0 });
            expect(writes).toHaveBeenCalledTimes(1);
            expect(loadLocalSettings().remoteImageConsentV1).toEqual([]);
            writes.mockClear();
            await act(async () => { first.getCurrent().images.onLoadRemote(); });
            expect(writes).toHaveBeenCalledTimes(0);
            await act(async () => { second.getCurrent().images.onLoadRemote(); });
            expect(writes).toHaveBeenCalledTimes(1);
            expect(loadLocalSettings().remoteImageConsentV1).toEqual([]);
            const restored = createPersistentUiState('markdown-remote-image-consent-v1', value => value === true);
            expect(restored.read(JSON.stringify([tryBuildWorkspaceCacheKey(scope), 'docs/README.md']))).toBe(true);
            const reopened = await renderHook(() => useWorkspaceMarkdownImages({ scope, filePath: 'docs/README.md' }));
            try { expect(reopened.getCurrent().images.remoteLoaded).toBe(true); }
            finally { await reopened.unmount(); }
            const otherWorkspace = await renderHook(() => useWorkspaceMarkdownImages({ scope: { ...scope, rootPath: '/other/repo' }, filePath: 'docs/README.md' }));
            try { expect(otherWorkspace.getCurrent().images.remoteLoaded).toBe(false); }
            finally { await otherWorkspace.unmount(); }
        } finally {
            writes.mockRestore();
            await first.unmount();
            await second.unmount();
            getStorage().getState().applyLocalSettings({ remoteImageConsentV1: previous }, { source: 'ui' });
        }
    });

    it('imports only the requested retained workspace/document consent once and leaves older-client data unchanged', async () => {
        const scope = { serverId: 'markdown-import-home', machineId: 'markdown-import-machine', rootPath: '/repo' };
        const workspace = tryBuildWorkspaceCacheKey(scope)!;
        const legacy: [string, string][] = [[workspace, 'docs/README.md'], [workspace, 'README.md']];
        const previous = getStorage().getState().localSettings.remoteImageConsentV1;
        getStorage().getState().applyLocalSettings({ remoteImageConsentV1: legacy }, { source: 'ui' });
        const reads = vi.spyOn(consent, 'hasRemoteImageConsent');
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        const hook = await renderHook(() => useWorkspaceMarkdownImages({ scope, filePath: 'docs/README.md' }));
        try {
            expect(hook.getCurrent().images.remoteLoaded).toBe(true);
            expect(reads).toHaveBeenCalledTimes(1);
            expect(writes).toHaveBeenCalledTimes(1);
            const restored = createPersistentUiState('markdown-remote-image-consent-v1', value => value === true);
            expect(restored.read(JSON.stringify([workspace, 'docs/README.md']))).toBe(true);
            expect(restored.read(JSON.stringify([workspace, 'README.md']))).toBeUndefined();
            expect(loadLocalSettings().remoteImageConsentV1).toEqual(legacy);
            await hook.rerender();
            await act(async () => hook.getCurrent().images.onLoadRemote());
            expect(reads).toHaveBeenCalledTimes(1);
            expect(writes).toHaveBeenCalledTimes(1);
        } finally {
            await hook.unmount();
            reads.mockRestore();
            writes.mockRestore();
            getStorage().getState().applyLocalSettings({ remoteImageConsentV1: previous }, { source: 'ui' });
        }
    });

    it('checks missing retained consent once per requested key across remounts without persisting a default', async () => {
        const scope = { serverId: 'markdown-empty-home', machineId: 'markdown-empty-machine', rootPath: '/repo' };
        const reads = vi.spyOn(consent, 'hasRemoteImageConsent');
        const writes = vi.spyOn(getPersistenceStorage(), 'set');
        try {
            for (const filePath of ['README.md', 'README.md', 'docs/README.md']) {
                const hook = await renderHook(() => useWorkspaceMarkdownImages({ scope, filePath }));
                try { expect(hook.getCurrent().images.remoteLoaded).toBe(false); }
                finally { await hook.unmount(); }
            }
            expect(reads).toHaveBeenCalledTimes(2);
            expect(writes).toHaveBeenCalledTimes(0);
        } finally {
            reads.mockRestore();
            writes.mockRestore();
        }
    });
});
