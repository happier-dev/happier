import type { PluginInvocationContext } from './invocation.js';
import type { PluginSecretSourceFailureV1, PluginSecretSourceListRequestV1, PluginSecretSourceListResultV1,
    PluginSecretSourceStoreRequestV1, PluginSecretSourceStoreResultV1 } from '@happier-dev/protocol/plugins/contributions/public-types';
export type { PluginSecretSourceFailureV1, PluginSecretSourceOperationFailureV1, PluginSecretSourceFieldV1,
    PluginSecretSourceListRequestV1, PluginSecretSourceListResultV1,
    PluginSecretSourceStoreRequestV1, PluginSecretSourceStoreResultV1 } from '@happier-dev/protocol/plugins/contributions/public-types';

/** Private acquisition output: never an Action result, catalog snapshot or log. */
export type PluginSecretSourceAcquisitionV1 =
    | Readonly<{ ok: true; value: string }>
    | PluginSecretSourceFailureV1;

export type PluginSecretSourceRequestV1 = Readonly<{ account: string; reference: string }>;

export interface PluginSecretSourceRuntimeV1 {
    acquire(input: PluginSecretSourceRequestV1, context: PluginInvocationContext): Promise<PluginSecretSourceAcquisitionV1>;
    list?(input: PluginSecretSourceListRequestV1, context: PluginInvocationContext): Promise<PluginSecretSourceListResultV1>;
    store?(input: PluginSecretSourceStoreRequestV1, context: PluginInvocationContext): Promise<PluginSecretSourceStoreResultV1>;
}

export type PluginSecretSourceDefinitionV1 = Readonly<{
    declaration: Readonly<{ title: string }>;
    runtime: PluginSecretSourceRuntimeV1;
}>;
