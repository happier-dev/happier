import { describe, expect, it, vi } from 'vitest';
import { resolveFileMenuItems, type FileMenuContext } from './fileMenus';

const base: FileMenuContext = {
    machineReachable: true, unavailableReason: 'offline', hasCachedContent: true, platform: 'web',
};

describe('one file menu inventory across page, phone and tree', () => {
    it('preserves desktop Alt path intent and offers an explicit absolute path on phones', async () => {
        const copyPath = vi.fn();
        const copyAbsolutePath = vi.fn();
        const context = { ...base, copyPath, copyAbsolutePath };
        await resolveFileMenuItems(context, 'page').find(item => item.id === 'copyPath')?.run({ altKey: true });
        expect(copyPath).toHaveBeenCalledWith({ altKey: true });
        const phone = resolveFileMenuItems(context, 'phone');
        expect(phone.map(item => item.id)).toEqual(['copyPath', 'copyAbsolutePath']);
        await phone.find(item => item.id === 'copyAbsolutePath')?.run();
        expect(copyAbsolutePath).toHaveBeenCalledOnce();
        expect(resolveFileMenuItems(context, 'page').some(item => item.id === 'copyAbsolutePath')).toBe(false);
    });

    it('hides missing provider behaviours and exposes one comparison discard across surfaces', async () => {
        expect(resolveFileMenuItems(base, 'page')).toEqual([]);
        const discard = vi.fn();
        const context = { ...base, changes: { discardAll: discard }, readBlame: true,
            toggleBlame: vi.fn(), openWithBlame: vi.fn(), commands: { 'code.restart': vi.fn() } };
        const page = resolveFileMenuItems(context, 'page');
        expect(page.map(item => item.id)).toEqual(['blame', 'code.restart', 'discard']);
        const tree = resolveFileMenuItems(context, 'treeRow');
        expect(tree.map(item => item.id)).toEqual(['openWithBlame', 'discard']);
        await tree.find(item => item.id === 'discard')?.run();
        expect(discard).toHaveBeenCalledOnce();
        expect(resolveFileMenuItems({ ...context, readBlame: false }, 'page').some(item => item.id === 'blame')).toBe(false);
    });

    it('keeps cached sharing available offline while Machine operations explain their unavailability', () => {
        const noop = () => {};
        const context = { ...base, platform: 'tauri' as const, machineReachable: false,
            copyPath: noop, copyLink: noop, mentionInComposer: noop, download: noop,
            rename: noop, openInDefaultApp: noop, changes: { discardAll: noop } };
        const items = resolveFileMenuItems(context, 'treeRow');
        for (const id of ['copyPath', 'copyLink', 'mentionInComposer', 'download']) {
            expect(items.find(item => item.id === id)?.state).toBe('enabled');
        }
        for (const id of ['rename', 'openInDefaultApp', 'discard']) {
            expect(items.find(item => item.id === id)?.state).toEqual({ disabledReason: 'offline' });
        }
        const uncached = resolveFileMenuItems({ ...context, hasCachedContent: false, isDirectory: true }, 'treeRow');
        expect(uncached.find(item => item.id === 'mentionInComposer')?.state).toBe('enabled');
        expect(uncached.find(item => item.id === 'download')?.state).toEqual({ disabledReason: 'offline' });
        // The browser's own viewer: offered only when the open owner admitted this file (a PDF), named for a tab.
        expect(resolveFileMenuItems({ ...context, platform: 'web', machineReachable: true }, 'treeRow')
            .find(item => item.id === 'openInDefaultApp')?.titleKey).toBe('files.viewer.openInNewTab');
        expect(resolveFileMenuItems({ ...context, platform: 'tauri', machineReachable: true }, 'treeRow')
            .find(item => item.id === 'openInDefaultApp')?.titleKey).toBe('files.pane.menu.openInDefaultApp');
    });

    it.each(['page', 'phone', 'treeRow'] as const)('opens and reveals the local original from %s without a daemon transfer', async surface => {
        const open = vi.fn();
        const reveal = vi.fn();
        const downloadThenOpen = vi.fn();
        const context = { ...base, platform: 'tauri' as const, machineReachable: false,
            openInDefaultApp: downloadThenOpen, originalFile: { open, reveal, revealTitleKey: 'files.pane.menu.showInFinder' as const } };
        const items = resolveFileMenuItems(context, surface);
        expect(items.find(item => item.id === 'openInDefaultApp')?.state).toBe('enabled');
        expect(items.find(item => item.id === 'revealInFileManager')).toMatchObject({
            state: 'enabled', titleKey: 'files.pane.menu.showInFinder',
        });
        await items.find(item => item.id === 'openInDefaultApp')?.run();
        await items.find(item => item.id === 'revealInFileManager')?.run();
        expect(open).toHaveBeenCalledOnce();
        expect(reveal).toHaveBeenCalledOnce();
        expect(downloadThenOpen).not.toHaveBeenCalled();

        const remote = resolveFileMenuItems({ ...context, originalFile: undefined, machineReachable: true }, surface);
        expect(remote.some(item => item.id === 'revealInFileManager')).toBe(false);
        await remote.find(item => item.id === 'openInDefaultApp')?.run();
        expect(downloadThenOpen).toHaveBeenCalledOnce();
        expect(resolveFileMenuItems({ ...context, isDirectory: true }, surface)).toEqual([]);
    });

    it('does not let partial content become a selection or directory become blame', () => {
        const context = { ...base, partial: true, selectLines: () => {}, readBlame: true, toggleBlame: () => {} };
        expect(resolveFileMenuItems(context, 'page').map(item => item.id)).toEqual(['blame']);
        expect(resolveFileMenuItems({ ...context, isDirectory: true }, 'page')).toEqual([]);
    });

    it('keeps the existing Android Share export beside Save and Open with', () => {
        const context = { ...base, platform: 'android' as const, shareFile: () => {} };
        expect(resolveFileMenuItems(context, 'phone').map(item => item.id)).toEqual(['shareFile']);
        expect(resolveFileMenuItems({ ...context, platform: 'web' }, 'page')).toEqual([]);
    });
});

describe('Open as gallery (lab pr974 SG2e)', () => {
    it('is a folder row item only, and runs the host gallery opener', async () => {
        const openAsGallery = vi.fn();
        const folder = resolveFileMenuItems({ ...base, isDirectory: true, openAsGallery }, 'treeRow');
        expect(folder.map(item => item.id)).toContain('openAsGallery');
        await folder.find(item => item.id === 'openAsGallery')?.run();
        expect(openAsGallery).toHaveBeenCalledOnce();
        expect(resolveFileMenuItems({ ...base, isDirectory: false, openAsGallery }, 'treeRow').some(item => item.id === 'openAsGallery')).toBe(false);
        expect(resolveFileMenuItems({ ...base, isDirectory: true, openAsGallery }, 'page').some(item => item.id === 'openAsGallery')).toBe(false);
    });
});
