// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { PluginDragSourceContributionV1Schema } from '@happier-dev/protocol';
import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { TreeDropOutline } from '@/components/ui/treeDragDrop/ui/TreeDropOutline';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createPluginEntityDragDropBinding } from './pluginEntityDragDropBinding';
import { PluginEntityDragSourceView, PluginEntityDropTargetView } from './PluginEntityDragDropView';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));

const screens: RenderScreenResult[] = [];
afterEach(async () => { for (const screen of screens.splice(0)) await screen.unmount(); });

function fixture() {
    const runtime = createEntityDragDropRuntime();
    let writes = 0;
    let current = true;
    const source = { descriptor: PluginDragSourceContributionV1Schema.parse({ id: 'pr', title: 'Pull request', client: { artifactId: 'ui', exportName: 'activate' }, platforms: ['web'],
        referenceSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } }),
        describe: () => ({ title: 'Review PR' }), isCurrent: () => current };
    const target = { descriptor: { id: 'detail', title: 'Detail', client: { artifactId: 'ui', exportName: 'activate' }, platforms: ['web' as const],
        acceptedKinds: ['plugin:acme.review/pr' as const], actions: [{ kind: 'plugin' as const, action: 'open' }] },
        resolve: () => ({ status: 'allowed' as const, effect: { actionId: 'plugin:acme.review/open', input: {}, preview: { verb: 'Open', target: 'Detail' } } }),
        isCurrent: () => current };
    const binding = createPluginEntityDragDropBinding({ runtime, pluginId: 'acme.review', mountKey: 'view', scope: { serverId: 'home', accountId: 'account' },
        isCurrent: () => current, readSource: () => source, readTarget: () => target,
        executeAction: async () => { writes++; return { status: 'applied' }; } });
    return { runtime, binding, writes: () => writes, retire: () => { current = false; } };
}

function event(type: string) {
    const result = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(result, { clientX: { value: 25 }, clientY: { value: 25 } });
    return result;
}

describe('mounted plugin entity presentation', () => {
    it('refreshes an open chooser when a mounted destination disappears or returns', async () => {
        Reflect.set(Platform, 'OS', 'ios');
        const f = fixture();
        const tree = (targetMounted: boolean) => <>
            <PluginEntityDragSourceView binding={f.binding} sourceId="pr" reference={{ id: '42' }} organizing testID="source"><span>PR</span></PluginEntityDragSourceView>
            {targetMounted ? <PluginEntityDropTargetView binding={f.binding} targetId="detail" testID="target"><span>Detail</span></PluginEntityDropTargetView> : null}
        </>;
        const screen = await renderScreen(tree(true));
        screens.push(screen);
        await act(async () => { screen.findByType(DropdownMenu).props.onOpenChange(true); });
        expect(screen.findByType(DropdownMenu).props.items).toHaveLength(1);
        await screen.update(tree(false));
        expect(screen.findByType(DropdownMenu).props.items).toHaveLength(0);
        expect(f.writes()).toBe(0);
        await screen.update(tree(true));
        expect(screen.findByType(DropdownMenu).props.items).toHaveLength(1);
        await act(async () => { screen.findByType(DropdownMenu).props.onSelect('0'); });
        expect(f.writes()).toBe(1);
        await act(async () => { f.binding.dispose(); });
    });
    it.each(['ios', 'android'])('offers %s carry only in Organize mode and cancels unsuccessful input', async platform => {
        Reflect.set(Platform, 'OS', platform);
        const f = fixture();
        const tree = (organizing: boolean) => <>
            <PluginEntityDragSourceView binding={f.binding} sourceId="pr" reference={{ id: '42' }} organizing={organizing} testID="source"><span>PR</span></PluginEntityDragSourceView>
            <PluginEntityDropTargetView binding={f.binding} targetId="detail" testID="target"><span>Detail</span></PluginEntityDropTargetView>
        </>;
        const screen = await renderScreen(tree(false), { createNodeMock: node => {
            const testID = node.props && typeof node.props === 'object' && 'testID' in node.props ? node.props.testID : null;
            return testID === 'target' ? {
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 100, 100),
            } : null;
        } });
        screens.push(screen);
        expect(screen.findAllByType('GestureDetector')).toHaveLength(0);
        await screen.update(tree(true));
        const pan = screen.findAllByType('GestureDetector')[0]!.props.gesture as TestGestureChain;
        await act(async () => {
            pan.__handlers.onStart!({ absoluteX: 25, absoluteY: 25 });
            pan.__handlers.onEnd!({ absoluteX: 25, absoluteY: 25 }, false);
            pan.__handlers.onFinalize!();
        });
        expect(f.runtime.getSnapshot().phase).toBe('idle');
        expect(f.writes()).toBe(0);
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 25, absoluteY: 25 }); });
        await screen.update(tree(false));
        expect(f.runtime.getSnapshot().phase).toBe('idle');
        await act(async () => { pan.__handlers.onEnd!({ absoluteX: 25, absoluteY: 25 }, true); await Promise.resolve(); });
        expect(f.writes()).toBe(0);
        await screen.update(tree(true));
        const next = screen.findAllByType('GestureDetector')[0]!.props.gesture as TestGestureChain;
        await act(async () => {
            next.__handlers.onStart!({ absoluteX: 25, absoluteY: 25 });
            next.__handlers.onEnd!({ absoluteX: 25, absoluteY: 25 }, true);
            next.__handlers.onFinalize!();
            await Promise.resolve(); await Promise.resolve();
        });
        expect(f.writes()).toBe(1);
        expect(screen.findAllByType(TreeDropOutline)).toHaveLength(0);
        await act(async () => { f.binding.dispose(); });
    });
    it('carries a primary Collection row but leaves secondary controls alone and retires without a write', async () => {
        Reflect.set(Platform, 'OS', 'web');
        const f = fixture();
        const row = document.createElement('div');
        const primary = document.createElement('button');
        const overflow = document.createElement('button');
        primary.textContent = 'Review'; overflow.textContent = 'More';
        row.append(primary, overflow);
        const destination = document.createElement('div');
        destination.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON() {} });
        const screen = await renderScreen(<>
            <PluginEntityDragSourceView binding={f.binding} sourceId="pr" reference={{ id: '42' }} testID="source"><span>PR</span></PluginEntityDragSourceView>
            <PluginEntityDropTargetView binding={f.binding} targetId="detail" testID="target"><span>Detail</span></PluginEntityDropTargetView>
        </>, { createNodeMock: node => {
            const testID = node.props && typeof node.props === 'object' && 'testID' in node.props ? node.props.testID : null;
            return testID === 'source' ? row : testID === 'target' ? destination : null;
        } });
        screens.push(screen);
        await act(async () => { overflow.dispatchEvent(event('dragstart')); });
        expect(f.runtime.getSnapshot().phase).toBe('idle');
        await act(async () => { primary.dispatchEvent(event('dragstart')); });
        expect(f.runtime.getSnapshot().phase).toBe('carrying');
        expect(f.runtime.getSnapshot().item).toMatchObject({ kind: 'plugin', contribution: { pluginId: 'acme.review', localId: 'pr' }, reference: { id: '42' } });
        f.retire();
        await act(async () => { destination.dispatchEvent(event('drop')); await Promise.resolve(); });
        expect(f.writes()).toBe(0);
        await act(async () => { f.binding.dispose(); });
    });
});
