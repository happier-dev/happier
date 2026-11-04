import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import {
  DaemonProviderConnectionMutationRequestV1Schema, DaemonProviderConnectionMutationResponseV1Schema,
  DaemonProviderConnectionsDescribeRequestV1Schema, DaemonProviderConnectionsDescribeResponseV1Schema,
  DaemonProviderModelsRequestV1Schema, DaemonProviderModelsResponseV1Schema,
  DaemonProviderModelProjectionRequestV1Schema, DaemonProviderModelProjectionResponseV1Schema,
  DaemonProviderModelSettingsMutationRequestV1Schema, DaemonProviderModelSettingsMutationResponseV1Schema,
  DaemonProviderModelLoadRequestV1Schema, DaemonProviderModelLoadResponseV1Schema,
  DaemonProviderProbeRequestV1Schema, DaemonProviderProbeResponseV1Schema,
  DaemonProviderBindingStatusRequestV1Schema, DaemonProviderBindingStatusResponseV1Schema, DaemonProviderBindingStatusChangedResponseV1Schema,
  DaemonProviderProfileMigrationPrepareSourceRequestV1Schema, DaemonProviderProfileMigrationPrepareSourceResponseV1Schema,
} from '../rpc/providers.js';
import { ProviderDefaultModelSelectionMutationV1Schema } from './selection/v1.js';
import { ProviderConnectionIdSchema, ProviderMachineIdSchema } from './ids.js';
import type { ProviderActionIdV1 } from './providerActionIdsV1.js';
import { ProviderGatewayChoiceInputV1Schema, ProviderGatewayChoiceResultV1Schema } from './gatewayContributionsV1.js';
import { SessionProviderBindingSecurityChangeConfirmationV1Schema } from './sessions/bindingMetadataV1.js';
export { PROVIDER_ACTION_IDS_V1, isProviderActionIdV1, type ProviderActionIdV1 } from './providerActionIdsV1.js';

type ConnectionAction = z.output<typeof DaemonProviderConnectionMutationRequestV1Schema>['action'];
type ConnectionOption<A extends ConnectionAction> = Extract<
  (typeof DaemonProviderConnectionMutationRequestV1Schema)['_zod']['def']['options'][number], { shape: { action: z.ZodMiniLiteral<A> } }
> & z.ZodMiniType;
function connectionInput<A extends ConnectionAction>(action: A): ConnectionOption<A> {
  return lazyZodSchema<ConnectionOption<A>>(() => {
    const option = DaemonProviderConnectionMutationRequestV1Schema._zod.def.options.find((value): value is ConnectionOption<A> => value.shape.action._zod.def.values[0] === action);
    if (!option) throw new Error(`Missing Provider connection operation: ${action}`);
    return option;
  });
}
type AccountOperand<T> = { [K in keyof (Omit<T, 'machineId'> & { machineId?: string })]: (Omit<T, 'machineId'> & { machineId?: string })[K] };
type AccountCreationOperand<T extends { authoringReview: unknown }> = {
  [K in keyof (Omit<AccountOperand<T>, 'authoringReview'> & { authoringReview?: T['authoringReview'];
    deployment?: z.output<ConnectionOption<'update'>>['deployment'] })]:
    (Omit<AccountOperand<T>, 'authoringReview'> & { authoringReview?: T['authoringReview'];
      deployment?: z.output<ConnectionOption<'update'>>['deployment'] })[K]
};
function accountInput<S extends z.ZodMiniObject>(schema: S): z.ZodMiniType<AccountOperand<z.output<S>>, AccountOperand<z.input<S>>> {
  // Zod's public safeExtend retains refinements at runtime; its subtype-only typing
  // cannot express this deliberate Account-boundary widening. Keep the cast here.
  const extend = z.safeExtend.bind(null, schema) as unknown as (shape: { machineId: z.ZodMiniOptional<typeof ProviderMachineIdSchema> }) =>
    z.ZodMiniType<AccountOperand<z.output<S>>, AccountOperand<z.input<S>>>;
  return extend({ machineId: z.optional(ProviderMachineIdSchema) });
}
type ModelSettingsAction = z.output<typeof DaemonProviderModelSettingsMutationRequestV1Schema>['action'];
type ModelSettingsOption<A extends ModelSettingsAction> = Extract<
  (typeof DaemonProviderModelSettingsMutationRequestV1Schema)['_zod']['def']['options'][number], { shape: { action: z.ZodMiniLiteral<A> } }
