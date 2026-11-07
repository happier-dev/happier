import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useHostTaskShareSheet } from '@happier-dev/plugin-ui/hostApi';
import { PluginUiPresentationHostProviderInternal } from '../../../../../../packages/plugin-ui/src/presentationHost/context';
import { act, renderHook } from '@/dev/testkit';
import { Modal } from '@/modal';
import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';

// The modal renderer is the platform presentation boundary; the bridge and share presenter stay real.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

describe('plugin task ShareSheet capability', () => {
    it('opens the incumbent share sheet for the exact task, viewer scope and menu anchor', async () => {
        const host = createPluginUiPrivatePresentationHost(undefined);
        const hook = await renderHook(useHostTaskShareSheet, {
            wrapper: ({ children }) => <PluginUiPresentationHostProviderInternal host={host}>{children}</PluginUiPresentationHostProviderInternal>,
        });
        const taskRef = { taskId: 'task-7', ownerAccountId: 'owner-2', scope: { serverId: 'home-3', accountId: 'viewer-4' } };
        const target = { measureInWindow: vi.fn() };
        expect(hook.getCurrent()).not.toBeNull();
        await act(async () => hook.getCurrent()!.open({ taskRef, title: 'Exact task', anchor: { current: target } }));
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            props: taskRef,
            chrome: expect.objectContaining({
                testID: 'task-share-modal', phonePresentation: 'sheet',
                anchor: { kind: 'view', ref: { current: target } },
            }),
        }));
        await hook.unmount();
    });

    it('is unavailable without a host or with an older host lacking the binding', async () => {
        const unbound = await renderHook(useHostTaskShareSheet);
        expect(unbound.getCurrent()).toBeNull();
        await unbound.unmount();
        const older = await renderHook(useHostTaskShareSheet, {
            wrapper: ({ children }) => <PluginUiPresentationHostProviderInternal host={{
                ...createPluginUiPrivatePresentationHost(undefined), taskShareSheet: undefined,
            }}>{children}</PluginUiPresentationHostProviderInternal>,
        });
        expect(older.getCurrent()).toBeNull();
        await older.unmount();
    });
});
