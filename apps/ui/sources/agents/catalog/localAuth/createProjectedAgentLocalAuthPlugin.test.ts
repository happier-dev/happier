import { describe, expect, it } from 'vitest';

import { createProjectedAgentLocalAuthPlugin } from './createProjectedAgentLocalAuthPlugin';

describe('createProjectedAgentLocalAuthPlugin', () => {
    it('exposes ordered native login actions and executes them with the host-resolved command', () => {
        const plugin = createProjectedAgentLocalAuthPlugin({
            agentId: 'acme',
            cli: {
                executable: {
                    binaryName: 'acme',
                    sourcePreference: 'system-first',
                },
                install: {
                    manual: { kind: 'none' },
                    docsUrl: 'https://example.com/acme/auth',
                },
                auth: {
                    support: 'login_terminal',
                    probe: {
                        parser: 'unknown',
                        backgroundChecks: 'safe',
                    },
                    loginLaunches: [
                        { kind: 'primary', args: ['login'] },
                        { kind: 'device_code', args: ['login', '--device-code'] },
                    ],
                },
            },
        });

        expect(plugin.loginLaunchKinds).toEqual(['primary', 'device_code']);
        expect(plugin.docsUrl).toBe('https://example.com/acme/auth');
        expect(plugin.buildLoginLaunch?.({
            kind: 'primary',
            resolvedCommand: "'/opt/runtime/bun' '/opt/acme/acme.js'",
            platform: 'darwin',
        })).toEqual({
            initialCommand: "'/opt/runtime/bun' '/opt/acme/acme.js' login",
        });
        expect(plugin.buildLoginLaunch?.({
            kind: 'device_code',
            resolvedPath: '/Applications/Acme CLI/bin/acme',
            platform: 'darwin',
        })).toEqual({
            initialCommand: "'/Applications/Acme CLI/bin/acme' login --device-code",
        });
    });

    it('preserves each declared login argument as one shell argument', () => {
        const plugin = createProjectedAgentLocalAuthPlugin({
            agentId: 'acme',
            cli: {
                executable: {
                    binaryName: 'acme',
                    sourcePreference: 'system-first',
                },
                install: {
                    manual: { kind: 'none' },
                },
                auth: {
                    support: 'login_terminal',
                    probe: {
                        parser: 'unknown',
                        backgroundChecks: 'safe',
                    },
                    loginLaunches: [{
                        kind: 'primary',
                        args: ['login', '--account', 'Jane Doe', '$(touch /tmp/not-run)', "O'Brien"],
                    }],
                },
            },
        });

        expect(plugin.buildLoginLaunch?.({
            kind: 'primary',
            resolvedPath: '/opt/acme',
            platform: 'darwin',
        })).toEqual({
            initialCommand: "/opt/acme login --account 'Jane Doe' '$(touch /tmp/not-run)' 'O'\\''Brien'",
        });
    });
});
