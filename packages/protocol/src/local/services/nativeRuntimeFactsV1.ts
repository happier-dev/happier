import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const scalar = lazyZodSchema(() => z.nullable(z.union([z.string(), z.number()])));

/** Same redacted structural configuration consumed by deployment review and service detail. */
export const DeploymentReviewServiceV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string(),
  replicas: scalar,
  resources: z.strictObject({ cpus: scalar, memory: scalar }),
  restartPolicy: z.nullable(z.string()),
  healthcheck: z.enum(['configured', 'absent']),
  ports: z.array(z.strictObject({
    target: scalar,
    published: scalar,
    bindAddress: z.nullable(z.string()),
    protocol: z.nullable(z.string()),
  })),
  mounts: z.array(z.strictObject({
    type: z.nullable(z.string()),
    source: z.nullable(z.string()),
    target: z.nullable(z.string()),
    readOnly: z.boolean(),
  })),
}));
export type DeploymentReviewServiceV1 = z.infer<typeof DeploymentReviewServiceV1Schema>;

/** The existing capture's facts; unavailable retains its last admitted observation. */
export const MachineServiceNativeRuntimeFactsV1Schema = lazyZodSchema(() => z.strictObject({
  configuration: z.nullable(DeploymentReviewServiceV1Schema),
  observedAt: z.nullable(z.number()),
  freshness: z.enum(['current', 'unavailable']),
}));
export type MachineServiceNativeRuntimeFactsV1 = Readonly<z.infer<typeof MachineServiceNativeRuntimeFactsV1Schema>>;
