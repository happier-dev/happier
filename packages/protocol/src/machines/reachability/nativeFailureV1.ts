import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineElevationFailureV1Schema, MachineFirewallRecoveryV1Schema, MachineFirewallRestorationV1Schema } from '../adminAccessV1.js';
import { DeploymentDomainCaddyFailureDetailsV1Schema } from '../../deployments/deploymentDomainCaddyFailureV1.js';

const text = () => z.string().check(z.trim(), z.minLength(1));

/** Closed native diagnostics shared by review and configure, never permission to retry. */
export const MachineReachabilityNativeFailureDetailsV1Schema = lazyZodSchema(() => z.union([
  DeploymentDomainCaddyFailureDetailsV1Schema,
  z.strictObject({
    status: z.optional(z.enum(['rolledBack', 'outcome_unknown', 'recoveryRequired', 'refused'])),
    failure: z.optional(z.union([MachineElevationFailureV1Schema, z.strictObject({
      kind: z.literal('daemon_reachability_unavailable'), reason: z.literal('required_fact_unavailable'),
      requiredFact: z.literal('homeRoutedDaemonAck'), errorCode: z.optional(text()),
    })])),
    recovery: z.optional(MachineFirewallRecoveryV1Schema), restoration: z.optional(MachineFirewallRestorationV1Schema),
    setupOutcome: z.optional(z.literal('applied')),
    remedy: text(),
  }),
]));
