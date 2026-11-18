import { PassThrough } from 'node:stream';
import type { BrowserCommandV1, BrowserEventV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserSidecarCdpControlAdapterFactory } from './controlAdapterFactory';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonViewDiscovery } from '../control/viewDiscovery';

function openViewCommand(): Extract<BrowserCommandV1, { kind: 'openView' }> {
    return {
        kind: 'openView',
        commandId: 'command_open',
        browserSessionId: 'browser_session_factory',
        viewId: 'view_factory',
        platform: 'web',
        focus: true,
        target: {
            kind: 'externalUrl',
            targetId: 'target_factory',
            url: 'https://browser.example.test/factory',
        },
    };
}

describe('browser sidecar CDP control adapter factory', () => {
    it('returns cdp_unavailable without private details when transport connection fails', async () => {
        const connectTransport = vi.fn(async () => {
            throw new Error('connect failed at ws://127.0.0.1:9222/devtools/browser/secret-token');
        });
        const factory = createBrowserSidecarCdpControlAdapterFactory({
            browserSessionId: 'browser_session_factory',
            sidecarId: 'sidecar_factory',
            pipe: { readable: new PassThrough(), writable: new PassThrough() },
            connectTransport,
        });

        const result = await factory({ machineId: 'machine_1' });

        expect(connectTransport).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            ok: false,
            errorCode: 'cdp_unavailable',
        });
        expect(JSON.stringify(result)).not.toContain('ws://');
        expect(JSON.stringify(result)).not.toContain('secret-token');
    });

    it.each(['readableEnd', 'writableClose'] as const)('retires every bound view when its real CDP pipe closes (%s)', async closure => {
        const readable = new PassThrough();
        const writable = new PassThrough();
        const commands: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
        let pending = '';
        let openedPages = 0;
        let attachedPages = 0;
        writable.on('data', chunk => {
            pending += chunk.toString('utf8');
            for (;;) {
                const end = pending.indexOf('\0');
                if (end < 0) return;
                const command = JSON.parse(pending.slice(0, end)) as typeof commands[number];
                pending = pending.slice(end + 1);
                commands.push(command);
                const result = command.method === 'Target.createTarget' ? { targetId: ++openedPages === 1 ? 'target_secret' : 'target_sibling_secret' }
                    : command.method === 'Target.attachToTarget' ? { sessionId: ++attachedPages === 1 ? 'session_secret' : 'session_sibling_secret' } : {};
                readable.write(Buffer.from(`${JSON.stringify({ id: command.id, result })}\0`));
            }
        });
        const factory = createBrowserSidecarCdpControlAdapterFactory({
            browserSessionId: 'browser_session_factory',
            sidecarId: 'sidecar_factory',
            pipe: { readable, writable },
        });

        const result = await factory({ machineId: 'machine_1' });

        expect(result).toMatchObject({
            ok: true,
            adapter: {
                adapterKind: 'chromiumSidecar',
            },
        });
        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) return;

        const events: BrowserEventV1[] = [];
        const unboundViews: string[] = [];
        result.contextCapture?.subscribeBrowserEvents?.(event => events.push(event));
        result.contextCapture?.subscribeViewLifecycle?.(event => {
            if (event.type === 'unbound') unboundViews.push(event.viewId);
        });
        const dispatched = await result.adapter.dispatchCommand(openViewCommand());

        expect(dispatched).toMatchObject({
            v: 1,
            commandId: 'command_open',
            status: 'dispatched',
            adapterKind: 'chromiumSidecar',
        });
        expect(commands).toEqual(expect.arrayContaining([
            expect.objectContaining({ method: 'Target.createTarget', params: { url: 'https://browser.example.test/factory' } }),
            expect.objectContaining({ method: 'Target.attachToTarget', params: { targetId: 'target_secret', flatten: true } }),
            expect.objectContaining({ method: 'Target.activateTarget', params: { targetId: 'target_secret' } }),
        ]));
        expect(JSON.stringify(dispatched)).not.toContain('target_secret');
        expect(JSON.stringify(dispatched)).not.toContain('session_secret');

        expect(await result.adapter.dispatchCommand({ ...openViewCommand(), commandId: 'open_sibling', viewId: 'view_sibling' }))
            .toMatchObject({ status: 'dispatched' });
        const broker = createBrowserDaemonControlBroker();
        const unregister = broker.registerAdapter(result.adapter);
        const discovery = createBrowserDaemonViewDiscovery({ broker });
        const changedViews = discovery.watchViews({ browserSessionId: 'browser_session_factory',
            knownViewIds: ['view_factory', 'view_sibling'] });
        if (closure === 'readableEnd') readable.end();
        else writable.destroy();
        await vi.waitFor(() => {
            expect(events.filter(event => event.kind === 'adapterUnavailable')).toEqual(expect.arrayContaining([
                expect.objectContaining({ viewId: 'view_factory', reasonCode: 'cdp_transport_closed' }),
                expect.objectContaining({ viewId: 'view_sibling', reasonCode: 'cdp_transport_closed' }),
            ]));
        });
        expect(result.adapter.listViews?.('browser_session_factory')).toEqual([]);
        expect(await changedViews).toEqual([]);
        expect(unboundViews.sort()).toEqual(['view_factory', 'view_sibling']);
        expect(result.contextCapture?.resolvePageHandle(openViewCommand())).toBeNull();
        expect(await result.adapter.dispatchCommand({ ...openViewCommand(), kind: 'stop', commandId: 'stop_after_exit' }))
            .toMatchObject({ status: 'failed', completion: 'known', error: { code: 'adapter_unavailable' } });

        await result.dispose?.();
        unregister();
        expect(readable.destroyed).toBe(true);
        expect(writable.destroyed).toBe(true);
    });
});
