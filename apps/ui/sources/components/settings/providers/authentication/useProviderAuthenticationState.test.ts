import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { useProviderAuthenticationState } from './useProviderAuthenticationState';
import type { CLIAvailability } from '@/hooks/auth/useCLIDetection';
import type { ProviderLocalAuthPlugin } from '@/agents/providers/shared/providerLocalAuthPlugin';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderHookState(run: () => unknown) {
    let latest: unknown = null;
    function Test() {
        latest = run();
        return React.createElement('View');
    }

    act(() => {
        renderer.create(React.createElement(Test));
    });

    return latest as any;
}

describe('useProviderAuthenticationState', () => {
    it('passes resolvedCommand to buildLoginLaunch when available', () => {
        const buildLoginLaunchMock = ({ resolvedPath, resolvedCommand }: { resolvedPath?: string | null; resolvedCommand?: string | null }) => ({
            initialCommand: resolvedCommand ?? (resolvedPath ? `${resolvedPath} login` : 'codex login'),
        });

        const authPlugin: ProviderLocalAuthPlugin = {
            providerId: 'codex',
            support: 'login_terminal',
            buildLoginLaunch: buildLoginLaunchMock,
            docsUrl: undefined,
            statusHelpText: undefined,
        };

        const cliAvailability: CLIAvailability = {
            available: { codex: true } as any,
            login: { codex: null } as any,
            authStatus: { codex: null } as any,
            resolvedPath: { codex: '/opt/codex/bin/codex' } as any,
            resolvedCommand: { codex: `'/opt/codex/bin/codex'` } as any,
            resolutionSource: { codex: 'system' } as any,
            tmux: null,
            isDetecting: false,
            timestamp: 123,
            refresh: () => {},
        };

        const primaryMachine = {
            id: 'm1',
            metadata: { homeDir: '/home/user' },
        };

        const result = renderHookState(() =>
            useProviderAuthenticationState({
                providerId: 'codex' as any,
                cliAvailability,
                authPlugin,
                primaryMachine,
            })
        );

        expect(result.loginLaunch?.initialCommand).toBe(`'/opt/codex/bin/codex'`);
    });

    it('passes null resolvedPath when CLI is not available', () => {
        const buildLoginLaunchMock = ({ resolvedPath }: { resolvedPath?: string | null }) => ({
            initialCommand: resolvedPath ? `${resolvedPath} login` : 'codex login',
        });

        const authPlugin: ProviderLocalAuthPlugin = {
            providerId: 'codex',
            support: 'login_terminal',
            buildLoginLaunch: buildLoginLaunchMock,
            docsUrl: undefined,
            statusHelpText: undefined,
        };

        const cliAvailability: CLIAvailability = {
            available: { codex: false } as any,
            login: { codex: null } as any,
            authStatus: { codex: null } as any,
            resolvedPath: { codex: null } as any,
            resolvedCommand: { codex: null } as any,
            resolutionSource: { codex: null } as any,
            tmux: null,
            isDetecting: false,
            timestamp: 123,
            refresh: () => {},
        };

        const primaryMachine = {
            id: 'm1',
            metadata: { homeDir: '/home/user' },
        };

        const result = renderHookState(() =>
            useProviderAuthenticationState({
                providerId: 'codex' as any,
                cliAvailability,
                authPlugin,
                primaryMachine,
            })
        );

        expect(result.loginLaunch?.initialCommand).toBe('codex login');
    });

    it('allows launching the login terminal when the machine home directory is unavailable', () => {
        const authPlugin: ProviderLocalAuthPlugin = {
            providerId: 'codex',
            support: 'login_terminal',
            buildLoginLaunch: () => ({ initialCommand: 'codex login' }),
            docsUrl: undefined,
            statusHelpText: undefined,
        };

        const cliAvailability: CLIAvailability = {
            available: { codex: true } as any,
            login: { codex: null } as any,
            authStatus: { codex: null } as any,
            resolvedPath: { codex: '/opt/codex/bin/codex' } as any,
            resolvedCommand: { codex: `'/opt/codex/bin/codex'` } as any,
            resolutionSource: { codex: 'system' } as any,
            tmux: null,
            isDetecting: false,
            timestamp: 123,
            refresh: () => {},
        };

        const primaryMachine = {
            id: 'm1',
            metadata: {},
        };

        const result = renderHookState(() =>
            useProviderAuthenticationState({
                providerId: 'codex' as any,
                cliAvailability,
                authPlugin,
                primaryMachine,
            })
        );

        expect(result.canLaunchLogin).toBe(true);
        expect(result.machineHomeDir).toBe(null);
    });
});
