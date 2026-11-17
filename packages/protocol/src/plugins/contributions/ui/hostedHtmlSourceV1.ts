import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { ArtifactHtmlBundleV1Schema, type ArtifactHtmlBundleV1 } from '../../../artifacts/artifactHtmlV1.js';

/** Closed source data; frame isolation and Host API authority belong to the mounted host. */
export const PluginHostedHtmlSourceV1Schema: typeof ArtifactHtmlBundleV1Schema = lazyZodSchema(() => ArtifactHtmlBundleV1Schema);
export type PluginHostedHtmlSourceV1 = ArtifactHtmlBundleV1;
