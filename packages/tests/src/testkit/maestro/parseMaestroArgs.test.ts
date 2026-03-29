import { describe, expect, it } from 'vitest';

describe('parseMaestroArgs', () => {
    it('parses flows/appId/platform/serverUrl, skip-app-install-check, and preserves passthrough args', async () => {
        const mod = await import('../../../scripts/runMaestroWithHeartbeat.shared.mjs');
        const parseMaestroArgs: (argv: string[]) => any = mod.parseMaestroArgs;

        const parsed = parseMaestroArgs([
            'node',
            'script',
            '--flows',
            'flows-dir',
            '--appId',
            'my.app',
            '--platform=android',
            '--serverUrl=http://127.0.0.1:24580',
            '--skip-app-install-check',
            '--some-flag',
            'x',
        ]);

        expect(parsed).toEqual({
            flows: 'flows-dir',
            appId: 'my.app',
            platform: 'android',
            serverUrl: 'http://127.0.0.1:24580',
            skipAppInstallCheck: true,
            passThrough: ['--some-flag', 'x'],
        });
    });
});
