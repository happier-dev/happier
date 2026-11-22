import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('createPierreDiffWorker', () => {
    it('uses window.location.origin (not document.baseURI) for the worker URL base', async () => {
        const workers: { url: URL; options?: WorkerOptions }[] = [];
        vi.stubGlobal('window', { location: { origin: 'https://good.example' } });
        vi.stubGlobal('document', { baseURI: 'https://evil.example/app/' });
        vi.stubGlobal('Worker', class Worker {
            constructor(url: URL, options?: WorkerOptions) {
                workers.push({ url, options });
            }
        });

        const { createPierreDiffWorker } = await import('./pierreWorkerFactory.web');
        const { PIERRE_DIFFS_VERSION } = await import('./pierreVersion');
        createPierreDiffWorker();

        expect(workers[0]?.url.origin).toBe('https://good.example');
        expect(workers[0]?.url.pathname).toBe(`/pierre-diff-worker.${PIERRE_DIFFS_VERSION}.js`);
        expect(workers[0]?.options).toEqual(expect.objectContaining({ type: 'module' }));
    });

    it('keeps the worker protocol version aligned with the exact package pin and installed library', async () => {
        const { PIERRE_DIFFS_VERSION } = await import('./pierreVersion');
        const installedPackageJson = findPackageJSON('@pierre/diffs', import.meta.url);
        if (!installedPackageJson) throw new Error('Expected the installed Pierre package');
        const installed = JSON.parse(readFileSync(installedPackageJson, 'utf8'));
        const app = JSON.parse(readFileSync(new URL('../../../../../../package.json', import.meta.url), 'utf8'));

        expect(PIERRE_DIFFS_VERSION).toBe(app.dependencies['@pierre/diffs']);
        expect(PIERRE_DIFFS_VERSION).toBe(installed.version);
    });
});
