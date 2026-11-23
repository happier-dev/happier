import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '../artifacts/deploymentArtifactKindsV1.js';
import { DeploymentArtifactContentReferenceV1Schema, readDeploymentArtifactHeaderV1,
  type OpenedDeploymentArtifactV1 } from '../deployments/deploymentArtifactContentReferenceV1.js';
import { DeploymentIdentifierV1Schema } from '../deployments/deploymentIdentifiersV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ACCOUNT_ERASURE_PREVIEW_HTTP_PATH_V1 = '/v1/auth/account/delete/preview' as const;

const sharedEnvironment = {
  environmentId: DeploymentIdentifierV1Schema,
  memberCount: z.number().check(z.int(), z.positive()),
};

/** The Home provides scope and counts. The owner opens names via their Artifact keys. */
export const AccountErasurePreviewResponseV1Schema = lazyZodSchema(() => z.strictObject({
  sharedEnvironments: z.array(z.strictObject({ ...sharedEnvironment, ...DeploymentArtifactContentReferenceV1Schema.shape })),
}));
export type AccountErasurePreviewResponseV1 = z.infer<typeof AccountErasurePreviewResponseV1Schema>;

export const AccountErasureReviewV1Schema = lazyZodSchema(() => z.strictObject({
  sharedEnvironments: z.array(z.strictObject({ ...sharedEnvironment, name: z.string().check(z.trim(), z.minLength(1)) })),
}));
export type AccountErasureReviewV1 = z.infer<typeof AccountErasureReviewV1Schema>;

export const ACCOUNT_ERASURE_REVIEW_UNAVAILABLE_CODE = 'account_erasure_review_unavailable' as const;
export const accountErasureReviewUnavailable = () => ({ ok: false as const,
  errorCode: ACCOUNT_ERASURE_REVIEW_UNAVAILABLE_CODE, error: ACCOUNT_ERASURE_REVIEW_UNAVAILABLE_CODE });

export async function openAccountErasureReviewV1(preview: AccountErasurePreviewResponseV1,
  readHeaders: (ids: readonly string[]) => Promise<readonly OpenedDeploymentArtifactV1[]>,
): Promise<AccountErasureReviewV1 | ReturnType<typeof accountErasureReviewUnavailable>> {
  if (preview.sharedEnvironments.length === 0) return { sharedEnvironments: [] };
  const ids = [...new Set(preview.sharedEnvironments.map(environment => environment.contentArtifactId))];
  const headers = new Map((await readHeaders(ids)).map(artifact => [artifact.artifactId, artifact]));
  const sharedEnvironments: AccountErasureReviewV1['sharedEnvironments'] = [];
  for (const environment of preview.sharedEnvironments) {
    const opened = readDeploymentArtifactHeaderV1(environment, headers.get(environment.contentArtifactId) ?? null,
      DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1);
    if (!opened.ok || !opened.title.trim()) return accountErasureReviewUnavailable();
    sharedEnvironments.push({ environmentId: environment.environmentId, memberCount: environment.memberCount, name: opened.title.trim() });
  }
  return { sharedEnvironments };
}
