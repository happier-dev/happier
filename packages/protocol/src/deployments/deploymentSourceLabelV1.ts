import { z } from '../zodRuntimePolicy.js';
import { ScmCommitOidSchema } from '../scm/commitPublication.js';
import { DeploymentDigestV1Schema as digest, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentFolderReviewRevisionV1Schema, projectDeploymentFolderReviewRevisionV1 } from './deploymentFolderReviewRevisionV1.js';
import type { DeploymentSourceIntentV1 } from './storedAppInputV1.js';
import type { DeploymentContentV1 } from './deploymentReceiptContentV1.js';

/** Display identity only; stored Compose documents and private binding sources never enter review. */
export const DeploymentReviewRevisionV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('repository'), sha: ScmCommitOidSchema, subject: z.optional(z.string()) }),
  z.strictObject({ kind: z.literal('stored'), contentRevision: revision, composeDigest: digest }),
  DeploymentFolderReviewRevisionV1Schema,
]);
export type DeploymentReviewRevisionV1 = z.infer<typeof DeploymentReviewRevisionV1Schema>;

export function projectDeploymentReviewRevisionV1(source: Extract<DeploymentSourceIntentV1, { kind: 'folder' }>): Extract<DeploymentReviewRevisionV1, { kind: 'folder' }>;
export function projectDeploymentReviewRevisionV1(source: DeploymentSourceIntentV1, subject?: string): DeploymentReviewRevisionV1;
export function projectDeploymentReviewRevisionV1(receipt: Pick<DeploymentContentV1, 'sourceIntent' | 'commitSubject' | 'sourceMethod' | 'platform'>): DeploymentReviewRevisionV1 | null;
export function projectDeploymentReviewRevisionV1(
  input: DeploymentSourceIntentV1 | Pick<DeploymentContentV1, 'sourceIntent' | 'commitSubject' | 'sourceMethod' | 'platform'>,
  subject?: string,
): DeploymentReviewRevisionV1 | null {
  const receipt = 'kind' in input ? undefined : input;
  const source = 'kind' in input ? input : input.sourceIntent;
  if (!source) return null;
  if (source.kind === 'folder') return projectDeploymentFolderReviewRevisionV1(source);
  if (source.kind === 'stored') return { kind: source.kind, contentRevision: source.contentRevision, composeDigest: source.composeDigest };
  // Pages Git submits a branch. Only the provider's saved observation establishes the commit it built.
  const pagesGit = receipt?.sourceMethod === 'gitIntegration' && receipt.platform?.preparedNative?.pages?.projectMode === 'gitIntegration';
  const sha = pagesGit ? receipt.platform?.observation.builtSha : source.sha;
  if (!sha) return null;
  const commitSubject = sha === source.sha ? receipt?.commitSubject ?? subject : undefined;
  return { kind: source.kind, sha, ...(commitSubject === undefined ? {} : { subject: commitSubject }) };
}

/** Compares recorded source labels. Missing build evidence leaves equality unestablished. */
export function areDeploymentSourceLabelsEqualV1(
  left: DeploymentReviewRevisionV1 | null | undefined,
  right: DeploymentReviewRevisionV1 | null | undefined,
): boolean | null {
  if (!left || !right) return null;
  if (left.kind === 'repository') return right.kind === 'repository' && left.sha === right.sha;
  if (left.kind === 'stored') return right.kind === 'stored' && left.composeDigest === right.composeDigest;
  return right.kind === 'folder' && left.manifestFingerprint === right.manifestFingerprint;
}
