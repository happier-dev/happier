import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import {
  DaemonProviderConnectionMutationRequestV1Schema, DaemonProviderConnectionMutationResponseV1Schema,
  DaemonProviderConnectionsDescribeRequestV1Schema, DaemonProviderConnectionsDescribeResponseV1Schema,
  DaemonProviderModelsRequestV1Schema, DaemonProviderModelsResponseV1Schema,
  DaemonProviderModelProjectionRequestV1Schema, DaemonProviderModelProjectionResponseV1Schema,
  DaemonProviderModelSettingsMutationRequestV1Schema, DaemonProviderModelSettingsMutationResponseV1Schema,
  DaemonProviderModelLoadRequestV1Schema, DaemonProviderModelLoadResponseV1Schema,
  DaemonProviderProbeRequestV1Schema, DaemonProviderProbeResponseV1Schema,
  DaemonProviderBindingStatusRequestV1Schema, DaemonProviderBindingStatusResponseV1Schema,
  DaemonProviderProfileMigrationPrepareSourceRequestV1Schema, DaemonProviderProfileMigrationPrepareSourceResponseV1Schema,
} from '../rpc/providers.js';
import { ProviderDefaultModelSelectionMutationV1Schema } from './selection/v1.js';
import { type ProviderActionIdV1 } from './providerActionIdsV1.js';
export { PROVIDER_ACTION_IDS_V1, isProviderActionIdV1, type ProviderActionIdV1 } from './providerActionIdsV1.js';

type ConnectionAction = z.output<typeof DaemonProviderConnectionMutationRequestV1Schema>['action'];
type ConnectionOption<A extends ConnectionAction> = Extract<
  (typeof DaemonProviderConnectionMutationRequestV1Schema)['options'][number], { shape: { action: z.ZodLiteral<A> } }
> & z.ZodType;
function connectionInput<A extends ConnectionAction>(action: A): ConnectionOption<A> {
  return lazyZodSchema<ConnectionOption<A>>(() => {
    const option = DaemonProviderConnectionMutationRequestV1Schema.options.find((value): value is ConnectionOption<A> => value.shape.action.value === action);
    if (!option) throw new Error(`Missing Provider connection operation: ${action}`);
    return option;
  });
}
type ModelSettingsAction = z.output<typeof DaemonProviderModelSettingsMutationRequestV1Schema>['action'];
type ModelSettingsOption<A extends ModelSettingsAction> = Extract<
  (typeof DaemonProviderModelSettingsMutationRequestV1Schema)['options'][number], { shape: { action: z.ZodLiteral<A> } }
> & z.ZodType;
function modelSettingsInput<A extends ModelSettingsAction>(action: A): ModelSettingsOption<A> {
  return lazyZodSchema<ModelSettingsOption<A>>(() => {
    const option = DaemonProviderModelSettingsMutationRequestV1Schema.options.find((value): value is ModelSettingsOption<A> => value.shape.action.value === action);
    if (!option) throw new Error(`Missing Provider model operation: ${action}`);
    return option;
  });
}
type ModelLoadOption<A extends 'load' | 'cancel'> = Extract<
  (typeof DaemonProviderModelLoadRequestV1Schema)['options'][number], { shape: { action: z.ZodLiteral<A> } }
> & z.ZodType;
function modelLoadInput<A extends 'load' | 'cancel'>(action: A): ModelLoadOption<A> {
  return lazyZodSchema<ModelLoadOption<A>>(() => {
    const option = DaemonProviderModelLoadRequestV1Schema.options.find((value): value is ModelLoadOption<A> => value.shape.action.value === action);
    if (!option) throw new Error(`Missing Provider process operation: ${action}`);
    return option;
  });
}

export const PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1 = {
  createContribution: 'providers.connections.create_contribution', createCustom: 'providers.connections.create_custom',
  enableDetected: 'providers.connections.enable_detected', startLocal: 'providers.connections.start_local',
  update: 'providers.connections.update', setEndpointOverride: 'providers.connections.endpoint.set',
  duplicate: 'providers.connections.duplicate', delete: 'providers.connections.delete',
  setEnabled: 'providers.connections.enabled.set', bindSecret: 'providers.connections.secrets.bind',
} as const satisfies Record<ConnectionAction, ProviderActionIdV1>;
export const PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1 = {
  manualAdd: 'providers.models.manual.add', manualRemove: 'providers.models.manual.remove',
  setVisibility: 'providers.models.visibility.set', resetVisibility: 'providers.models.visibility.reset',
  bulkVisibility: 'providers.models.visibility.bulk', confirmExperimental: 'providers.models.experimental.confirm',
} as const satisfies Record<ModelSettingsAction, ProviderActionIdV1>;

