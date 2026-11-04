import { PassThrough } from 'node:stream';
import type { BrowserCommandV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserSidecarCdpControlAdapterFactory } from './controlAdapterFactory';

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

    it('opens a view through the real pipe connector and closes its descriptors on disposal', async () => {
        const readable = new PassThrough();
        const writable = new PassThrough();
        const commands: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
        let pending = '';
        writable.on('data', chunk => {
            pending += chunk.toString('utf8');
            for (;;) {
                const end = pending.indexOf('\0');
                if (end < 0) return;
                const command = JSON.parse(pending.slice(0, end)) as typeof commands[number];
                pending = pending.slice(end + 1);
                commands.push(command);
                const result = command.method === 'Target.createTarget' ? { targetId: 'target_secret' }
                    : command.method === 'Target.attachToTarget' ? { sessionId: 'session_secret' } : {};
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

        await result.dispose?.();
        expect(readable.destroyed).toBe(true);
        expect(writable.destroyed).toBe(true);
    });
});
