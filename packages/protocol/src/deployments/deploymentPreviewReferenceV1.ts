import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';

/** The four-part live preview key fits its portable storage index boundary. */
export const DeploymentPreviewPullRequestIdV1Schema = lazyZodSchema(() => DeploymentIdentifierV1Schema.check(
  z.refine(value => Array.from(value).length <= 191,
    { message: 'Preview pull request identity exceeds its portable storage character boundary.' }),
));
/** Public relation references only; private preview settings remain in Environment content. */
export const DeploymentPreviewReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  templateEnvironmentId: DeploymentIdentifierV1Schema,
  expectedTemplateRevision: DeploymentRevisionV1Schema,
  pullRequestId: DeploymentPreviewPullRequestIdV1Schema,
  runtimeTargetLinkId: DeploymentIdentifierV1Schema,
}));
