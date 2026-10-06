// @vitest-environment jsdom
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createEntityDragDropRuntime } from '../entityDragDropRuntime';
import { useEntityDragDomBinding, useEntityDropDomBinding } from '../useEntityDragDomBinding';
import { installEntityDragCancellation } from '../entityDragCancellation';

installPanelCommonModuleMocks();

function dragEvent(type: string, x = 50) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { clientX: { value: x }, clientY: { value: 50 } });
    return event;
}

describe('entity DOM carry boundary', () => {
    it('keeps a refused hover alive across a transient ref detach, then applies an admitted drop', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'destination', scope, href: '/inbox' }) });
        let opened: unknown = null;
        runtime.registerTarget({ id: 'rail', scope, acceptedKinds: ['destination'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            resolve: ({ pointer }) => pointer && pointer.x > 60
                ? { status: 'allowed', effect: { actionId: 'workspace.tabs.open', input: { href: '/inbox' }, preview: { verb: 'Open', target: 'Inbox' } } }
                : { status: 'refused', reason: { code: 'no-change', message: 'Already here' } },
            execute: async effect => { opened = effect.input; return { status: 'applied' }; },
        });
        const sourceHook = await renderHook(() => useEntityDragDomBinding({ runtime, sourceId: 'source', enabled: true }));
        const targetHook = await renderHook(() => useEntityDropDomBinding(runtime));
        const source = document.createElement('div');
        const target = document.createElement('div');
        document.body.append(source, target);
        const stop = installEntityDragCancellation(runtime, window);
        act(() => { sourceHook.getCurrent()(source); targetHook.getCurrent()(target); });
        try {
            const refused = dragEvent('dragover');
            act(() => {
                source.dispatchEvent(dragEvent('dragstart'));
                target.dispatchEvent(refused);
                // React/RN Web can detach and reattach the same connected host during
                // the carry-feedback commit; this is not source retirement.
                sourceHook.getCurrent()(null);
                sourceHook.getCurrent()(source);
            });
            expect(refused.defaultPrevented).toBe(false);
            expect(runtime.getSnapshot()).toMatchObject({ phase: 'carrying', admission: { status: 'refused' } });
            await act(async () => { await Promise.resolve(); });
            expect(runtime.getSnapshot().phase).toBe('carrying');
            const admitted = dragEvent('dragover', 75);
            act(() => { target.dispatchEvent(admitted); });
            expect(admitted.defaultPrevented).toBe(true);
            // An allowed preview can also rerender the source host.
            act(() => { sourceHook.getCurrent()(null); sourceHook.getCurrent()(source); });
            await act(async () => { target.dispatchEvent(dragEvent('drop', 75)); });
            expect(opened).toEqual({ href: '/inbox' });
            expect(runtime.getSnapshot().outcome).toEqual({ status: 'applied' });
        } finally {
            stop(); source.remove(); target.remove();
            await sourceHook.unmount(); await targetHook.unmount();
        }
    });

    it('retires a detached source after the commit and cancels immediately when its host is replaced', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'destination', scope, href: '/inbox' }) });
        const hook = await renderHook(() => useEntityDragDomBinding({ runtime, sourceId: 'source', enabled: true }));
        const source = document.createElement('div');
        const replacement = document.createElement('div');
        document.body.append(source, replacement);
        try {
            act(() => { hook.getCurrent()(source); source.dispatchEvent(dragEvent('dragstart')); });
            await act(async () => { hook.getCurrent()(null); await Promise.resolve(); });
            expect(runtime.getSnapshot().phase).toBe('idle');
            act(() => { hook.getCurrent()(source); source.dispatchEvent(dragEvent('dragstart')); hook.getCurrent()(replacement); });
            expect(runtime.getSnapshot().phase).toBe('idle');
            act(() => { replacement.dispatchEvent(dragEvent('dragstart')); });
            expect(runtime.getSnapshot().phase).toBe('carrying');
            await hook.unmount();
            expect(runtime.getSnapshot().phase).toBe('idle');
        } finally {
            source.remove(); replacement.remove(); await hook.unmount();
        }
    });

    it('keeps browser drag delivery alive when the browser retires its pointer stream', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'destination', scope, href: '/inbox' }) });
        let opened: unknown = null;
        runtime.registerTarget({ id: 'rail', scope, acceptedKinds: ['destination'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            resolve: () => ({ status: 'allowed', effect: { actionId: 'workspace.tabs.open', input: { href: '/inbox' }, preview: { verb: 'Open', target: 'Inbox' } } }),
            execute: async effect => { opened = effect.input; return { status: 'applied' }; },
        });
        const sourceHook = await renderHook(() => useEntityDragDomBinding({ runtime, sourceId: 'source', enabled: true }));
        const targetHook = await renderHook(() => useEntityDropDomBinding(runtime));
        const source = document.createElement('div');
        const target = document.createElement('div');
        document.body.append(source, target);
        const stop = installEntityDragCancellation(runtime, window);
        act(() => { sourceHook.getCurrent()(source); targetHook.getCurrent()(target); });
        try {
            act(() => {
                source.dispatchEvent(dragEvent('dragstart'));
                source.dispatchEvent(new Event('pointercancel', { bubbles: true }));
                source.dispatchEvent(new Event('lostpointercapture', { bubbles: true }));
            });
            expect(runtime.getSnapshot().phase).toBe('carrying');
            const over = dragEvent('dragover');
            act(() => { target.dispatchEvent(over); });
            expect(over.defaultPrevented).toBe(true);
            await act(async () => { target.dispatchEvent(dragEvent('drop')); });
            expect(opened).toEqual({ href: '/inbox' });
            act(() => { source.dispatchEvent(dragEvent('dragend')); });
            runtime.begin('source');
            window.dispatchEvent(new Event('pointercancel'));
            expect(runtime.getSnapshot().phase).toBe('idle');
            // Genuine cancel signals still terminate HTML delivery, and a prevented
            // dragstart cannot suppress the next ordinary pointer cancellation.
            for (const event of [new KeyboardEvent('keydown', { key: 'Escape' }), new Event('blur'),
                new MouseEvent('pointerleave', { relatedTarget: null })]) {
                source.dispatchEvent(dragEvent('dragstart'));
                window.dispatchEvent(event);
                expect(runtime.getSnapshot().phase).toBe('idle');
            }
            const prevented = dragEvent('dragstart');
            prevented.preventDefault();
            source.dispatchEvent(prevented);
            window.dispatchEvent(new Event('pointercancel'));
            expect(runtime.getSnapshot().phase).toBe('idle');
        } finally {
            stop(); source.remove(); target.remove();
            await sourceHook.unmount(); await targetHook.unmount();
        }
    });
    it('cancels dragover only for an admitted target, leaving invalid Sessions/tree destinations unaccepted', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'session', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 's1' } }) });
        runtime.registerTarget({ id: 'tree', scope, acceptedKinds: ['session'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            resolve: () => ({ status: 'refused', reason: { code: 'no-change', message: 'Already here' } }),
            execute: async () => { throw new Error('Refused target must not write'); },
        });
        const hook = await renderHook(() => useEntityDropDomBinding(runtime));
        const target = document.createElement('div');
        act(() => { hook.getCurrent()(target); runtime.begin('session'); });
        const over = dragEvent('dragover');
        target.dispatchEvent(over);
        expect(over.defaultPrevented).toBe(false);
        const drop = dragEvent('drop');
        await act(async () => { target.dispatchEvent(drop); });
        expect(drop.defaultPrevented).toBe(false);
        expect(runtime.getSnapshot().phase).toBe('carrying');
        runtime.cancel(); await hook.unmount();
    });
    it('a Session binding wrapper owns refused app input before a child editor, while Files stay with the child', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'session', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 's1' } }) });
        runtime.registerTarget({ id: 'binding', scope, acceptedKinds: ['session'], captureKinds: ['session'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            resolve: () => ({ status: 'refused', reason: { code: 'wrong-machine', message: 'Wrong machine' } }),
            execute: async () => { throw new Error('Refused binding must never write'); },
        });
        let composerWrites = 0;
        runtime.registerTarget({ id: 'composer', scope, acceptedKinds: ['session'],
            getBounds: () => ({ x: 25, y: 25, width: 50, height: 50 }),
            resolve: () => ({ status: 'allowed', effect: { actionId: 'composer.transaction.apply', input: {}, preview: { verb: 'Add', target: 'Composer' } } }),
            execute: async () => { composerWrites++; return { status: 'applied' }; },
        });
        const hook = await renderHook(() => useEntityDropDomBinding(runtime, { captureKinds: ['session'] }));
        const wrapper = document.createElement('div');
        const editor = document.createElement('textarea');
        wrapper.appendChild(editor);
        let editorDrops = 0;
        editor.addEventListener('drop', event => {
            editorDrops++;
            editor.value = (event as DragEvent).dataTransfer?.getData('text/plain') ?? '';
        });
        act(() => hook.getCurrent()(wrapper));
        runtime.begin('session');
        const refused = dragEvent('drop');
        Object.defineProperty(refused, 'dataTransfer', { value: {
            types: ['text/plain'], getData: () => JSON.stringify({ kind: 'session', scope, address: { serverId: 'home', sessionId: 's1' } }),
        } });
        await act(async () => { editor.dispatchEvent(refused); });
        expect(refused.defaultPrevented).toBe(true);
        expect(editorDrops).toBe(0);
        expect(editor.value).toBe('');
        expect(composerWrites).toBe(0);
        expect(runtime.getSnapshot().outcome).toMatchObject({ status: 'refused' });
        runtime.cancel();
        const files = dragEvent('drop');
        Object.defineProperty(files, 'dataTransfer', { value: { types: ['Files'], files: [new File(['contents'], 'review.txt')], getData: () => '' } });
        editor.dispatchEvent(files);
        expect(files.defaultPrevented).toBe(false);
        expect(editorDrops).toBe(1);
        await hook.unmount();
    });
    it('flushes buffered input before final admission rather than applying a stale revision', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        let revision = 1;
        let appliedRevision: unknown = null;
        runtime.registerSource({ id: 'source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 's1' } }) });
        runtime.registerTarget({ id: 'composer', scope, acceptedKinds: ['session'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            resolve: () => ({ status: 'allowed', effect: { actionId: 'composer.transaction.apply', input: { revision }, preview: { verb: 'Add', target: 'Composer' } } }),
            execute: async effect => {
                const input = effect.input;
                if (!input || typeof input !== 'object' || Array.isArray(input)
                    || !('revision' in input) || typeof input.revision !== 'number') {
                    throw new Error('Expected a revision effect input');
                }
                appliedRevision = input.revision;
                return { status: 'applied' };
            },
        });
        const hook = await renderHook(() => useEntityDropDomBinding(runtime, { captureKinds: [], beforeRelease: () => { revision = 2; } }));
        const editor = document.createElement('textarea');
        act(() => hook.getCurrent()(editor));
        runtime.begin('source');
        runtime.move({ x: 50, y: 50 });
        expect(revision).toBe(1);
        await act(async () => { editor.dispatchEvent(dragEvent('drop')); });
        expect(appliedRevision).toBe(2);
        await hook.unmount();
    });
    it('cancels an unsuccessful browser end and releases nested targets only once', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'destination', scope, href: '/inbox' }) });
        let writes = 0;
        runtime.registerTarget({ id: 'target', scope, acceptedKinds: ['destination'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            resolve: () => ({ status: 'allowed', effect: { actionId: 'workspace.tabs.open', input: { href: '/inbox' }, preview: { verb: 'Open', target: 'Inbox' } } }),
            execute: async () => { writes++; return { status: 'applied' }; },
        });
        const sourceHook = await renderHook(() => useEntityDragDomBinding({ runtime, sourceId: 'source', enabled: true }));
        const targetHook = await renderHook(() => useEntityDropDomBinding(runtime));
        const outerHook = await renderHook(() => useEntityDropDomBinding(runtime));
        const source = document.createElement('div');
        const outer = document.createElement('div');
        const target = document.createElement('div');
        outer.appendChild(target);
        act(() => {
            sourceHook.getCurrent()(source);
            targetHook.getCurrent()(target);
            outerHook.getCurrent()(outer);
            source.dispatchEvent(dragEvent('dragstart'));
            source.dispatchEvent(dragEvent('dragend'));
        });
        expect(writes).toBe(0);
        expect(runtime.getSnapshot().phase).toBe('idle');
        await act(async () => {
            source.dispatchEvent(dragEvent('dragstart'));
            target.dispatchEvent(dragEvent('drop'));
            source.dispatchEvent(dragEvent('dragend'));
            await Promise.resolve();
        });
        expect(writes).toBe(1);
        expect(runtime.getSnapshot().outcome).toEqual({ status: 'applied' });
        await sourceHook.unmount();
        await targetHook.unmount();
        await outerHook.unmount();
    });
});
