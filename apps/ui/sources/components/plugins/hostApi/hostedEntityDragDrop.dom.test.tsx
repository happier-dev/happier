// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ENTITY_DRAG_DELIVERY_MIME_V1, PluginUiUpdateEntityDragDropResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { DragSource, DropTarget } from '@happier-dev/plugin-ui/components';
import { PluginUiProvider } from '@happier-dev/plugin-ui/advanced';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { createPluginEntityDragDropBinding } from '../surfaces/entityDragDrop/pluginEntityDragDropBinding';
import { createHostedEntityDragDropHandlers } from './hostedEntityDragDrop';
import { createPluginSurfaceHostApi } from '../surfaces/createPluginSurfaceHostApi';

// React Native platform identity is a device boundary; hosted HTML runs in the web realm.
vi.mock('react-native', async () => { const actual = await vi.importActual<typeof import('react-native-web')>('react-native-web'); return { ...actual, Platform: { ...actual.Platform, OS: 'web' } }; });

// jsdom omits the native dialog top-layer API; only that browser boundary is substituted.
const dialogMethods = ['showModal', 'close'] as const;
const dialogDescriptors = dialogMethods.map(key => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, key));
beforeAll(() => Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
}));
afterAll(() => dialogMethods.forEach((key, index) => { const descriptor = dialogDescriptors[index]; if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, key, descriptor); else Reflect.deleteProperty(HTMLDialogElement.prototype, key); }));

