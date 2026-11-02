import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ExternalActionRequestIdV1Schema, ExternalActionMachineRpcSourceExecutionV1Schema } from '../actions/externalActionApi.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';

export const DeploymentArchiveOriginV1Schema = lazyZodSchema(() => z.strictObject({
    environmentId: DeploymentIdentifierV1Schema, deploymentId: DeploymentIdentifierV1Schema,
    holderMachineId: DeploymentIdentifierV1Schema, holderInstallationId: DeploymentIdentifierV1Schema,
}));
export type DeploymentArchiveOriginV1 = z.infer<typeof DeploymentArchiveOriginV1Schema>;

/** A projection of one controller signature, with no recursively delegated proof or new custody. */
export const DeploymentChildExecutionProofV1Schema = lazyZodSchema(() => z.strictObject({
    method: z.string().check(z.minLength(1)), requestId: ExternalActionRequestIdV1Schema,
    paramsPresent: z.boolean(), paramsDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    externalActionExecution: ExternalActionMachineRpcSourceExecutionV1Schema,
    /** Receiver annotation only. Its outer signature and Home lineage admission are mandatory. */
    archiveOrigin: z.optional(DeploymentArchiveOriginV1Schema),
    /** Receiver-observed native source identity; no private filesystem path crosses Home. */
    nativeIncumbentSource: z.optional(z.strictObject({
        environmentId: DeploymentIdentifierV1Schema, sourceDeploymentId: DeploymentIdentifierV1Schema,
        restorationForDeploymentId: z.optional(DeploymentIdentifierV1Schema),
        rootFingerprint: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
    })),
}));
export type DeploymentChildExecutionProofV1 = z.infer<typeof DeploymentChildExecutionProofV1Schema>;
