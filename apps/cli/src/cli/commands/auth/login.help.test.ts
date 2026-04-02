import { describe, expect, it } from 'vitest';

import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';

import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings, writeCredentialsDataKey } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

import { handleAuthCommand } from '../auth';

const envKeys = ['HAPPIER_HOME_DIR'] as const;
let envScope = createEnvKeyScope(envKeys);

describe('happier auth login --help', () => {
    it('prints auth help even when already authenticated', async () => {
        const prevExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
            await withTempDir('happier-auth-login-help-', async (home) => {
                const output = captureConsoleText();

                try {
                    envScope.patch({ HAPPIER_HOME_DIR: home });
                    reloadConfiguration();

                    const machineKey = new Uint8Array(32).fill(7);
                    await writeCredentialsDataKey({
                        token: 'token_super_secret',
                        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
                        machineKey,
                    });
                    await updateSettings((settings) => ({
                        ...settings,
                        machineIdByServerId: {
                            ...(settings.machineIdByServerId ?? {}),
                            [configuration.activeServerId ?? 'cloud']: 'mid_123',
                        },
                    }));

                    await handleAuthCommand(['login', '--help']);

                    const text = output.text();
                    expect(text).toContain('happier auth');
                    expect(text).toContain('Authenticate with Happier');
                    expect(text).not.toMatch(/Already authenticated/i);
                    expect(process.exitCode ?? 0).toBe(0);
                } finally {
                    output.restore();
                }
            });
        } finally {
            envScope.restore();
            envScope = createEnvKeyScope(envKeys);
            reloadConfiguration();
            process.exitCode = prevExitCode;
        }
    });
});
