import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { SessionListMoveSheet } from './SessionListMoveSheet';

describe('SessionListMoveSheet runtime destinations', () => {
    it('retires an open chooser when its canonical carry is cancelled externally', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'source', scope, getItem: () => ({ kind: 'session', scope,
            address: { serverId: 'home', sessionId: 'session' } }), isCurrent: () => true });
        const onCancel = vi.fn();
        const screen = await renderScreen(<SessionListMoveSheet sourceLabel="Session" runtime={runtime} sourceId="source" onCancel={onCancel} />);
        expect(onCancel).not.toHaveBeenCalled();
        await act(async () => runtime.cancel('account-retired'));
        expect(onCancel).toHaveBeenCalledOnce();
        await screen.unmount();
    });
    it('offers a mounted pane and its refusal, then executes the selected destination through the owner', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        const item = { kind: 'session', scope, address: { serverId: 'home', sessionId: 'session' } } as const;
        runtime.registerSource({ id: 'source', scope, getItem: () => item, isCurrent: () => true });
        let opened = false;
        runtime.registerTarget({ id: 'pane', scope, acceptedKinds: ['session'], getBounds: () => null,
            listDestinations: () => [{ destination: { zone: 'center' }, label: 'Open in pane' }],
            resolve: () => ({ status: 'allowed', effect: { actionId: 'workspace.tabs.open', input: {}, preview: { verb: 'Open', target: 'Pane' } } }),
            execute: async () => { opened = true; return { status: 'applied' }; } });
        runtime.registerTarget({ id: 'workflow', scope, acceptedKinds: ['session'], getBounds: () => null,
            listDestinations: () => [{ destination: null, label: 'Bind conversation' }],
            resolve: () => ({ status: 'refused', reason: { code: 'where-machine', message: 'Choose the matching machine' } }),
            execute: async () => { throw new Error('A refused destination cannot dispatch'); } });
        const screen = await renderScreen(<SessionListMoveSheet sourceLabel="Session" runtime={runtime} sourceId="source" onCancel={vi.fn()} />);
        const refused = screen.findByTestId('session-list-move-sheet:root:option:1');
        expect(refused?.props.disabled).toBe(true);
        await act(async () => { invokeTestInstanceHandler(refused, 'onPress'); });
        expect(opened).toBe(false);
        await act(async () => { invokeTestInstanceHandler(screen.findByTestId('session-list-move-sheet:root:option:0'), 'onPress'); });
        expect(opened).toBe(true);
        expect(runtime.getSnapshot().outcome).toEqual({ status: 'applied' });
        await screen.unmount();
    });
});
