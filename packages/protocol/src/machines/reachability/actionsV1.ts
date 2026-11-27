import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AccessProviderRefV1Schema, AccessProviderRouteV1Schema, AccessProviderSelectionV1Schema } from '../../plugins/contributions/accessProviders.js';
import { RelayAccessTaskSnapshotV1Schema } from '../../system/tasks/relayAccessConfigV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { MachineSetupRecipePlanV1Schema } from '../setup/machineSetupSourcesV1.js';
import { MachineFirewallTransitionFactsV1Schema, MachineFirewallTransitionIntentV1Schema } from '../setup/machineFirewallV1.js';
import { MachineReachabilityPostureV1Schema, MachineReachabilityObservationV1Schema } from './machineReachabilityPostureV1.js';
import { ActionOperationIdentifierV1Schema } from '../../actions/operations/identifierV1.js';
import { MachineReachabilityNativeFailureDetailsV1Schema } from './nativeFailureV1.js';
import { MachineFirewallRecoveryV1Schema } from '../adminAccessV1.js';
export { MachineReachabilityNativeFailureDetailsV1Schema } from './nativeFailureV1.js';

const text = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative());
const digest = () => z.string().check(z.regex(/^[a-f0-9]{64}$/u));
const target = () => ({ serverId: z.optional(text()), machineId: text() });
export const MachineHomeRelayTargetV1Schema = lazyZodSchema(() => z.strictObject({
  channel: z.enum(['stable', 'preview', 'dev']), mode: z.enum(['user', 'system']),
}));
export type MachineHomeRelayTargetV1 = z.infer<typeof MachineHomeRelayTargetV1Schema>;
export const MachineReachabilityChangeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('posture'), posture: MachineReachabilityPostureV1Schema }),
  z.strictObject({ kind: z.literal('privateNetwork'), intent: z.enum(['join', 'leave']), selection: AccessProviderSelectionV1Schema }),
  z.strictObject({ kind: z.literal('homeRelay'), relay: MachineHomeRelayTargetV1Schema,
    selection: z.nullable(AccessProviderSelectionV1Schema), hostname: z.optional(text()) }),
]));
export type MachineReachabilityChangeV1 = z.infer<typeof MachineReachabilityChangeV1Schema>;
export const MachineReachabilityInspectInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), change: z.optional(MachineReachabilityChangeV1Schema), homeRelay: z.optional(MachineHomeRelayTargetV1Schema),
}).check(z.refine(input => !input.homeRelay || !input.change,
  { message: 'Select either the Relay status read or a reviewed reachability change.' })));
export type MachineReachabilityInspectInputV1 = z.infer<typeof MachineReachabilityInspectInputV1Schema>;
export const MachineReachabilityConfigureInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), change: MachineReachabilityChangeV1Schema,
  reviewedPlanDigest: digest(), reviewedPlanBasis: MachineReachabilityPlanBasisV1Schema,
}));
export type MachineReachabilityConfigureInputV1 = z.infer<typeof MachineReachabilityConfigureInputV1Schema>;

/** Host-produced review evidence; configure rebuilds it rather than trusting an echoed basis. */
export const MachineReachabilityPlanBasisV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: text(), installationId: text(), currentPostureRevision: z.nullable(revision()),
  currentSelections: z.array(AccessProviderSelectionV1Schema),
  change: MachineReachabilityChangeV1Schema,
  occurrences: z.array(z.strictObject({ provider: asProtocolZod(PluginContributionIdentityV1Schema), occurrenceId: text() })),
  recipePlans: z.array(MachineSetupRecipePlanV1Schema),
  homeRelay: z.optional(z.strictObject({ route: AccessProviderRouteV1Schema,
    currentSelection: z.nullable(AccessProviderSelectionV1Schema), currentRoute: z.optional(AccessProviderRouteV1Schema) })),
  nativeFirewall: z.optional(MachineFirewallTransitionFactsV1Schema),
  firewallTransition: z.optional(z.strictObject({
    intent: MachineFirewallTransitionIntentV1Schema, setupRevision: revision(), dockerEngineIds: z.array(text()),
  })),
  nativeProfiles: z.optional(z.array(z.strictObject({
    provider: AccessProviderRefV1Schema,
    profileId: z.nullable(text()), networkIdentity: z.nullable(text()),
  }))),
  credentialFileReview: z.optional(z.strictObject({ purpose: z.literal('network.join'), path: text(), owner: text(),
    group: text(), ownerUid: revision(), groupGid: revision(), mode: z.literal(0o600) })),
}));
export type MachineReachabilityPlanBasisV1 = z.infer<typeof MachineReachabilityPlanBasisV1Schema>;
export const MachineReachabilityPlanV1Schema = lazyZodSchema(() => z.strictObject({
  reviewedPlanDigest: digest(), basis: MachineReachabilityPlanBasisV1Schema,
}));
export type MachineReachabilityPlanV1 = z.infer<typeof MachineReachabilityPlanV1Schema>;

