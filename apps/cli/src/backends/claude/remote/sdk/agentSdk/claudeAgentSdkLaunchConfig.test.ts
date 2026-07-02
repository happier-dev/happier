import { describe, expect, it } from 'vitest';

import { buildClaudeAgentSdkSubprocessEnv } from './claudeAgentSdkLaunchConfig';

describe('buildClaudeAgentSdkSubprocessEnv', () => {
    it('preserves Windows Path casing in the SDK subprocess environment', () => {
        const result = buildClaudeAgentSdkSubprocessEnv({
            claudeConfigDir: null,
            xdgIsolationEnv: {},
            experimentalEnvOverlay: {},
            env: {
                Path: 'C:\\Windows\\System32',
                PATH: undefined,
                HOME: 'C:\\Users\\tester',
            },
            platform: 'win32',
        });

        expect(result.Path).toBe('C:\\Windows\\System32');
        expect('PATH' in result).toBe(false);
    });
});
