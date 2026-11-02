import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { MachineServiceIdentityV1Schema, machineServiceIdentityTupleV1 } from '../local/services/serviceIdentityV1.js';
import { HealthCheckSubjectV1Schema } from '../deployments/healthCheckSubjectV1.js';

const id = lazyZodSchema(() => z.string().check(z.minLength(1)));

/** Condition identity only; operation, configuration, time and evidence are not keys. */
export const HealthAlertIdentityV1Schema = lazyZodSchema(() => z.union([
  MachineServiceIdentityV1Schema,
  z.strictObject({ kind: z.literal('platformTarget'), environmentId: id, targetLinkId: id }),
  z.strictObject({ kind: z.literal('environment'), environmentId: id, targetLinkId: id,
    condition: z.enum(['deployment_failed', 'health']) }),
  z.strictObject({ kind: z.literal('backup'), environmentId: id, check: z.enum(['run', 'verify', 'prune', 'restore']) }),
  z.strictObject({ kind: z.literal('healthCheck'), subject: HealthCheckSubjectV1Schema, checkId: id }),
  z.strictObject({ kind: z.literal('domain'), environmentId: id, targetLinkId: id, domainId: id,
    condition: z.enum(['domain_probe_failed', 'certificate_renewal_failed']) }),
]));
export type HealthAlertIdentityV1 = z.infer<typeof HealthAlertIdentityV1Schema>;

/** C1's sole fixed tuple encoder; service tuples remain with the service owner. */
export function healthAlertIdentityTupleV1(identity: HealthAlertIdentityV1): readonly string[] {
  switch (identity.kind) {
    case 'platformTarget': return [identity.kind, identity.environmentId, identity.targetLinkId];
    case 'environment': return [identity.kind, identity.environmentId, identity.targetLinkId, identity.condition];
    case 'backup': return [identity.kind, identity.environmentId, identity.check];
    case 'domain': return [identity.kind, identity.environmentId, identity.targetLinkId, identity.domainId, identity.condition];
    case 'healthCheck': return identity.subject.kind === 'environment'
      ? [identity.kind, identity.subject.kind, identity.subject.environmentId, identity.checkId]
      : [identity.kind, identity.subject.kind, identity.subject.machineId, identity.subject.serviceId, identity.checkId];
    default: return machineServiceIdentityTupleV1(identity);
  }
}
