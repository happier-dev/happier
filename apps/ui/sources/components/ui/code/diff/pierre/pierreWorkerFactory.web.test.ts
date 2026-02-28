import { describe, expect, it } from 'vitest';

describe('createPierreDiffWorker', () => {
    it('uses window.location.origin (not document.baseURI) for the worker URL base', async () => {
        let capturedUrl: { origin: string; pathname: string } | null = null;
        let capturedOptions: any = null;

        (globalThis as any).window = { location: { origin: 'https://good.example' } };
        (globalThis as any).document = { baseURI: 'https://evil.example/app/' };
        (globalThis as any).Worker = function Worker(url: any, options: any) {
            const parsed = url instanceof URL ? url : new URL(String(url));
            capturedUrl = { origin: parsed.origin, pathname: parsed.pathname };
            capturedOptions = options;
            return {} as any;
        } as any;

        const { createPierreDiffWorker } = await import('./pierreWorkerFactory.web');
        createPierreDiffWorker();

        expect(capturedUrl).toBeTruthy();
        expect(capturedUrl!.origin).toBe('https://good.example');
        expect(capturedUrl!.pathname).toBe('/pierre-diff-worker.js');
        expect(capturedOptions).toEqual(expect.objectContaining({ type: 'module' }));
    });
});
