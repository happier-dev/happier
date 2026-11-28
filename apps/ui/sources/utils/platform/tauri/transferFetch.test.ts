import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDesktopHostInternals, desktopHttpFrame, type DesktopHostCall } from '@/dev/testkit/harness/desktopHttpHost';

import { resolveTauriRuntimeFetch, shouldUseTauriRuntimeFetch } from './transferFetch';

/** Only the native IPC global is fake; Request/Response, Channel and streams stay real. */
function installDesktopHost(answer: (call: DesktopHostCall) => unknown) {
    const host = createDesktopHostInternals(answer);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: host.internals });
    return host;
}

async function desktopFetch(): Promise<NonNullable<Awaited<ReturnType<typeof resolveTauriRuntimeFetch>>>> {
    const fetch = await resolveTauriRuntimeFetch('https://example.test/v1/probe');
    if (!fetch) throw new Error('The desktop transport was not selected');
    return fetch;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('transferFetch', () => {
    it('performs a desktop request with one host invoke carrying status, headers and body', async () => {
        const host = installDesktopHost(({ command }) => {
            if (command !== 'desktop_http_fetch') throw new Error(`Unexpected desktop IPC: ${command}`);
            return desktopHttpFrame({
                status: 201, statusText: 'Created', url: 'https://example.test/v1/probe',
                headers: [['content-type', 'application/json']], streamed: false,
            }, '{"ok":true}');
        });

        const response = await (await desktopFetch())('https://example.test/v1/probe', {
            method: 'POST', headers: { 'x-probe': '1' }, body: 'ping', redirect: 'manual',
        });

        expect(response.status).toBe(201);
        expect(response.url).toBe('https://example.test/v1/probe');
        expect(response.headers.get('content-type')).toBe('application/json');
        expect(await response.json()).toEqual({ ok: true });
        expect(host.calls.map(call => call.command)).toEqual(['desktop_http_fetch']);
        // The request crosses the bridge as one raw frame, never a JSON array of body bytes.
        expect(host.calls[0]!.payload).toBeInstanceOf(Uint8Array);
        expect(host.calls[0]!.args.clientConfig).toMatchObject({
            method: 'POST',
            url: 'https://example.test/v1/probe',
            data: new TextEncoder().encode('ping'),
            maxRedirections: 0,
        });
        expect(host.calls[0]!.args.clientConfig).toHaveProperty('headers', expect.arrayContaining([['x-probe', '1']]));
    });

    it('streams a body the host holds and stops the host when the reader cancels', async () => {
        let channelId: number | undefined;
        const host = installDesktopHost(({ command, args }) => {
            if (command === 'desktop_http_fetch') {
                return desktopHttpFrame({ status: 200, statusText: 'OK', url: 'https://example.test/', headers: [], streamed: true });
            }
            if (command === 'desktop_http_read_body') {
                channelId = (args.channel as { id: number }).id;
                return new Promise(() => {});
            }
            if (command === 'desktop_http_cancel') return null;
            throw new Error(`Unexpected desktop IPC: ${command}`);
        });

        const response = await (await desktopFetch())('https://example.test/');
        const reader = response.body!.getReader();
        const first = reader.read();
        await vi.waitFor(() => expect(channelId).toBeDefined());
        host.deliver(channelId!, { index: 0, message: [66, 0] });
        expect(Array.from((await first).value!)).toEqual([66]);

        await reader.cancel();
        expect(() => host.deliver(channelId!, { index: 1, message: [65, 0] })).not.toThrow();
        const fetchCall = host.calls.find(call => call.command === 'desktop_http_fetch')!;
        expect(host.calls.filter(call => call.command === 'desktop_http_cancel').map(call => call.args.requestId))
            .toEqual([fetchCall.args.requestId]);
    });

    it('cancels the host request when the caller aborts before the response arrives', async () => {
        let rejectFetch!: (error: Error) => void;
        const host = installDesktopHost(({ command }) => {
            if (command === 'desktop_http_fetch') return new Promise((_resolve, reject) => { rejectFetch = reject; });
            if (command === 'desktop_http_cancel') { rejectFetch(new Error('Request cancelled')); return null; }
            throw new Error(`Unexpected desktop IPC: ${command}`);
        });
        const controller = new AbortController();

        const pending = (await desktopFetch())('https://example.test/', { signal: controller.signal });
        await vi.waitFor(() => expect(host.calls).toHaveLength(1));
        controller.abort();

        await expect(pending).rejects.toThrow('Request cancelled');
        expect(host.calls.map(call => call.command)).toEqual(['desktop_http_fetch', 'desktop_http_cancel']);
        expect(host.calls[1]!.args.requestId).toBe(host.calls[0]!.args.requestId);
    });

    it('uses the Tauri runtime fetch only for absolute http/https request targets', () => {
        expect(shouldUseTauriRuntimeFetch('http://127.0.0.1:43123/machine-transfers/direct/exports/x')).toBe(true);
        expect(shouldUseTauriRuntimeFetch('https://machine.example.ts.net/__happier/transfer')).toBe(true);
        expect(shouldUseTauriRuntimeFetch(new URL('https://api.example.test/v1/features'))).toBe(true);
        expect(shouldUseTauriRuntimeFetch(new Request('http://localhost:3000/transfer'))).toBe(true);

        expect(shouldUseTauriRuntimeFetch('/v1/features')).toBe(false);
        expect(shouldUseTauriRuntimeFetch('file:///tmp/happier-transfer.bin')).toBe(false);
        expect(shouldUseTauriRuntimeFetch('')).toBe(false);
        expect(shouldUseTauriRuntimeFetch('not-a-url')).toBe(false);
    });
});
