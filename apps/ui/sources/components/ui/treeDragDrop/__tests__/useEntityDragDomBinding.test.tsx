// @vitest-environment jsdom
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { createEntityDragDropRuntime } from '../entityDragDropRuntime';
import { useEntityDragDomBinding, useEntityDropDomBinding } from '../useEntityDragDomBinding';

installPanelCommonModuleMocks();

function dragEvent(type: string) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { clientX: { value: 50 }, clientY: { value: 50 } });
    return event;
}

describe('entity DOM carry boundary', () => {
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
