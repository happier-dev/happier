import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { COMPUTER_PROVIDER_INSTALLABLE_KEYS, readComputerUseSettingsForMachine,
    type ComputerProviderIdV1, type ComputerUseSettingsV1 } from '@happier-dev/protocol/computer/v1';
import { BUILT_IN_INSTALLABLES_REGISTRY } from '@happier-dev/protocol/installables';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { changeComputerUseSettings, installComputerProvider, projectComputerProviderRows } from './computerProviderSettings';

export type ComputerProviderSettingsMutation =
    | Readonly<{ phase: 'idle' }>
    | Readonly<{ phase: 'installing'; provider: ComputerProviderIdV1 }>
    | Readonly<{ phase: 'saving' }>
    /** `provider` names the provider whose installation failed; a failed save names none. */
    | Readonly<{ phase: 'failed'; errorCode: string; error: string; provider?: ComputerProviderIdV1 }>;

const request = { requests: Object.values(COMPUTER_PROVIDER_INSTALLABLE_KEYS).map(key => ({
    id: BUILT_IN_INSTALLABLES_REGISTRY.descriptorsByKey[key].descriptor.capabilityId,
})) };

/** The caller supplies only its exact Account's key-scoped computerUseByMachineId subscription. */
export function useComputerProviderSettings(args: Readonly<{
    machineId: string;
    serverId: string;
    accountLifetime: ServerAccountScopeLifetime | null;
    computerUseByMachineId: Readonly<Record<string, ComputerUseSettingsV1>> | null;
    enabled: boolean;
}>) {
    const { execute } = useMountedActionExecution(args.accountLifetime?.scope ?? null);
    const { state, refresh } = useMachineCapabilitiesCache({ machineId: args.machineId, serverId: args.serverId,
        accountLifetime: args.accountLifetime ?? undefined, enabled: args.enabled && args.accountLifetime !== null, request });
    const preferences = React.useMemo(() => args.computerUseByMachineId
        ? readComputerUseSettingsForMachine({ computerUseByMachineId: args.computerUseByMachineId }, args.machineId) : null,
    [args.computerUseByMachineId, args.machineId]);
    const providers = React.useMemo(() => projectComputerProviderRows(preferences, state), [preferences, state]);
    const target = React.useMemo(() => ({ machineId: args.machineId, serverId: args.serverId, lifetime: args.accountLifetime }),
        [args.machineId, args.serverId, args.accountLifetime]);
    const currentTarget = React.useRef(target);
    currentTarget.current = target;
    const [mutationState, setMutationState] = React.useState<{ target: typeof target; mutation: ComputerProviderSettingsMutation }>(
        () => ({ target, mutation: { phase: 'idle' } }));
    const mutation = mutationState.target === target ? mutationState.mutation : { phase: 'idle' as const };
    const run = React.useCallback(async (operation: (publish: (value: ComputerProviderSettingsMutation) => void) => Promise<ActionExecuteResult>): Promise<ActionExecuteResult> => {
        if (!target.lifetime) return { ok: false, errorCode: 'setting_value_unavailable', error: 'Machine preferences are unavailable' };
        let installing: ComputerProviderIdV1 | undefined;
        const publish = (value: ComputerProviderSettingsMutation) => {
            installing = value.phase === 'installing' ? value.provider : undefined;
            if (currentTarget.current === target) setMutationState({ target, mutation: value });
        };
        const failed = (errorCode: string, error: string): ComputerProviderSettingsMutation =>
            ({ phase: 'failed', errorCode, error, ...(installing ? { provider: installing } : {}) });
        try {
            const result = await operation(publish);
            publish(result.ok ? { phase: 'idle' } : failed(result.errorCode, result.error));
            if (result.ok && currentTarget.current === target) refresh({ bypassCache: true });
            return result;
        } catch (error) {
            const result = { ok: false as const, errorCode: 'action_outcome_unknown',
                error: error instanceof Error ? error.message : 'Computer provider settings could not be changed' };
            publish(failed(result.errorCode, result.error));
            return result;
        }
    }, [refresh, target]);
    const change = React.useCallback((next: ComputerUseSettingsV1 | null): Promise<ActionExecuteResult> => {
        if (!preferences || !next) return Promise.resolve({ ok: false, errorCode: 'setting_value_unavailable', error: 'Machine preferences are unavailable' });
        return run(publish => changeComputerUseSettings({ execute, machineId: target.machineId, serverId: target.serverId,
            current: preferences, next, onPhase: publish }));
    }, [execute, preferences, run, target]);
    const installProvider = React.useCallback((provider: ComputerProviderIdV1) => run(publish => {
        publish({ phase: 'installing', provider });
        return installComputerProvider({ execute, machineId: target.machineId, serverId: target.serverId, provider });
    }), [execute, run, target]);
    const setProviderEnabled = React.useCallback((provider: ComputerProviderIdV1, enabled: boolean) => {
        if (!preferences) return change(null);
        return change({ ...preferences, enabledProviders: enabled
            ? preferences.enabledProviders.includes(provider) ? preferences.enabledProviders : [...preferences.enabledProviders, provider]
            : preferences.enabledProviders.filter(value => value !== provider) });
    }, [change, preferences]);
    const setDefaultProvider = React.useCallback((provider: ComputerProviderIdV1) => change(preferences ? {
        enabledProviders: preferences.enabledProviders, defaultProvider: provider,
    } : null), [change, preferences]);
    return { preferences, providers, mutation, setProviderEnabled, setDefaultProvider, installProvider, refresh };
}
