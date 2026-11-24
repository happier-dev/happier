import { describe, expect, it } from 'vitest';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserSidecarCdpControlAdapter } from './controlAdapter';

describe('Browser binding recovery', () => {
    it('retains the recovered page for a second subscriber when an old close settles late', async () => {
        let finishClose!: (value: { success: boolean }) => void;
        let page = 0;
        const broker = createBrowserDaemonControlBroker();
        // Only Chromium's CDP boundary is substituted; routing and binding lifecycle are real.
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'original', sidecarId: 'holder',
            transport: {
                openPage: async () => ({ targetId: `page-${++page}` }),
                dispatchPageCommand: async () => ({}),
                dispatchBrowserCommand: async () => new Promise<{ success: boolean }>(resolve => { finishClose = resolve; }),
            } });
        const unregister = broker.registerAdapter(adapter);
        const first: string[] = [];
        const second: string[] = [];
        const detachFirst = adapter.subscribeViewLifecycle(event => first.push(event.type));
        const detachSecond = adapter.subscribeViewLifecycle(event => second.push(event.type));
        const view = { browserSessionId: 'original', viewId: 'retained' };
        const open = { ...view, kind: 'openView' as const, commandId: 'open', platform: 'web' as const,
            target: { kind: 'externalUrl' as const, targetId: 'fixture', url: 'https://page.invalid/' } };
        try {
            expect(await broker.dispatchCommand(open)).toMatchObject({ status: 'dispatched' });
            const closing = broker.dispatchCommand({ ...view, kind: 'closeView', commandId: 'old-close' });
            expect(await broker.dispatchCommand({ ...open, commandId: 'retry' })).toMatchObject({ status: 'dispatched' });
            detachFirst();
            finishClose({ success: true });
            await closing;
            expect(adapter.resolvePageHandle(view)).toEqual({ targetId: 'page-2' });
            expect(second).toEqual(['bound', 'bound']);
            expect(await broker.dispatchCommand({ ...view, kind: 'reload', commandId: 'next-request' }))
                .toMatchObject({ status: 'dispatched' });
        } finally {
            detachFirst();
            detachSecond();
            unregister();
            adapter.dispose();
        }
    });
});