export const PROVIDER_ACTION_INPUT_SCHEMAS_V1 = {
  'providers.connections.describe': DaemonProviderConnectionsDescribeRequestV1Schema,
  'providers.connections.create_contribution': connectionInput('createContribution'),
  'providers.connections.create_custom': connectionInput('createCustom'),
  'providers.connections.enable_detected': connectionInput('enableDetected'),
  'providers.connections.start_local': connectionInput('startLocal'),
  'providers.connections.update': connectionInput('update'),
  'providers.connections.endpoint.set': connectionInput('setEndpointOverride'),
  'providers.connections.duplicate': connectionInput('duplicate'),
  'providers.connections.delete': connectionInput('delete'),
  'providers.connections.enabled.set': connectionInput('setEnabled'),
  'providers.connections.secrets.bind': connectionInput('bindSecret'),
  'providers.models.list': DaemonProviderModelsRequestV1Schema,
  // Refresh contacts external Providers and cannot be smuggled into a safe read.
  'providers.models.projection': lazyZodSchema(() => DaemonProviderModelProjectionRequestV1Schema.safeExtend({ forceRefresh: z.never().optional() })),
  'providers.models.refresh': lazyZodSchema(() => DaemonProviderModelProjectionRequestV1Schema.safeExtend({ forceRefresh: z.literal(true) })),
  'providers.models.manual.add': modelSettingsInput('manualAdd'),
  'providers.models.manual.remove': modelSettingsInput('manualRemove'),
  'providers.models.visibility.set': modelSettingsInput('setVisibility'),
  'providers.models.visibility.reset': modelSettingsInput('resetVisibility'),
  'providers.models.visibility.bulk': modelSettingsInput('bulkVisibility'),
  'providers.models.experimental.confirm': modelSettingsInput('confirmExperimental'),
  'providers.models.load': modelLoadInput('load'),
  'providers.models.cancel_load': modelLoadInput('cancel'),
  'providers.probe': DaemonProviderProbeRequestV1Schema,
  'providers.binding.status': DaemonProviderBindingStatusRequestV1Schema,
  'providers.legacy.prepare': DaemonProviderProfileMigrationPrepareSourceRequestV1Schema,
  'providers.defaults.set': ProviderDefaultModelSelectionMutationV1Schema,
} as const satisfies Record<ProviderActionIdV1, z.ZodType>;

export const PROVIDER_ACTION_OUTPUT_SCHEMAS_V1 = {
  'providers.connections.describe': DaemonProviderConnectionsDescribeResponseV1Schema,
  'providers.connections.create_contribution': DaemonProviderConnectionMutationResponseV1Schema,
  'providers.connections.create_custom': DaemonProviderConnectionMutationResponseV1Schema,
  'providers.connections.enable_detected': DaemonProviderConnectionMutationResponseV1Schema,
  'providers.connections.start_local': DaemonProviderConnectionMutationResponseV1Schema,
  'providers.connections.update': DaemonProviderConnectionMutationResponseV1Schema,
  'providers.connections.endpoint.set': DaemonProviderConnectionMutationResponseV1Schema,
  'providers.connections.duplicate': DaemonProviderConnectionMutationResponseV1Schema,
  'providers.connections.delete': DaemonProviderConnectionMutationResponseV1Schema,
  'providers.connections.enabled.set': DaemonProviderConnectionMutationResponseV1Schema,
  'providers.connections.secrets.bind': DaemonProviderConnectionMutationResponseV1Schema,
  'providers.models.list': DaemonProviderModelsResponseV1Schema,
  'providers.models.projection': DaemonProviderModelProjectionResponseV1Schema,
  'providers.models.refresh': DaemonProviderModelProjectionResponseV1Schema,
  'providers.models.manual.add': DaemonProviderModelSettingsMutationResponseV1Schema,
  'providers.models.manual.remove': DaemonProviderModelSettingsMutationResponseV1Schema,
  'providers.models.visibility.set': DaemonProviderModelSettingsMutationResponseV1Schema,
  'providers.models.visibility.reset': DaemonProviderModelSettingsMutationResponseV1Schema,
  'providers.models.visibility.bulk': DaemonProviderModelSettingsMutationResponseV1Schema,
  'providers.models.experimental.confirm': DaemonProviderModelSettingsMutationResponseV1Schema,
  'providers.models.load': DaemonProviderModelLoadResponseV1Schema,
  'providers.models.cancel_load': DaemonProviderModelLoadResponseV1Schema,
  'providers.probe': DaemonProviderProbeResponseV1Schema,
  'providers.binding.status': DaemonProviderBindingStatusResponseV1Schema,
  'providers.legacy.prepare': DaemonProviderProfileMigrationPrepareSourceResponseV1Schema,
  'providers.defaults.set': lazyZodSchema(() => z.object({ status: z.literal('updated') }).strict()),
} as const satisfies Record<ProviderActionIdV1, z.ZodType>;

export type ProviderActionInputByIdV1 = { readonly [Id in ProviderActionIdV1]: z.output<(typeof PROVIDER_ACTION_INPUT_SCHEMAS_V1)[Id]> };
export type ProviderActionRequestV1 = { [Id in ProviderActionIdV1]: Readonly<{ actionId: Id; input: ProviderActionInputByIdV1[Id] }> }[ProviderActionIdV1];
export function parseProviderActionRequestV1(actionId: ProviderActionIdV1, input: unknown): ProviderActionRequestV1 {
  // Keep the ID and its parsed operand correlated without widening either contract.
  switch (actionId) {
    case 'providers.connections.describe': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.connections.create_contribution': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.connections.create_custom': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.connections.enable_detected': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.connections.start_local': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.connections.update': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.connections.endpoint.set': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.connections.duplicate': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.connections.delete': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.connections.enabled.set': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.connections.secrets.bind': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.models.list': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.models.projection': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.models.refresh': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.models.manual.add': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.models.manual.remove': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.models.visibility.set': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.models.visibility.reset': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.models.visibility.bulk': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.models.experimental.confirm': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.models.load': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.models.cancel_load': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.probe': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.binding.status': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.legacy.prepare': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
    case 'providers.defaults.set': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
  }
}
