import type { z } from 'zod';
import type { PROVIDER_ACTION_INPUT_SCHEMAS_V1 } from './providerActionsV1.js';
import type {
  DaemonProviderConnectionMutationRequestV1Schema,
  DaemonProviderModelSettingsMutationRequestV1Schema,
  DaemonProviderModelLoadRequestV1Schema,
} from '../rpc/providers.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Inputs = typeof PROVIDER_ACTION_INPUT_SCHEMAS_V1;

// Account Actions retain concrete operands while exact-machine RPC inputs stay required.
type Account<T extends { machineId: string }> = { [K in keyof (Omit<T, 'machineId'> & { machineId?: string })]: (Omit<T, 'machineId'> & { machineId?: string })[K] };
type ConnectionInput = Assert<Equal<z.input<Inputs['providers.connections.delete']>, Account<Extract<z.input<typeof DaemonProviderConnectionMutationRequestV1Schema>, { action: 'delete' }>>>>;
type ConnectionOutput = Assert<Equal<z.output<Inputs['providers.connections.delete']>, Account<Extract<z.output<typeof DaemonProviderConnectionMutationRequestV1Schema>, { action: 'delete' }>>>>;
type SettingsInput = Assert<Equal<z.input<Inputs['providers.models.manual.add']>, Account<Extract<z.input<typeof DaemonProviderModelSettingsMutationRequestV1Schema>, { action: 'manualAdd' }>>>>;
type SettingsOutput = Assert<Equal<z.output<Inputs['providers.models.manual.add']>, Account<Extract<z.output<typeof DaemonProviderModelSettingsMutationRequestV1Schema>, { action: 'manualAdd' }>>>>;
type LoadInput = Assert<Equal<z.input<Inputs['providers.models.cancel_load']>, Extract<z.input<typeof DaemonProviderModelLoadRequestV1Schema>, { action: 'cancel' }>>>;
type LoadOutput = Assert<Equal<z.output<Inputs['providers.models.cancel_load']>, Extract<z.output<typeof DaemonProviderModelLoadRequestV1Schema>, { action: 'cancel' }>>>;
type ConnectionParse = Assert<Equal<ReturnType<Inputs['providers.connections.delete']['parse']>, z.output<Inputs['providers.connections.delete']>>>;
type SettingsParse = Assert<Equal<ReturnType<Inputs['providers.models.manual.add']['parse']>, z.output<Inputs['providers.models.manual.add']>>>;
type LoadParse = Assert<Equal<ReturnType<Inputs['providers.models.cancel_load']['parse']>, z.output<Inputs['providers.models.cancel_load']>>>;
