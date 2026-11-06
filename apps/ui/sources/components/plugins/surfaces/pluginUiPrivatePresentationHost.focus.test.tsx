import { describe, expect, it, vi } from 'vitest';

import { ProseDiffViewer } from '@/components/ui/code/diff/prose/ProseDiffViewer';

import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';
import { act, renderHook, renderScreen } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';

type FocusPresentationHost = Readonly<{
    focusTarget?(target: unknown): boolean;
}>;

describe('createPluginUiPrivatePresentationHost focus transfer', () => {
    it('persists collection widths separately for plugins and host collections', async () => {
        getStorage().getState().applyLocalSettings({ collectionRailWidthsV1: { inbox: 401 } });
        const alpha = createPluginUiPrivatePresentationHost(undefined, { pluginId: 'alpha' });
        const beta = createPluginUiPrivatePresentationHost(undefined, { pluginId: 'beta' });
        expect(alpha.panelSizing).toBeDefined();
        expect(createPluginUiPrivatePresentationHost(undefined).panelSizing).toBeUndefined();
        const first = await renderHook(() => alpha.panelSizing!.useWidth('inbox'));
        const otherPlugin = await renderHook(() => beta.panelSizing!.useWidth('inbox'));
        expect(first.getCurrent().widthPx).toBeUndefined();
        await act(async () => {
            first.getCurrent().commit(355);
            otherPlugin.getCurrent().commit(330);
        });
        expect(getStorage().getState().localSettings.collectionRailWidthsV1.inbox).toBe(401);
        const persisted = loadLocalSettings().collectionRailWidthsV1;
        expect(Object.values(persisted).sort()).toEqual([330, 355, 401]);
        await first.unmount();
        const restored = await renderHook(() => createPluginUiPrivatePresentationHost(undefined, { pluginId: 'alpha' })
            .panelSizing!.useWidth('inbox'));
        expect(restored.getCurrent().widthPx).toBe(355);
        expect(otherPlugin.getCurrent().widthPx).toBe(330);
        await act(async () => restored.getCurrent().reset());
        expect(restored.getCurrent().widthPx).toBeUndefined();
        expect(otherPlugin.getCurrent().widthPx).toBe(330);
        expect(Object.values(loadLocalSettings().collectionRailWidthsV1).sort()).toEqual([330, 401]);
    });

    it('fails closed until the current layout fact permits it, then rechecks that fact on the same old host handle', () => {
        const current = { eligible: false };
        const target = { focus: vi.fn() };
        const host = createPluginUiPrivatePresentationHost(undefined, {
            isFocusEligible: () => current.eligible,
        }) as FocusPresentationHost;

        expect(host.focusTarget?.(target)).toBe(false);
        expect(target.focus).not.toHaveBeenCalled();

        const oldHostHandle = host;
        current.eligible = true;
        expect(oldHostHandle.focusTarget?.(target)).toBe(true);
        expect(target.focus).toHaveBeenCalledTimes(1);

        current.eligible = false;
        expect(oldHostHandle.focusTarget?.(target)).toBe(false);
        expect(target.focus).toHaveBeenCalledTimes(1);
    });

    it('uses the mounted direction for executable logical icons', () => {
        const host = createPluginUiPrivatePresentationHost(undefined, { direction: 'rtl' });

        expect(host.renderIcon({ name: 'back', size: 16 }).props.name).toBe('arrow-right');
        expect(host.renderIcon({ name: 'forward', size: 16 }).props.name).toBe('arrow-left');
    });

    it('forwards a read-only unified diff to the incumbent app renderer without adding state', () => {
        const host = createPluginUiPrivatePresentationHost(undefined);
        const unifiedDiff = '@@ -1 +1 @@\n-old\n+new';
        const rendered = host.renderDiffViewer({
            unifiedDiff,
            filePath: 'src/provider.ts',
            testID: 'provider-diff',
        });

        expect(typeof rendered.type).toBe('function');
        expect(rendered.props).toEqual({
            unifiedDiff,
            filePath: 'src/provider.ts',
            testID: 'provider-diff',
        });
    });

    it('draws a prose before/after with the same prose diff viewer core uses for its own proposals', async () => {
        const host = createPluginUiPrivatePresentationHost(undefined);
        const rendered = host.renderDiffViewer({
            before: 'Two rows.',
            after: 'One row.',
            beforeLabel: 'Before',
            afterLabel: 'After',
            testID: 'proposal.diff',
        });

        const screen = await renderScreen(<>{rendered}</>);
        try {
            await act(async () => { await vi.dynamicImportSettled(); });
            expect(screen.findByType(ProseDiffViewer).props).toMatchObject({
                testID: 'proposal.diff',
                oldText: 'Two rows.',
                newText: 'One row.',
                prose: { oldLabel: 'Before', newLabel: 'After' },
            });
        } finally { await screen.unmount(); }
    });
});
