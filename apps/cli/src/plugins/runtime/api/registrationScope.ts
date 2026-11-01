import { createPluginRegistrationScope as createPrivateRegistrationScope } from '@happier-dev/cli-common/plugins/registration/scope';
import type { PluginRegistrationRight, PluginRegistrationScopeParams, PluginRegistrationScopeTarget } from '@happier-dev/cli-common/plugins/registration/scope';
import type { PluginApi, PluginAccountApi, PluginClientApi } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { PluginTestkitRegistrationByFamily } from '@happier-dev/plugin-sdk/testing';

export type { PluginRegistrationRight };
export type PluginAgentRuntimeRegistration = PluginTestkitRegistrationByFamily['agents'];

// Author callback signatures are erased at the private capture boundary. The
// host restores those types only after the one canonical scope has admitted
// them. An Action remains uncallable until its realm dispatcher supplies the
// corresponding public context.
type CapturedActionHandler = (input: never, context: never) => ReturnType<ActionHandler>;
export type PluginRuntimeRegistration<TRealm extends 'daemon' | 'account' = 'daemon'> = {
    [TFamily in keyof PluginTestkitRegistrationByFamily]: Readonly<{
        family: TFamily;
        localId: string;
        value: TFamily extends 'actions' ? CapturedActionHandler
            : TFamily extends 'connectedAccountDescriptors'
                ? TRealm extends 'account' ? Parameters<PluginAccountApi['connectedAccounts']['register']>[1]
                    : PluginTestkitRegistrationByFamily[TFamily]
                : PluginTestkitRegistrationByFamily[TFamily];
    }>;
}[keyof PluginTestkitRegistrationByFamily];

type RegistrationScope<TApi, TRealm extends 'daemon' | 'account' = 'daemon'> = Readonly<{
    api: TApi;
    commit(): readonly PluginRuntimeRegistration<TRealm>[];
    registrations(): readonly PluginRuntimeRegistration<TRealm>[];
    dispose(): Promise<void>;
}>;
type RegistrationScopeFactory = {
    (params: PluginRegistrationScopeParams & Readonly<{ target: Extract<PluginRegistrationScopeTarget, { realm: 'account' }> }>): RegistrationScope<PluginAccountApi, 'account'>;
    (params: PluginRegistrationScopeParams & Readonly<{ target: Extract<PluginRegistrationScopeTarget, { realm: 'client' }> }>): RegistrationScope<PluginClientApi>;
    (params: PluginRegistrationScopeParams & Readonly<{ target: Extract<PluginRegistrationScopeTarget, { realm: 'daemon' }> }>): RegistrationScope<PluginApi>;
};

export const createPluginRegistrationScope = createPrivateRegistrationScope as unknown as RegistrationScopeFactory;
