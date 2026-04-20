import { describe, expect, it } from 'vitest';

describe('resolveUiPostinstallTasks', () => {
    it('keeps the remaining web-asset tasks but omits browser Kokoro vendoring by default', async () => {
        const mod: any = await import('../../../tools/resolveUiPostinstallTasks.mjs');
        expect(typeof mod.resolveUiPostinstallTasks).toBe('function');

        const tasks = mod.resolveUiPostinstallTasks({ env: {} });
        expect(tasks).toEqual(
            expect.arrayContaining([
                'setup-skia-web',
                'vendor-monaco',
                'vendor-pierre-diffs-worker',
                'vendor-codemirror-webview-bundle',
                'vendor-xterm-webview-bundle',
            ]),
        );
        expect(tasks).not.toContain('vendor-kokoro-web');
    });

    it('skips web-asset tasks when HAPPIER_UI_VENDOR_WEB_ASSETS=0', async () => {
        const mod: any = await import('../../../tools/resolveUiPostinstallTasks.mjs');
        const tasks = mod.resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '0' } });
        expect(tasks).not.toEqual(
            expect.arrayContaining([
                'setup-skia-web',
                'vendor-monaco',
                'vendor-pierre-diffs-worker',
                'vendor-codemirror-webview-bundle',
                'vendor-xterm-webview-bundle',
            ]),
        );
    });
});