describe('hosted public React drag primitives', () => {
    it('keeps one realm carry across ordinary rerenders, delivers a drop once, and leaves files and sibling controls untouched', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        const writes: unknown[] = [];
        let refused = false;
        let finish: (() => void) | undefined;
        let pending: Promise<void> | undefined;
        const sourceDefinition = { id: 'issue', title: 'Issue', client: { artifactId: 'ui', exportName: 'activate' }, platforms: ['web' as const], referenceSchema: { type: 'object' as const, properties: { id: { type: 'string' as const } }, required: ['id'], additionalProperties: false } };
        const source = { descriptor: sourceDefinition, describe: () => ({ title: 'Issue' }), isCurrent: () => true };
        const target = { descriptor: { id: 'board', title: 'Board', client: sourceDefinition.client, platforms: sourceDefinition.platforms, acceptedKinds: ['plugin:com.acme.fixture/issue' as const], actions: [{ kind: 'plugin' as const, action: 'add' }] },
            resolve: () => refused ? { status: 'refused' as const, reason: { code: 'read_only', message: 'Read only' } } : ({ status: 'allowed' as const, effect: { actionId: 'plugin:com.acme.fixture/add', input: { issue: 'x' }, preview: { verb: 'Add', target: 'Board' } } }), isCurrent: () => true };
        const binding = createPluginEntityDragDropBinding({ runtime, pluginId: 'com.acme.fixture', mountKey: 'iframe', scope, isCurrent: () => true, readSource: () => source, readTarget: () => target,
            executeAction: async (_action, input) => { await pending; writes.push(input); return { status: 'applied' }; } });
        const hosted = createHostedEntityDragDropHandlers({ binding, isCurrent: () => true, readSessionItem: () => null });
        const surface = { pluginId: 'com.acme.fixture', contributionId: 'board', surfaceId: 'iframe', placement: 'sessionPane' as const, platform: 'web' as const, channel: 'internal' as const, resourceScope: [], diagnostics: [] };
        const api = createPluginSurfaceHostApi({ surfaceContext: surface, handlers: hosted.handlers });
        const fixture = await createPluginUiTestkit({ identity: { instanceId: 'iframe', mountNonce: 'nonce' }, authorPlugin: { id: 'com.acme.fixture', version: '1.0.0' }, surface: null, surfaceContext: createSurfaceContextFixture(),
            adapter: { async mount() { return { async snapshot() { return { revision: 0, nodes: [] }; }, async update() {}, async invoke() {}, async dispose() {} }; } },
            handlers: {
                watchEntityDragDrop: async ({ request, publish }) => {
                    let release: (() => void) | undefined;
                    await api.handleRequest({ version: 1, requestId: 'watch', surface, method: 'watchEntityDragDrop', payload: request }, { entityDragDropSubscription: { publish, retain: value => { release = value; } } });
                    return { dispose: () => release?.() };
                },
                updateEntityDragDrop: async ({ request }) => PluginUiUpdateEntityDragDropResultV1Schema.parse(await api.handleRequest({ version: 1, requestId: 'dom', surface, method: 'updateEntityDragDrop', payload: request }, { getHostedFrameBounds: async () => ({ x: 100, y: 100, width: window.innerWidth, height: window.innerHeight }) })) } });
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        const render = (dropDisabled = false) => <PluginUiProvider hostApi={fixture.context.hostApi} context={fixture.context.surface}><DropTarget disabled={dropDisabled} targetId="board" input={{ list: 'board' }} testID="target"><DragSource sourceId="issue" reference={{ id: 'x' }} organizing testID="source"><div><button>Issue</button><button>Menu</button></div></DragSource></DropTarget></PluginUiProvider>;
        await act(async () => root.render(render()));
        const element = container.querySelector<HTMLElement>('[data-testid="source"]')!;
        const targetElement = container.querySelector<HTMLElement>('[data-testid="target"]')!;
        targetElement.getBoundingClientRect = () => new DOMRect(10, 10, 100, 100);
        await vi.waitFor(() => expect(element.draggable).toBe(true));
        const event = (kind: string, types: readonly string[] = [ENTITY_DRAG_DELIVERY_MIME_V1]) => {
            const drag = new Event(kind, { bubbles: true, cancelable: true });
            Object.defineProperties(drag, { clientX: { value: 20 }, clientY: { value: 20 }, dataTransfer: { value: { types, setData() {} } } });
            return drag;
        };
        const buttons = () => Array.from(element.querySelectorAll('button'));
        const menu = event('dragstart'); buttons().find(button => button.textContent === 'Menu')!.dispatchEvent(menu);
        expect(menu.defaultPrevented).toBe(true);
        expect(runtime.getSnapshot().phase).toBe('idle');
        buttons().find(button => button.textContent === 'Issue')!.dispatchEvent(event('dragstart'));
        await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('carrying'));
        targetElement.dispatchEvent(event('dragover'));
        await vi.waitFor(() => expect(runtime.getSnapshot().admission?.status).toBe('allowed'));
        const sourceId = runtime.getSnapshot().sourceId;
        await vi.waitFor(() => expect(targetElement.querySelector('[data-testid="target-outline"]')).not.toBeNull());
        await act(async () => { refused = true; binding.refresh(); });
        expect(targetElement.querySelector('[data-testid="target-outline"]')).toBeNull();
        await act(async () => { refused = false; binding.refresh(); });
        expect(targetElement.querySelector('[data-testid="target-outline"]')).not.toBeNull();
        await act(async () => root.render(render()));
        expect(runtime.getSnapshot().sourceId).toBe(sourceId);
        const files = event('drop', ['Files']); targetElement.dispatchEvent(files);
        expect(files.defaultPrevented).toBe(false);
        pending = new Promise<void>(resolve => { finish = resolve; });
        targetElement.dispatchEvent(event('drop'));
        element.dispatchEvent(event('dragend'));
        await vi.waitFor(() => expect(targetElement.getAttribute('aria-busy')).toBe('true'));
        expect(targetElement.querySelector('[data-testid="target-outline"]')).not.toBeNull();
        await act(async () => { finish?.(); }); pending = undefined;
        await vi.waitFor(() => expect(runtime.getSnapshot().outcome).toEqual({ status: 'applied' }));
        await vi.waitFor(() => expect(targetElement.querySelector('[data-testid="target-outline"]')).toBeNull());
        expect(writes).toEqual([{ issue: 'x' }]);
        buttons().find(button => button.textContent === 'Issue')!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        expect(runtime.getSnapshot().phase).not.toBe('carrying');
        element.focus();
        expect(document.activeElement).toBe(element);
        element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('carrying'));
        expect(writes).toHaveLength(1);
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('idle'));
        element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(runtime.getSnapshot().admission?.status).toBe('allowed'));
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(writes).toHaveLength(2));
        const grip = element.querySelector<HTMLElement>('[data-testid="source-grip"]')!;
        let captured = false;
        grip.setPointerCapture = () => { captured = true; }; grip.hasPointerCapture = () => captured; grip.releasePointerCapture = () => { captured = false; };
        const touch = (kind: string, x = 20) => { const pointer = new Event(kind, { bubbles: true, cancelable: true }); Object.defineProperties(pointer, { pointerType: { value: 'touch' }, pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: 20 } }); return pointer; };
        grip.dispatchEvent(touch('pointerdown'));
        expect(runtime.getSnapshot().phase).not.toBe('carrying');
        grip.dispatchEvent(touch('pointermove', 26));
        await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('carrying'));
        grip.dispatchEvent(touch('pointercancel'));
        await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('idle'));
        expect(writes).toHaveLength(2);
        grip.dispatchEvent(touch('pointerdown'));
        grip.dispatchEvent(touch('pointermove', 26));
        await vi.waitFor(() => expect(runtime.getSnapshot().admission?.status).toBe('allowed'));
        grip.dispatchEvent(touch('pointerup'));
        await vi.waitFor(() => expect(writes).toHaveLength(3));
        await act(async () => grip.click());
        await vi.waitFor(() => expect(element.querySelector('[role="menuitem"]')).not.toBeNull());
        await vi.waitFor(() => expect(document.activeElement).toBe(element.querySelector('[role="menuitem"]')));
        await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
        await vi.waitFor(() => expect(element.querySelector('[role="menu"]')).toBeNull());
        expect(document.activeElement).toBe(grip);
        await act(async () => grip.click());
        await vi.waitFor(() => expect(element.querySelector('[role="menuitem"]')).not.toBeNull());
        await act(async () => element.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
        await vi.waitFor(() => expect(writes).toHaveLength(4));
        expect(document.activeElement).toBe(grip);
        await act(async () => grip.click());
        await vi.waitFor(() => expect(element.querySelector('[role="menuitem"]')).not.toBeNull());
        await act(async () => root.render(render(true)));
        await vi.waitFor(() => expect(element.querySelectorAll('[role="menuitem"]')).toHaveLength(0));
        expect(element.querySelector('[role="menu"]')).not.toBeNull();
        await act(async () => root.render(render()));
        await vi.waitFor(() => expect(element.querySelectorAll('[role="menuitem"]')).toHaveLength(1));
        await act(async () => element.querySelector('[role="menuitem"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
        element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('carrying'));
        await vi.waitFor(() => expect(element.querySelector('[role="status"]')?.textContent).toBe('Add. Board'));
        expect(element.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
        expect(element.querySelector('[role="status"]')?.textContent).toBe('Add. Board');
        await act(async () => root.render(render(true)));
        await vi.waitFor(() => expect(runtime.getSnapshot().admission).toBeNull());
        expect(targetElement.querySelector('[data-testid="target-outline"]')).toBeNull();
        expect(targetElement.getAttribute('aria-busy')).not.toBe('true');
        expect(container.textContent).not.toContain('Add. Board');
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('idle'));
        expect(writes).toHaveLength(4);
        await act(async () => root.unmount());
        await fixture.dispose(); hosted.dispose(); binding.dispose(); container.remove();
    });
});
