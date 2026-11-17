import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AgentPermissionIntentV1Schema } from '../runtime/permissionIntentV1.js';
import { ProviderAgentTargetKeySchema } from '../providers/ids.js';
import { SessionModelSelectionV1Schema } from '../providers/selection/v1.js';
import { SessionModelSelectionV2Schema } from '../providers/selection/v2.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../connect/connectedAccountPurposes.js';
import { qualifiedPurposeKey, QualifiedConnectedAccountPurposeBindingTargetV1Schema, QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema } from '../connect/connectedAccountPurposeBindings.js';
import { ConnectedAccountServiceIdentityV1Schema } from '../connect/qualifiedConnectedAccountPersistence.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionMachinePlacementV1Schema, SessionPresetPlacementV1Schema } from '../sessions/creation/sessionPlacementSelectionV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { ApprovalProfileIdV1Schema } from '../actions/approvalProfileIdV1.js';

export const ManagedSessionPlacementV1Schema = lazyZodSchema(() => z.union([
  SessionMachinePlacementV1Schema,
  SessionPresetPlacementV1Schema,
]));
export type ManagedSessionPlacementV1 = z.infer<typeof ManagedSessionPlacementV1Schema>;

export const ManagedConnectedServiceDefaultV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: QualifiedConnectedAccountPurposeV1Schema,
  service: asProtocolZod(ConnectedAccountServiceIdentityV1Schema),
  target: z.nullable(QualifiedConnectedAccountPurposeBindingTargetV1Schema),
  teamResource: z.nullable(z.pick(QualifiedConnectedAccountPurposeTeamResourceSelectionV1Schema, { teamId: true, selection: true })),
}).check(z.superRefine((binding, context) => {
  if (binding.target && binding.teamResource) {
    context.addIssue({ code: 'custom', path: ['teamResource'], message: 'A purpose has one selection' });
  }
  const targetService = binding.target?.kind === 'account' ? binding.target.account.service : binding.target?.service;
  if (targetService && !sameStrictJsonValue(binding.service, targetService)) {
    context.addIssue({ code: 'custom', path: ['target'], message: 'Selection service must match its declared service' });
  }
})));
export type ManagedConnectedServiceDefaultV1 = z.infer<typeof ManagedConnectedServiceDefaultV1Schema>;

export const ManagedSessionDefaultsV1Schema = lazyZodSchema(() => z.strictObject({
  placement: z.optional(ManagedSessionPlacementV1Schema),
  approvalProfileId: z.optional(z.nullable(ApprovalProfileIdV1Schema)),
  permissionModeByAgentTargetKey: z.optional(z.record(ProviderAgentTargetKeySchema, asProtocolZod(AgentPermissionIntentV1Schema))),
  modelByAgentTargetKey: z.optional(z.record(ProviderAgentTargetKeySchema, z.union([SessionModelSelectionV1Schema, SessionModelSelectionV2Schema]))),
  connectedServicesByAgentTargetKey: z.optional(z.record(ProviderAgentTargetKeySchema, z.readonly(z.array(ManagedConnectedServiceDefaultV1Schema)))),
}).check(z.superRefine((defaults, context) => {
  for (const [key, model] of Object.entries(defaults.modelByAgentTargetKey ?? {})) {
    if (key !== model.ref.agentTargetKey) context.addIssue({ code: 'custom', path: ['modelByAgentTargetKey', key], message: 'Model Agent target must match its key' });
  }
  for (const [key, bindings] of Object.entries(defaults.connectedServicesByAgentTargetKey ?? {})) {
    const seen = new Set<string>();
    for (const [index, binding] of bindings.entries()) {
      const purpose = qualifiedPurposeKey(binding.purpose);
      if (seen.has(purpose)) context.addIssue({ code: 'custom', path: ['connectedServicesByAgentTargetKey', key, index, 'purpose'], message: 'A qualified purpose has one default' });
      seen.add(purpose);
    }
  }
})));
export type ManagedSessionDefaultsV1 = z.infer<typeof ManagedSessionDefaultsV1Schema>;