export function buildMachineReachabilityConfigureInput(
  serverId: string | undefined, plan: MachineReachabilityPlanV1,
): MachineReachabilityConfigureInputV1 {
  return {
    ...(serverId === undefined ? {} : { serverId }),
    machineId: plan.basis.machineId, change: plan.basis.change,
    reviewedPlanDigest: plan.reviewedPlanDigest, reviewedPlanBasis: plan.basis,
  };
}
export const MachineReachabilityInspectResultV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: text(), metadataVersion: revision(), posture: z.nullable(MachineReachabilityPostureV1Schema),
  selections: z.array(AccessProviderSelectionV1Schema), observation: MachineReachabilityObservationV1Schema,
  plan: z.optional(MachineReachabilityPlanV1Schema),
  initialPostureReview: z.optional(z.strictObject({
    kind: z.literal('required'),
    configureInput: z.optional(MachineReachabilityConfigureInputV1Schema),
  })),
  relayAccess: z.optional(RelayAccessTaskSnapshotV1Schema),
}));
export type MachineReachabilityInspectResultV1 = z.infer<typeof MachineReachabilityInspectResultV1Schema>;
export const MachineReachabilityConfigureResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['applied', 'unchanged', 'outcome_unknown', 'saved_not_enforced']), machineId: text(), metadataVersion: revision(),
  posture: z.nullable(MachineReachabilityPostureV1Schema), selections: z.array(AccessProviderSelectionV1Schema),
  observation: MachineReachabilityObservationV1Schema, errorCode: z.optional(text()),
  credentialCleanup: z.optional(z.literal('recoveryRequired')),
  recovery: z.optional(MachineFirewallRecoveryV1Schema),
  relayAccess: z.optional(RelayAccessTaskSnapshotV1Schema),
  nextStep: z.optional(z.literal('apply_firewall_recipe')),
}).check(
  z.refine(result => (result.errorCode === undefined && result.credentialCleanup === undefined) || result.status === 'outcome_unknown',
    { message: 'Role and credential cleanup failures are supplied only for an unknown reachability outcome.' }),
  z.refine(result => (result.status === 'saved_not_enforced') === (result.nextStep !== undefined),
    { message: 'A settings-only SSH save supplies the firewall apply step.' }),
));
export type MachineReachabilityConfigureResultV1 = z.infer<typeof MachineReachabilityConfigureResultV1Schema>;
/** Configure alone may report an earlier setup effect. */
export const MachineReachabilityConfigureFailureDetailsV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ setupOutcome: z.literal('applied') }), MachineReachabilityNativeFailureDetailsV1Schema,
]));
/** Only the incumbent operation link, never native keys or credentials. */
export const MachineReachabilityBusyFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  actionOperationId: ActionOperationIdentifierV1Schema,
}));
export const MACHINE_REACHABILITY_ACTION_INPUT_SCHEMAS_V1 = {
  'machines.reachability.inspect': MachineReachabilityInspectInputV1Schema,
  'machines.reachability.configure': MachineReachabilityConfigureInputV1Schema,
} as const;
export const MACHINE_REACHABILITY_ACTION_OUTPUT_SCHEMAS_V1 = {
  'machines.reachability.inspect': MachineReachabilityInspectResultV1Schema,
  'machines.reachability.configure': MachineReachabilityConfigureResultV1Schema,
} as const;
export type MachineReachabilityActionInputV1 = MachineReachabilityInspectInputV1 | MachineReachabilityConfigureInputV1;
