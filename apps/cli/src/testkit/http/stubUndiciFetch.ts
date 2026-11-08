import * as undici from 'undici';
import { onTestFinished, vi, type MockedFunction } from 'vitest';

vi.mock('undici', async importOriginal => {
    const runtime = await importOriginal<typeof import('undici')>();
    return { ...runtime, fetch: vi.fn(runtime.fetch) };
});

/** Substitute only bundled Undici's HTTP boundary, retaining its real dispatcher. */
export function stubUndiciFetch<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>): MockedFunction<typeof undici.fetch> {
    const boundary = vi.mocked(undici.fetch);
    // Boundary fixtures use standard Fetch types; the transport supplies Undici's ABI.
    boundary.mockImplementation(handler as unknown as typeof undici.fetch);
    onTestFinished(() => boundary.mockReset());
    return boundary;
}
