import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ScmCommitOidSchema } from './commitPublication.js';

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
  resolveLegacyScmHostingProviderId,
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

export const ScmRepositoryCloneRepositorySelectorSchema = lazyZodSchema(() => z.looseObject({
    nameWithOwner: z.string().check(z.trim(), z.minLength(1)),
    webUrl: z.optional(z.string().check(z.url())),
    cloneUrl: z.optional(z.string().check(z.minLength(1))),
    sshUrl: z.optional(z.string().check(z.minLength(1))),
    defaultBranch: z.optional(z.nullable(z.string().check(z.minLength(1)))),
    // The forge resolves visibility; a saved locator need not have discovered it.
    visibility: z.optional(ScmHostingRepositorySummarySchema.shape.visibility),
  }));
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

export const ScmCredentialFreeRepositorySelectorV1Schema = lazyZodSchema(() => z.strictObject({
  provider: z.strictObject({
    id: z.string().check(z.minLength(1), z.overwrite(id => resolveLegacyScmHostingProviderId(id) ?? id)),
    kind: ScmHostingProviderKindSchema, displayName: z.string().check(z.minLength(1)),
    baseUrl: z.string().check(z.url(), z.refine(isCredentialFreeRepositoryLocator)),
  }),
  repository: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.pick(ScmRepositoryCloneRepositorySelectorSchema, {
    nameWithOwner: true, webUrl: true, cloneUrl: true, sshUrl: true, defaultBranch: true, visibility: true,
  }), {
    webUrl: z.optional(z.string().check(z.url(), z.refine(isCredentialFreeRepositoryLocator))),
    cloneUrl: z.optional(z.string().check(z.trim(), z.minLength(1), z.refine(isCredentialFreeRepositoryLocator))),
    sshUrl: z.optional(z.string().check(z.trim(), z.minLength(1), z.refine(isCredentialFreeRepositoryLocator))),
  })),
  protocol: SourceControlCloneProtocolSchema,
}));
export type ScmCredentialFreeRepositorySelectorV1 = z.infer<typeof ScmCredentialFreeRepositorySelectorV1Schema>;

export const ScmHostingRepositoryGetRequestV1Schema = lazyZodSchema(() => z.strictObject({
  selector: ScmCredentialFreeRepositorySelectorV1Schema,
}));
export type ScmHostingRepositoryGetRequestV1 = z.infer<typeof ScmHostingRepositoryGetRequestV1Schema>;

/** Only an authoritative public observation can produce disclosure metadata. */
export const ScmHostingRepositoryGetResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ success: z.literal(true), kind: z.literal('public'), repository: z.strictObject({
    label: z.string().check(z.trim(), z.minLength(1)),
    url: z.string().check(z.url(), z.refine(value => isCredentialFreeRepositoryLocator(value) && new URL(value).protocol === 'https:')),
  }) }),
  z.strictObject({ success: z.literal(true), kind: z.literal('private') }),
  z.strictObject({ success: z.literal(true), kind: z.literal('unknown') }),
  z.strictObject({ success: z.literal(true), kind: z.literal('unsupported') }),
  z.strictObject({ success: z.literal(false), kind: z.literal('failed'), code: z.literal('repository_unavailable') }),
]));
export type ScmHostingRepositoryGetResponseV1 = z.infer<typeof ScmHostingRepositoryGetResponseV1Schema>;

/** Machine placement uses the incumbent Action target selector, outside this RPC payload. */
export const ScmHostingRepositoryResolveAddressRequestV1Schema = lazyZodSchema(() => z.strictObject({
  address: z.string().check(z.trim(), z.minLength(1)),
}));
export type ScmHostingRepositoryResolveAddressRequestV1 = z.infer<typeof ScmHostingRepositoryResolveAddressRequestV1Schema>;

export const ScmHostingRepositoryResolveAddressResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ success: z.literal(true), kind: z.literal('resolved'), selector: ScmCredentialFreeRepositorySelectorV1Schema }),
  z.strictObject({ success: z.literal(true), kind: z.literal('unknown') }),
  z.strictObject({ success: z.literal(true), kind: z.literal('unsupported') }),
  z.strictObject({ success: z.literal(true), kind: z.literal('invalid') }),
]));
export type ScmHostingRepositoryResolveAddressResponseV1 = z.infer<typeof ScmHostingRepositoryResolveAddressResponseV1Schema>;

/** Source-contained folder selection shares clone's traversal boundary. */
export const ScmRepositoryContainedSubdirV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.refine(value => !hasUnsafePathInput(value) && !/^(?:[/\\]|[A-Za-z]:)/.test(value), 'Repository subdirectory must be relative and contained')));

export const ScmRepositoryCloneInputSchema = lazyZodSchema(() => z.strictObject({
    provider: ScmHostingProviderRefSchema,
    repository: ScmRepositoryCloneRepositorySelectorSchema,
    destinationParentPath: z.string().check(z.trim(), z.minLength(1), z.refine((value) => !hasUnsafePathInput(value), 'Destination parent path must not use home expansion or traversal segments')),
    destinationDirectoryName: z.string().check(z.trim(), z.minLength(1), z.refine((value) => value !== '.' && value !== '..' && !/[\/\\]/.test(value) && !hasUnsafePathInput(value), 'Destination directory name must be a single safe path segment')),
    protocol: SourceControlCloneProtocolSchema,
    initialCheckout: z.optional(z.strictObject({ branch: z.literal('main'), commit: ScmCommitOidSchema })),
    confirmed: z.literal(true),
    authorizationToken: ScmRepositoryCloneAuthorizationTokenSchema,
  }));
export type ScmRepositoryCloneInput =
  z.infer<typeof ScmRepositoryCloneInputSchema>;

export const ScmRepositoryCloneTargetSchema = lazyZodSchema(() => z.strictObject({
    protocol: z.enum(['ssh', 'https']),
    url: z.string().check(z.minLength(1)),
    isDefault: z.optional(z.boolean()),
  }));
export type ScmRepositoryCloneTarget =
  z.infer<typeof ScmRepositoryCloneTargetSchema>;

export const ScmRepositoryCloneTargetDescriptionSchema = lazyZodSchema(() => z.looseObject({
    auth: z.optional(ScmHostingRepositoryAuthSummarySchema),
    repository: ScmHostingRepositorySummarySchema,
    targets: z.array(ScmRepositoryCloneTargetSchema).check(z.minLength(1)),
  }));
export type ScmRepositoryCloneTargetDescription =
  z.infer<typeof ScmRepositoryCloneTargetDescriptionSchema>;

export const ScmRepositoryCloneOutputSchema = lazyZodSchema(() => z.union([
  z.looseObject({
      success: z.literal(true),
      destinationPath: z.string().check(z.minLength(1)),
      cloneProtocol: z.enum(['ssh', 'https']),
      cloneUrl: z.string().check(z.minLength(1)),
      repository: ScmHostingRepositorySummarySchema,
      snapshot: z.optional(ScmWorkingSnapshotSchema),
      stdout: z.optional(z.string()),
      stderr: z.optional(z.string()),
    }),
  z.extend(ScmRepositoryProvisioningFailureResponseSchema, {
    errorCode: z.optional(ScmOperationErrorCodeSchema),
    destinationPath: z.optional(z.string().check(z.minLength(1))),
  }),
]));
export type ScmRepositoryCloneOutput =
  z.infer<typeof ScmRepositoryCloneOutputSchema>;
