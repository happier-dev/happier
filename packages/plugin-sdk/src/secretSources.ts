import type { PluginInvocationContext } from './invocation.js';

/** Private acquisition output: never an Action result, catalog snapshot or log. */
export type PluginSecretSourceAcquisitionV1 =
    | Readonly<{ ok: true; value: string }>
    | Readonly<{
        ok: false;
        code: 'source_unavailable' | 'native_unavailable' | 'authentication_required'
            | 'access_denied' | 'not_found' | 'cancelled' | 'acquisition_failed';
        repair?: 'install' | 'unlock' | 'configure' | 'retry';
    }>;

export type PluginSecretSourceRequestV1 = Readonly<{ account: string; reference: string }>;

export interface PluginSecretSourceRuntimeV1 {
    acquire(input: PluginSecretSourceRequestV1, context: PluginInvocationContext): Promise<PluginSecretSourceAcquisitionV1>;
}

export type PluginSecretSourceDefinitionV1 = Readonly<{
    declaration: Readonly<{ title: string }>;
    runtime: PluginSecretSourceRuntimeV1;
}>;
