/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest';

it.each(['real', 'fake'] as const)('preserves binary Fetch Blob bytes, type and FileReader with %s clocks', async clock => {
    if (clock === 'fake') vi.useFakeTimers();
    try {
        const roundTrip = (async () => {
            const bytes = new Uint8Array([0, 255, 128, 13, 10, 34, 65]);
            const response = new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
            const blob = await response.blob();
            const copied = new Response(blob);
            expect(new Uint8Array(await copied.arrayBuffer())).toEqual(bytes);
            expect(copied.headers.get('content-type')).toBe('application/octet-stream');
            const read = await new Promise<ArrayBuffer>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    if (reader.result === null || typeof reader.result === 'string') reject(new Error('Expected binary FileReader result'));
                    else resolve(reader.result);
                };
                reader.onerror = () => reject(reader.error);
                reader.readAsArrayBuffer(blob);
            });
            expect(new Uint8Array(read)).toEqual(bytes);
            const empty = new Response(new Blob([], { type: 'text/plain' }), { headers: { 'content-type': 'application/custom' } });
            expect((await empty.arrayBuffer()).byteLength).toBe(0);
            expect(empty.headers.get('content-type')).toBe('application/custom');
            expect(Response.json({ ok: true })).toBeInstanceOf(Response);
        })();
        // FileReader is asynchronous in JSDOM too. Advance the fake scheduler while
        // awaiting the same operation, rather than leaving its callbacks frozen.
        if (clock === 'fake') await vi.waitFor(() => roundTrip);
        else await roundTrip;
    } finally { vi.useRealTimers(); }
});