> & z.ZodMiniType;
function modelSettingsInput<A extends ModelSettingsAction>(action: A): ModelSettingsOption<A> {
  return lazyZodSchema<ModelSettingsOption<A>>(() => {
    const option = DaemonProviderModelSettingsMutationRequestV1Schema._zod.def.options.find((value): value is ModelSettingsOption<A> => value.shape.action._zod.def.values[0] === action);
    if (!option) throw new Error(`Missing Provider model operation: ${action}`);
    return option;
  });
}
type ModelLoadOption<A extends 'load' | 'cancel'> = Extract<
  (typeof DaemonProviderModelLoadRequestV1Schema)['_zod']['def']['options'][number], { shape: { action: z.ZodMiniLiteral<A> } }
> & z.ZodMiniType;
function modelLoadInput<A extends 'load' | 'cancel'>(action: A): ModelLoadOption<A> {
  return lazyZodSchema<ModelLoadOption<A>>(() => {
    const option = DaemonProviderModelLoadRequestV1Schema._zod.def.options.find((value): value is ModelLoadOption<A> => value.shape.action._zod.def.values[0] === action);
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
  'providers.gateways.choose': ProviderGatewayChoiceInputV1Schema,
  'providers.connections.describe': lazyZodSchema(() => accountInput(DaemonProviderConnectionsDescribeRequestV1Schema)),
  'providers.connections.create_contribution': lazyZodSchema(() => {
    const input = connectionInput('createContribution');
    const extend = z.safeExtend.bind(null, input) as unknown as (shape: { machineId: z.ZodMiniOptional<typeof ProviderMachineIdSchema>;
      authoringReview: z.ZodMiniOptional<typeof input.shape.authoringReview>; deployment: ConnectionOption<'update'>['shape']['deployment'] }) =>
        z.ZodMiniType<AccountCreationOperand<z.output<typeof input>>, AccountCreationOperand<z.input<typeof input>>>;
    return extend({ machineId: z.optional(ProviderMachineIdSchema), authoringReview: z.optional(input.shape.authoringReview),
      deployment: connectionInput('update').shape.deployment });
  }),
  'providers.connections.create_custom': lazyZodSchema(() => accountInput(connectionInput('createCustom'))),
  'providers.connections.enable_detected': connectionInput('enableDetected'),
  'providers.connections.start_local': connectionInput('startLocal'),
  'providers.connections.update': lazyZodSchema(() => accountInput(connectionInput('update'))),
  'providers.connections.endpoint.set': lazyZodSchema(() => accountInput(connectionInput('setEndpointOverride'))),
  'providers.connections.duplicate': lazyZodSchema(() => accountInput(connectionInput('duplicate'))),
  'providers.connections.delete': lazyZodSchema(() => accountInput(connectionInput('delete'))),
  'providers.connections.enabled.set': lazyZodSchema(() => accountInput(connectionInput('setEnabled'))),
  'providers.connections.secrets.bind': lazyZodSchema(() => accountInput(connectionInput('bindSecret'))),
  'providers.models.list': lazyZodSchema(() => accountInput(DaemonProviderModelsRequestV1Schema)),
  // Refresh contacts external Providers and cannot be smuggled into a safe read.
  'providers.models.projection': lazyZodSchema(() => accountInput(z.safeExtend(DaemonProviderModelProjectionRequestV1Schema, { forceRefresh: z.optional(z.never()) }))),
  'providers.models.refresh': lazyZodSchema(() => z.safeExtend(DaemonProviderModelProjectionRequestV1Schema, { forceRefresh: z.literal(true) })),
  'providers.models.manual.add': lazyZodSchema(() => accountInput(modelSettingsInput('manualAdd'))),
  'providers.models.manual.remove': lazyZodSchema(() => accountInput(modelSettingsInput('manualRemove'))),
  'providers.models.visibility.set': lazyZodSchema(() => accountInput(modelSettingsInput('setVisibility'))),
  'providers.models.source_visibility.set': lazyZodSchema(() => z.strictObject({
    action: z.literal('setConnectionVisibility'), connectionId: ProviderConnectionIdSchema, shown: z.nullable(z.boolean()),
  })),
  'providers.models.visibility.reset': lazyZodSchema(() => accountInput(modelSettingsInput('resetVisibility'))),
  'providers.models.visibility.bulk': lazyZodSchema(() => accountInput(modelSettingsInput('bulkVisibility'))),
  'providers.models.experimental.confirm': lazyZodSchema(() => accountInput(modelSettingsInput('confirmExperimental'))),
  'providers.models.load': modelLoadInput('load'),
  'providers.models.cancel_load': modelLoadInput('cancel'),
  'providers.probe': DaemonProviderProbeRequestV1Schema,
  'providers.binding.status': lazyZodSchema(() => z.union([
    DaemonProviderBindingStatusRequestV1Schema,
    z.strictObject({ machineId: ProviderMachineIdSchema, sessionId: SessionProviderBindingSecurityChangeConfirmationV1Schema.shape.sessionId }),
  ])),
  'providers.legacy.prepare': DaemonProviderProfileMigrationPrepareSourceRequestV1Schema,
  'providers.defaults.set': ProviderDefaultModelSelectionMutationV1Schema,
} as const satisfies Record<ProviderActionIdV1, z.ZodMiniType>;

export const PROVIDER_ACTION_OUTPUT_SCHEMAS_V1 = {
  'providers.gateways.choose': ProviderGatewayChoiceResultV1Schema,
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
  'providers.models.source_visibility.set': lazyZodSchema(() => z.strictObject({ status: z.literal('updated') })),
  'providers.models.visibility.reset': DaemonProviderModelSettingsMutationResponseV1Schema,
  'providers.models.visibility.bulk': DaemonProviderModelSettingsMutationResponseV1Schema,
  'providers.models.experimental.confirm': DaemonProviderModelSettingsMutationResponseV1Schema,
  'providers.models.load': DaemonProviderModelLoadResponseV1Schema,
  'providers.models.cancel_load': DaemonProviderModelLoadResponseV1Schema,
  'providers.probe': DaemonProviderProbeResponseV1Schema,
  'providers.binding.status': lazyZodSchema(() => z.union([
    DaemonProviderBindingStatusResponseV1Schema,
    z.safeExtend(DaemonProviderBindingStatusChangedResponseV1Schema, {
      providerBindingSecurityChangeConfirmationV1: SessionProviderBindingSecurityChangeConfirmationV1Schema,
    }),
  ])),
  'providers.legacy.prepare': DaemonProviderProfileMigrationPrepareSourceResponseV1Schema,
  'providers.defaults.set': lazyZodSchema(() => z.strictObject({ status: z.literal('updated') })),
} as const satisfies Record<ProviderActionIdV1, z.ZodMiniType>;

export type ProviderActionInputByIdV1 = { readonly [Id in ProviderActionIdV1]: z.output<(typeof PROVIDER_ACTION_INPUT_SCHEMAS_V1)[Id]> };
export type ProviderActionRequestV1 = { [Id in ProviderActionIdV1]: Readonly<{ actionId: Id; input: ProviderActionInputByIdV1[Id] }> }[ProviderActionIdV1];
/** Omitted input describes default placement; admitted input selects its exact variant. */
function resolveProviderActionOwnershipV1(
  request: ProviderActionRequestV1 | Readonly<{ actionId: ProviderActionIdV1; input?: never }>,
): Readonly<{ owner: 'machine' | 'accountCatalog' | 'accountSettings'; placements: readonly ('machine' | 'account')[] }> {
  switch (request.actionId) {
    case 'providers.defaults.set': return { owner: 'accountSettings', placements: ['account'] };
    case 'providers.connections.describe':
    case 'providers.models.list':
    case 'providers.models.projection': return { owner: request.input?.machineId !== undefined ? 'machine' : 'accountCatalog', placements: ['account', 'machine'] };
    case 'providers.connections.create_contribution': return { owner: request.input?.authoringReview?.candidateId != null ? 'machine' : 'accountCatalog', placements: ['account', 'machine'] };
    case 'providers.connections.endpoint.set':
    case 'providers.connections.enabled.set':
    case 'providers.connections.secrets.bind': return { owner: request.input?.scope === 'machine' ? 'machine' : 'accountCatalog', placements: ['account', 'machine'] };
    case 'providers.connections.enable_detected':
    case 'providers.connections.start_local':
    case 'providers.models.refresh':
    case 'providers.models.load':
    case 'providers.models.cancel_load':
    case 'providers.probe':
    case 'providers.binding.status':
    case 'providers.legacy.prepare': return { owner: 'machine', placements: ['machine'] };
    default: return { owner: 'accountCatalog', placements: ['account'] };
  }
}

export function resolveProviderActionOwnerV1(
  request: ProviderActionRequestV1 | Readonly<{ actionId: ProviderActionIdV1; input?: never }>,
): 'machine' | 'accountCatalog' | 'accountSettings' {
  return resolveProviderActionOwnershipV1(request).owner;
}

/** The same domain decision supplies ingress with variants before encrypted input is opened. */
export function resolveProviderActionExecutionPlacementsV1(actionId: ProviderActionIdV1): readonly ('machine' | 'account')[] {
  return resolveProviderActionOwnershipV1({ actionId }).placements;
}
export function isProviderActionMachineRequiredV1(
  request: ProviderActionRequestV1 | Readonly<{ actionId: ProviderActionIdV1; input?: never }>,
): boolean {
  return resolveProviderActionOwnerV1(request) === 'machine';
}
export function parseProviderActionRequestV1(actionId: ProviderActionIdV1, input: unknown): ProviderActionRequestV1 {
  // Keep the ID and its parsed operand correlated without widening either contract.
  switch (actionId) {
    case 'providers.gateways.choose': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
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
    case 'providers.models.source_visibility.set': return { actionId, input: PROVIDER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input) };
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
