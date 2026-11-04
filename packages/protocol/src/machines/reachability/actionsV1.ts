import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AccessProviderSelectionV1Schema } from '../../plugins/contributions/accessProviders.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { MachineSetupRecipePlanV1Schema } from '../managed/actionsV1.js';
import { MachineFirewallTransitionFactsV1Schema, MachineFirewallTransitionIntentV1Schema } from '../setup/machineFirewallV1.js';
import { MachineReachabilityPostureV1Schema, MachineReachabilityObservationV1Schema } from './machineReachabilityPostureV1.js';
import { ActionOperationIdentifierV1Schema } from '../../actions/operations/identifierV1.js';

const text = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative());
const digest = () => z.string().check(z.regex(/^[a-f0-9]{64}$/u));
const target = () => ({ serverId: z.optional(text()), machineId: text() });
export const MachineReachabilityChangeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('posture'), posture: MachineReachabilityPostureV1Schema }),
  z.strictObject({ kind: z.literal('privateNetwork'), intent: z.enum(['join', 'leave']), selection: AccessProviderSelectionV1Schema }),
]));
export type MachineReachabilityChangeV1 = z.infer<typeof MachineReachabilityChangeV1Schema>;
export const MachineReachabilityInspectInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), change: z.optional(MachineReachabilityChangeV1Schema),
}));
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
  nativeFirewall: z.optional(MachineFirewallTransitionFactsV1Schema),
  firewallTransition: z.optional(z.strictObject({
    intent: MachineFirewallTransitionIntentV1Schema, setupRevision: revision(), dockerEngineIds: z.array(text()),
  })),
  nativeProfiles: z.optional(z.array(z.strictObject({
    provider: z.strictObject({ kind: z.literal('builtin'), id: text() }),
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
export const MachineReachabilityInspectResultV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: text(), metadataVersion: revision(), posture: z.nullable(MachineReachabilityPostureV1Schema),
  selections: z.array(AccessProviderSelectionV1Schema), observation: MachineReachabilityObservationV1Schema,
  plan: z.optional(MachineReachabilityPlanV1Schema),
}));
export type MachineReachabilityInspectResultV1 = z.infer<typeof MachineReachabilityInspectResultV1Schema>;
export const MachineReachabilityConfigureResultV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['applied', 'unchanged', 'outcome_unknown']), machineId: text(), metadataVersion: revision(),
  posture: z.nullable(MachineReachabilityPostureV1Schema), selections: z.array(AccessProviderSelectionV1Schema),
  observation: MachineReachabilityObservationV1Schema, errorCode: z.optional(text()),
}).check(z.refine(result => result.errorCode === undefined || result.status === 'outcome_unknown',
  { message: 'A role result code is supplied only for an unknown reachability outcome.' })));
export type MachineReachabilityConfigureResultV1 = z.infer<typeof MachineReachabilityConfigureResultV1Schema>;
/** Historical setup evidence, not native membership or permission to retry. */
export const MachineReachabilityConfigureFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  setupOutcome: z.literal('applied'),
}));
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
