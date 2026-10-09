import { lazyZodSchema } from '../lazyZodSchema.js';
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
  ScmHostingProviderKindSchema,
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

export const ScmRepositoryCloneAuthorizationTokenSchema = lazyZodSchema(() => z.literal('clone-repository'));
export type ScmRepositoryCloneAuthorizationToken =
  z.infer<typeof ScmRepositoryCloneAuthorizationTokenSchema>;

export const ScmRepositoryCloneRepositorySelectorSchema = lazyZodSchema(() => z
  .object({
    nameWithOwner: z.string().trim().min(1),
    webUrl: z.string().url().optional(),
    cloneUrl: z.string().min(1).optional(),
    sshUrl: z.string().min(1).optional(),
    defaultBranch: z.string().min(1).nullable().optional(),
    // The forge resolves visibility; a saved locator need not have discovered it.
    visibility: ScmHostingRepositorySummarySchema.shape.visibility.optional(),
  })
  .passthrough());
export type ScmRepositoryCloneRepositorySelector =
  z.infer<typeof ScmRepositoryCloneRepositorySelectorSchema>;

/** Durable repository selection excludes credentials and executable clone inputs. */
function isCredentialFreeRepositoryLocator(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) return false;
  // Git's SCP spelling carries a username, never a password, query or fragment.
  if (!normalized.includes('://')) return /^[^\s:@/?#]+@[^\s:@/?#]+:[^\s?#]+$/.test(normalized);
  try {
    const url = new URL(normalized);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash) return false;
    return !url.username || url.protocol === 'ssh:';
  } catch { return false; }
}

export const ScmCredentialFreeRepositorySelectorV1Schema = lazyZodSchema(() => z.object({
  provider: z.object({
    id: z.string().min(1), kind: ScmHostingProviderKindSchema, displayName: z.string().min(1),
    baseUrl: z.string().url().refine(isCredentialFreeRepositoryLocator),
  }).strict(),
  repository: ScmRepositoryCloneRepositorySelectorSchema.pick({
    nameWithOwner: true, webUrl: true, cloneUrl: true, sshUrl: true, defaultBranch: true, visibility: true,
  }).extend({
    webUrl: z.string().url().refine(isCredentialFreeRepositoryLocator).optional(),
    cloneUrl: z.string().trim().min(1).refine(isCredentialFreeRepositoryLocator).optional(),
    sshUrl: z.string().trim().min(1).refine(isCredentialFreeRepositoryLocator).optional(),
  }).strict(),
  protocol: SourceControlCloneProtocolSchema,
}).strict());

/** Machine placement uses the incumbent Action target selector, outside this RPC payload. */
export const ScmHostingRepositoryResolveAddressRequestV1Schema = lazyZodSchema(() => z.object({
  address: z.string().trim().min(1),
}).strict());
export type ScmHostingRepositoryResolveAddressRequestV1 = z.infer<typeof ScmHostingRepositoryResolveAddressRequestV1Schema>;

export const ScmHostingRepositoryResolveAddressResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ success: z.literal(true), kind: z.literal('resolved'), selector: ScmCredentialFreeRepositorySelectorV1Schema }).strict(),
  z.object({ success: z.literal(true), kind: z.literal('unknown') }).strict(),
  z.object({ success: z.literal(true), kind: z.literal('unsupported') }).strict(),
  z.object({ success: z.literal(true), kind: z.literal('invalid') }).strict(),
]));
export type ScmHostingRepositoryResolveAddressResponseV1 = z.infer<typeof ScmHostingRepositoryResolveAddressResponseV1Schema>;

/** Source-contained folder selection shares clone's traversal boundary. */
export const ScmRepositoryContainedSubdirV1Schema = lazyZodSchema(() => z.string().trim().min(1).refine(
  value => !hasUnsafePathInput(value) && !/^(?:[/\\]|[A-Za-z]:)/.test(value),
  'Repository subdirectory must be relative and contained',
));

export const ScmRepositoryCloneInputSchema = lazyZodSchema(() => z
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
  .strict());
export type ScmRepositoryCloneInput =
  z.infer<typeof ScmRepositoryCloneInputSchema>;

export const ScmRepositoryCloneTargetSchema = lazyZodSchema(() => z
  .object({
    protocol: z.enum(['ssh', 'https']),
    url: z.string().min(1),
    isDefault: z.boolean().optional(),
  })
  .strict());
export type ScmRepositoryCloneTarget =
  z.infer<typeof ScmRepositoryCloneTargetSchema>;

export const ScmRepositoryCloneTargetDescriptionSchema = lazyZodSchema(() => z
  .object({
    auth: ScmHostingRepositoryAuthSummarySchema.optional(),
    repository: ScmHostingRepositorySummarySchema,
    targets: z.array(ScmRepositoryCloneTargetSchema).min(1),
  })
  .passthrough());
export type ScmRepositoryCloneTargetDescription =
  z.infer<typeof ScmRepositoryCloneTargetDescriptionSchema>;

export const ScmRepositoryCloneOutputSchema = lazyZodSchema(() => z.union([
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
]));
export type ScmRepositoryCloneOutput =
  z.infer<typeof ScmRepositoryCloneOutputSchema>;
