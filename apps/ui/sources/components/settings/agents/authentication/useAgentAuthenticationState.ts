import * as React from 'react';

import type { AgentLocalAuthPlugin } from '@/agents/catalog/localAuth/agentLocalAuthPlugin';
import type { CLIAvailability } from '@/hooks/auth/useCLIDetection';

export type AgentAuthenticationState = Readonly<ReturnType<typeof useAgentAuthenticationState>>;

export function useAgentAuthenticationState(params: Readonly<{
    agentId: string | null;
    cliAvailability: CLIAvailability;
    authPlugin: AgentLocalAuthPlugin | null;
    primaryMachine: Readonly<{
        id: string;
        metadata?: {
            homeDir?: string | null;
            platform?: string | null;
        } | null;
    }> | null;
}>) {
    return React.useMemo(() => {
        if (!params.agentId) {
            return {
                authStatus: null,
                cliAvailable: null,
                machineId: params.primaryMachine?.id ?? null,
                machineHomeDir: params.primaryMachine?.metadata?.homeDir ?? null,
                canCheckNow: false,
                supportsLoginTerminal: false,
                canLaunchLogin: false,
                loginLaunch: null,
                loginActionKind: 'login',
                docsUrl: params.authPlugin?.docsUrl ?? null,
                support: params.authPlugin?.support ?? 'unsupported',
                statusHelpText: params.authPlugin?.statusHelpText ?? null,
            } as const;
        }
        const authStatus = params.cliAvailability.authStatus[params.agentId] ?? null;
        const cliAvailable = params.cliAvailability.available[params.agentId] ?? null;
        const resolvedPath = params.cliAvailability.resolvedPath[params.agentId] ?? null;
        const resolvedCommand = params.cliAvailability.resolvedCommand?.[params.agentId] ?? null;
        const machineMetadata = params.primaryMachine?.metadata as {
            homeDir?: string | null;
            platform?: string | null;
        } | null | undefined;
        const machineId = params.primaryMachine?.id ?? null;
        const machineHomeDir = machineMetadata?.homeDir ?? null;
        const machinePlatform = machineMetadata?.platform ?? null;
        const canCheckNow = Boolean(machineId);
        const supportsLoginTerminal = params.authPlugin?.support === 'login_terminal';
        const loginLaunch = supportsLoginTerminal
            ? (params.authPlugin?.buildLoginLaunch?.({ resolvedPath, resolvedCommand, platform: machinePlatform }) ?? null)
            : null;
        const canLaunchLogin = cliAvailable === true && Boolean(machineId) && Boolean(loginLaunch?.initialCommand);
        const loginActionKind = authStatus?.state === 'logged_in' ? 'reauthenticate' : 'login';

        return {
            authStatus,
            cliAvailable,
            machineId,
            machineHomeDir,
            canCheckNow,
            supportsLoginTerminal,
            canLaunchLogin,
            loginLaunch,
            loginActionKind,
            docsUrl: params.authPlugin?.docsUrl ?? null,
            support: params.authPlugin?.support ?? 'unsupported',
            statusHelpText: params.authPlugin?.statusHelpText ?? null,
        } as const;
    }, [params.authPlugin, params.cliAvailability, params.primaryMachine, params.agentId]);
}
