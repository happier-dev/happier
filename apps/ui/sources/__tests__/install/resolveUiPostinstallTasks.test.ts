import { describe, expect, it } from 'vitest';

describe('resolveUiPostinstallTasks', () => {
    it('includes web-asset tasks by default', async () => {
        const mod: any = await import('../../../tools/resolveUiPostinstallTasks.mjs');
        expect(typeof mod.resolveUiPostinstallTasks).toBe('function');

        const tasks = mod.resolveUiPostinstallTasks({ env: {} });
        expect(tasks).toEqual(
            expect.arrayContaining([
                'verify-expo-router-web-modal-patch',
                'verify-react-native-enriched-markdown-web-streaming-patch',
                'setup-skia-web',
                'vendor-monaco',
                'vendor-kokoro-web',
                'vendor-pierre-diffs-worker',
                'vendor-codemirror-webview-bundle',
                'vendor-xterm-webview-bundle',
            ]),
        );
    });

    it('skips web-asset tasks when HAPPIER_UI_VENDOR_WEB_ASSETS=0', async () => {
        const mod: any = await import('../../../tools/resolveUiPostinstallTasks.mjs');
        const tasks = mod.resolveUiPostinstallTasks({ env: { HAPPIER_UI_VENDOR_WEB_ASSETS: '0' } });
        expect(tasks).toContain('verify-expo-router-web-modal-patch');
        expect(tasks).toContain('verify-react-native-enriched-markdown-web-streaming-patch');
        expect(tasks).not.toEqual(
            expect.arrayContaining([
                'setup-skia-web',
                'vendor-monaco',
                'vendor-kokoro-web',
                'vendor-pierre-diffs-worker',
                'vendor-codemirror-webview-bundle',
                'vendor-xterm-webview-bundle',
            ]),
        );
    });
});
