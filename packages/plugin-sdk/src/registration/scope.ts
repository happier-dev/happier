import { createPluginRegistrationScope as createHostRegistrationScope } from '@happier-dev/cli-common/plugins/registration/scope';
import type {
    PluginRegistrationRight,
    PluginRegistrationScopeParams,
    PluginRegistrationScopeTarget,
    PluginRegistrationScope as CapturedRegistrationScope,
} from '@happier-dev/cli-common/plugins/registration/scope';
import type { PluginApi, PluginClientApi, PluginAccountApi } from '../activation.js';
import type { PluginRuntimeRegistration } from './valueByFamily.js';

export type { PluginRegistrationRight, PluginRegistrationScopeTarget };
export type { PluginAgentRuntimeRegistration, PluginRuntimeRegistration } from './valueByFamily.js';

type PluginRegistrationScope<TApi, TRegistration = PluginRuntimeRegistration> = CapturedRegistrationScope<TApi, TRegistration>;

type AuthorRegistrationScopeFactory = {
    (params: PluginRegistrationScopeParams & Readonly<{
        target: Extract<PluginRegistrationScopeTarget, { realm: 'account' }>;
    }>): PluginRegistrationScope<PluginAccountApi, PluginRuntimeRegistration<'account'>>;
    (params: PluginRegistrationScopeParams & Readonly<{
        target: Extract<PluginRegistrationScopeTarget, { realm: 'client' }>;
    }>): PluginRegistrationScope<PluginClientApi>;
    (params: PluginRegistrationScopeParams & Readonly<{
        target: Extract<PluginRegistrationScopeTarget, { realm: 'daemon' }>;
    }>): PluginRegistrationScope<PluginApi>;
};

// The private host captures opaque callbacks; this boundary restores their
// exact author-facing types without giving the SDK registration authority.
export const createPluginRegistrationScope = createHostRegistrationScope as unknown as AuthorRegistrationScopeFactory;
