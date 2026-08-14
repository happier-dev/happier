import { z } from 'zod';

import {
  ScmWorkingSnapshotSchema,
} from './workingSnapshot.js';
import { ScmOperationErrorCodeSchema } from './operationError.js';
import {
  SourceControlCloneProtocolSchema,
} from './cloneProtocol.js';
import {
  ScmHostingProviderRefSchema,
} from './pullRequests.js';
import {
  ScmHostingRepositoryAuthSummarySchema,
  ScmHostingRepositorySummarySchema,
  ScmRepositoryProvisioningFailureResponseSchema,
} from './repositoryProvisioning.js';

export {
  SourceControlCloneProtocolSchema,
  type SourceControlCloneProtocol,
} from './cloneProtocol.js';

const UNSAFE_PATH_SEGMENT_REGEX = /(^|[/\\])\.\.($|[/\\])/;

function hasUnsafePathInput(value: string): boolean {
  return value.includes('\0') || value.startsWith('~') || UNSAFE_PATH_SEGMENT_REGEX.test(value);
}

export const ScmRepositoryCloneAuthorizationTokenSchema = z.literal('clone-repository');
export type ScmRepositoryCloneAuthorizationToken =
  z.infer<typeof ScmRepositoryCloneAuthorizationTokenSchema>;

export const ScmRepositoryCloneRepositorySelectorSchema = z
  .object({
    nameWithOwner: z.string().trim().min(1),
    webUrl: z.string().url().optional(),
    cloneUrl: z.string().min(1).optional(),
    sshUrl: z.string().min(1).optional(),
    defaultBranch: z.string().min(1).nullable().optional(),
    visibility: ScmHostingRepositorySummarySchema.shape.visibility,
  })
  .passthrough();
export type ScmRepositoryCloneRepositorySelector =
  z.infer<typeof ScmRepositoryCloneRepositorySelectorSchema>;

export const ScmRepositoryCloneInputSchema = z
  .object({
    provider: ScmHostingProviderRefSchema,
    repository: ScmRepositoryCloneRepositorySelectorSchema,
    destinationParentPath: z.string().trim().min(1).refine(
      (value) => !hasUnsafePathInput(value),
      'Destination parent path must not use home expansion or traversal segments',
    ),
    destinationDirectoryName: z.string().trim().min(1).refine(
      (value) => value !== '.' && value !== '..' && !/[\/\\]/.test(value) && !hasUnsafePathInput(value),
      'Destination directory name must be a single safe path segment',
    ),
    protocol: SourceControlCloneProtocolSchema,
    confirmed: z.literal(true),
    authorizationToken: ScmRepositoryCloneAuthorizationTokenSchema,
  })
  .strict();
export type ScmRepositoryCloneInput =
  z.infer<typeof ScmRepositoryCloneInputSchema>;

export const ScmRepositoryCloneTargetSchema = z
  .object({
    protocol: z.enum(['ssh', 'https']),
    url: z.string().min(1),
    isDefault: z.boolean().optional(),
  })
  .strict();
export type ScmRepositoryCloneTarget =
  z.infer<typeof ScmRepositoryCloneTargetSchema>;

export const ScmRepositoryCloneTargetDescriptionSchema = z
  .object({
    auth: ScmHostingRepositoryAuthSummarySchema.optional(),
    repository: ScmHostingRepositorySummarySchema,
    targets: z.array(ScmRepositoryCloneTargetSchema).min(1),
  })
  .passthrough();
export type ScmRepositoryCloneTargetDescription =
  z.infer<typeof ScmRepositoryCloneTargetDescriptionSchema>;

export const ScmRepositoryCloneOutputSchema = z.union([
  z
    .object({
      success: z.literal(true),
      destinationPath: z.string().min(1),
      cloneProtocol: z.enum(['ssh', 'https']),
      cloneUrl: z.string().min(1),
      repository: ScmHostingRepositorySummarySchema,
      snapshot: ScmWorkingSnapshotSchema.optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
    })
    .passthrough(),
  ScmRepositoryProvisioningFailureResponseSchema.extend({
    errorCode: ScmOperationErrorCodeSchema.optional(),
  }),
]);
export type ScmRepositoryCloneOutput =
  z.infer<typeof ScmRepositoryCloneOutputSchema>;
