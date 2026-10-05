import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { DocumentTabStrip } from './DocumentTabStrip';

installPanelCommonModuleMocks({ reactNative: async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, { View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable' });
} });

describe('native DocumentTabStrip geometry', () => {
    it.each(['strip', 'bar', 'rail'] as const)('refreshes the %s anchor from its container and at release without child layout', async (variant) => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'row', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'destination', scope, href: '/inbox' }) });
        let x = 0;
        const writes: unknown[] = [];
        const screen = await renderScreen(<DocumentTabStrip
            variant={variant}
            tabs={[{ key: 'anchor', title: 'Anchor', isPinned: false, isPreview: false }]}
            activeTabKey="anchor" accessibilityLabel="Documents"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={id => id} panelNativeId={id => id}
            entityDragDrop={{ runtime, id: 'strip', scope, acceptedKinds: ['destination'], getItem: () => null,
                resolve: ({ beforeTabId }) => ({ status: 'allowed', effect: { actionId: 'workspace.tabs.open',
                    input: { href: '/inbox', beforeTabId }, preview: { verb: 'Open', target: 'Anchor' } } }),
                execute: async effect => { writes.push(effect.input); return { status: 'applied' }; } }}
        />, { createNodeMock: element => typeof element.type === 'string' && String(element.type) === 'View'
            ? { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(x, 0, 100, 40) }
            : null });
        await act(async () => {
            for (const node of screen.root.findAll(node => typeof node.type === 'string' && String(node.type) === 'View' && typeof node.props.onLayout === 'function')) node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 100, height: 40 } } });
        });
        let carry!: NonNullable<ReturnType<typeof runtime.begin>>;
        await act(async () => { carry = runtime.begin('row')!; });
        await act(async () => { carry.move({ x: 50, y: 20 }); });
        expect(runtime.getSnapshot().targetId).not.toBeNull();
        x = 200;
        await act(async () => {
            if (variant === 'bar') screen.root.find(node => typeof node.type === 'string' && String(node.type) === 'View' && node.props.accessibilityRole === 'tablist')
                .props.onLayout({ nativeEvent: { layout: { x: 200, y: 0, width: 100, height: 40 } } });
            else screen.root.findByType('ScrollView').props.onScroll({ nativeEvent: { contentOffset: { x: 200, y: 0 } } });
        });
        expect(runtime.getSnapshot().targetId).toBeNull();
        await act(async () => { carry.move({ x: 250, y: 20 }); });
        expect(runtime.getSnapshot().targetId).not.toBeNull();
        x = 400;
        await act(async () => { expect(await carry.release()).toBeNull(); });
        expect(writes).toEqual([]);
        let current!: NonNullable<ReturnType<typeof runtime.begin>>;
        await act(async () => { current = runtime.begin('row')!; });
        await act(async () => { current.move({ x: 450, y: 20 }); expect(await current.release()).toEqual({ status: 'applied' }); });
        expect(writes).toEqual([{ href: '/inbox', beforeTabId: 'anchor' }]);
    });
});
