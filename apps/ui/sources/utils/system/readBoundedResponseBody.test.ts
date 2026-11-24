import { describe, expect, it, vi } from 'vitest';
import { readBoundedResponseBody } from './readBoundedResponseBody';

// Native Home RPC constructs RN's global Response: bytes exist without a stream.
function bufferedResponse(bytes: Uint8Array, declaredLength?: number): Response {
    const response = new Response(Uint8Array.from(bytes), { headers: declaredLength === undefined
        ? {} : { 'content-length': String(declaredLength) } });
    Object.defineProperty(response, 'body', { value: undefined });
    return response;
}

describe('readBoundedResponseBody buffered native responses', () => {
    it('keeps a browser null body typed as missing', async () => {
        await expect(readBoundedResponseBody({ response: new Response(null), maxBytes: 4 }))
            .rejects.toMatchObject({ code: 'body_missing' });
    });
    it('reads exact binary bytes without a stream, including an empty response', async () => {
        for (const bytes of [new Uint8Array([0, 255, 128, 1]), new Uint8Array()]) {
            await expect(readBoundedResponseBody({ response: bufferedResponse(bytes), maxBytes: bytes.length }))
                .resolves.toEqual(bytes);
        }
    });
    it('rejects a declared oversize before reading bytes', async () => {
        const response = bufferedResponse(new Uint8Array([1]), 5);
        const read = vi.spyOn(response, 'arrayBuffer');
        await expect(readBoundedResponseBody({ response, maxBytes: 4 })).rejects.toMatchObject({ code: 'body_too_large' });
        expect(read).not.toHaveBeenCalled();
    });
    it.each([undefined, 1])('checks actual bytes even when declared length is %s', async declaredLength => {
        await expect(readBoundedResponseBody({ response: bufferedResponse(new Uint8Array(5), declaredLength), maxBytes: 4 }))
            .rejects.toMatchObject({ code: 'body_too_large' });
    });
    it('preserves typed read failure', async () => {
        const response = bufferedResponse(new Uint8Array());
        vi.spyOn(response, 'arrayBuffer').mockRejectedValue(new Error('boundary failed'));
        await expect(readBoundedResponseBody({ response, maxBytes: 4 })).rejects.toMatchObject({ code: 'read_failed' });
    });
    it('does not read an already aborted response', async () => {
        const response = bufferedResponse(new Uint8Array());
        const read = vi.spyOn(response, 'arrayBuffer');
        const controller = new AbortController();
        controller.abort();
        await expect(readBoundedResponseBody({ response, maxBytes: 4, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
        expect(read).not.toHaveBeenCalled();
    });
    it.each([false, true])('preserves abort after buffered read settles (rejects=%s)', async rejects => {
        const response = bufferedResponse(new Uint8Array([1]));
        const controller = new AbortController();
        vi.spyOn(response, 'arrayBuffer').mockImplementation(async () => {
            controller.abort();
            if (rejects) throw new Error('native abort');
            return new ArrayBuffer(1);
        });
        await expect(readBoundedResponseBody({ response, maxBytes: 4, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    });
});
