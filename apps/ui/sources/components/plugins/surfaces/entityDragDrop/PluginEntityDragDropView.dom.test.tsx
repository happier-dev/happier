// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Pressable, Text } from 'react-native';
import { expect, it, vi } from 'vitest';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { createPluginEntityDragDropBinding } from './pluginEntityDragDropBinding';
import { PluginEntityDragSourceView, PluginEntityDropTargetView } from './PluginEntityDragDropView';
import { List } from '@happier-dev/plugin-ui';
import { PluginUiProvider } from '../../../../../../../packages/plugin-ui/src/components/PluginUiProvider';
import { createHostApiStub, createSurfaceContext } from '../../../../../../../packages/plugin-ui/src/surfaceFixture.testSupport';

// Platform/native presentation are system boundaries. Pressable's real RNW event propagation runs unchanged.
vi.mock('react-native', async () => { const actual = await vi.importActual<typeof import('react-native-web')>('react-native-web'); return { ...actual, Platform: { ...actual.Platform, OS: 'web' } }; });
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

it('offers a named focusable source entry without stealing RNW primary or secondary activation', async () => {
    const runtime = createEntityDragDropRuntime();
    const client = { artifactId: 'ui', exportName: 'activate' };
    let writes = 0; let primary = 0; let overflow = 0; let settlements = 0;
    const source = { descriptor: { id: 'pr', title: 'PR', client, platforms: ['web' as const], referenceSchema: { type: 'object' as const } },
        describe: () => ({ title: 'Review PR' }), isCurrent: () => true };
    const target = { descriptor: { id: 'detail', title: 'Detail', client, platforms: ['web' as const], acceptedKinds: ['plugin:acme.review/pr' as const], actions: [{ kind: 'plugin' as const, action: 'open' }] },
        resolve: () => ({ status: 'allowed' as const, effect: { actionId: 'plugin:acme.review/open', input: {}, preview: { verb: 'Open', target: 'Detail' } } }), isCurrent: () => true };
    const binding = createPluginEntityDragDropBinding({ runtime, pluginId: 'acme.review', mountKey: 'dom', scope: { serverId: 'home', accountId: 'account' },
        isCurrent: () => true, readSource: () => source, readTarget: () => target,
        executeAction: async () => { writes++; return { status: 'applied' }; } });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const key = async (element: HTMLElement, value: string, type = 'keydown') => { await act(async () => {
        element.dispatchEvent(new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true }));
    }); };
    const activate = async (element: HTMLElement, value: string) => {
        await act(async () => element.focus());
        await key(element, value); await key(element, value, 'keyup');
        // jsdom does not synthesize the browser's native button click after keyboard activation.
        if (element.tagName === 'BUTTON') await act(async () => element.click());
    };
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context);
    const commits = vi.fn();
    const render = (interactive: boolean, tabIndex?: -1 | 0, composite = false) => <PluginUiProvider hostApi={hostApi} context={context}>
        <React.Profiler id="source" onRender={commits}>
            <PluginEntityDragSourceView binding={binding} sourceId="pr" reference={{ id: '42' }} testID="source" tabIndex={tabIndex} onDropOutcome={() => { settlements++; }}>
                {composite ? <List items={['42', '43']} keyForItem={item => item} accessibilityLabel="Reviews" accessibilityPattern="grid"
                    selection={{ selectedKey: null, onSelectedKeyChange: () => { primary++; } }}
                    renderItem={item => <List.Item title={`Review ${item}`} testID={`row:${item}`} />} />
                    : interactive ? <Pressable accessibilityRole="button" onPress={() => { primary++; }} testID="primary"><Text>Open PR</Text></Pressable> : <Text>PR summary</Text>}
                <Pressable accessibilityRole="button" aria-haspopup="menu" onPress={() => { overflow++; }} testID="overflow"><Text>More</Text></Pressable>
            </PluginEntityDragSourceView>
        </React.Profiler>
        <React.Profiler id="targets" onRender={commits}>
            <PluginEntityDropTargetView binding={binding} targetId="detail" testID="target"><Text>Detail</Text></PluginEntityDropTargetView>
            <PluginEntityDropTargetView binding={binding} targetId="detail" input={{ pane: 'second' }} testID="target2"><Text>Second detail</Text></PluginEntityDropTargetView>
        </React.Profiler>
    </PluginUiProvider>;
    try {
        await act(async () => root.render(render(false)));
        expect(commits.mock.calls.map(([id, phase]) => [id, phase])).toEqual([
            ['source', 'mount'], ['targets', 'mount'],
        ]);
        const entry = container.querySelector<HTMLElement>('[data-testid="source"]')!;
        expect(entry.tabIndex).toBe(0);
        expect(entry.getAttribute('aria-label')).toContain('Review PR');
        entry.focus(); expect(document.activeElement).toBe(entry);
        await key(entry, ' ');
        expect(runtime.getSnapshot()).toMatchObject({ phase: 'carrying', admission: { status: 'allowed' } });
        const firstTarget = runtime.getSnapshot().targetId;
        await key(entry, 'ArrowDown'); expect(runtime.getSnapshot().targetId).not.toBe(firstTarget);
        await key(entry, 'ArrowUp'); expect(runtime.getSnapshot().targetId).toBe(firstTarget);
        await key(entry, 'Escape'); expect(runtime.getSnapshot().phase).toBe('idle');
        await key(entry, ' '); await key(entry, 'Enter'); expect(writes).toBe(1);
        expect(settlements).toBe(1);
        const more = container.querySelector<HTMLElement>('[data-testid="overflow"]')!;
        await activate(more, ' ');
        expect(overflow).toBe(1); expect(runtime.getSnapshot().phase).not.toBe('carrying');
        const drag = new Event('dragstart', { bubbles: true, cancelable: true });
        await act(async () => more.dispatchEvent(drag));
        expect(drag.defaultPrevented).toBe(true); expect(runtime.getSnapshot().phase).not.toBe('carrying');
        await act(async () => root.render(render(true)));
        const action = container.querySelector<HTMLElement>('[data-testid="primary"]')!;
        await activate(action, 'Enter');
        expect(primary).toBe(1); expect(runtime.getSnapshot().phase).not.toBe('carrying');
        await activate(action, ' ');
        expect(primary).toBe(2); expect(runtime.getSnapshot().phase).not.toBe('carrying');
        entry.focus(); await key(entry, ' '); await key(entry, 'Enter'); expect(writes).toBe(2);
        await act(async () => root.render(render(true, -1)));
        expect(entry.tabIndex).toBe(-1);
        expect(entry.getAttribute('aria-label')).toContain('Review PR');
        // The row's roving owner only removes sequential access; programmatic/native actions stay available.
        entry.focus(); await key(entry, ' '); await key(entry, 'Escape');
        expect(runtime.getSnapshot().phase).toBe('idle');
        await act(async () => root.render(render(true, 0)));
        expect(entry.tabIndex).toBe(0);
        await act(async () => root.render(render(true, -1, true)));
        const row = container.querySelector<HTMLElement>('[data-testid="row:42"]')!;
        expect(row.tabIndex).toBe(0);
        row.focus();
        await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', altKey: true, bubbles: true, cancelable: true })); });
        expect(runtime.getSnapshot().phase).toBe('carrying');
        await key(row, 'ArrowDown');
        expect(document.activeElement).toBe(row);
        await activate(row, 'Enter');
        expect(writes).toBe(3);
        expect(settlements).toBe(3);
        expect(primary).toBe(2);
        await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', altKey: true, bubbles: true, cancelable: true })); });
        await key(row, 'Escape');
        expect(runtime.getSnapshot().phase).toBe('idle');
    } finally { await act(async () => root.unmount()); binding.dispose(); container.remove(); }
});
