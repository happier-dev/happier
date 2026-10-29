import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';
import { readRecord } from '../inputs/inputRecords.js';

/** Shared storage address, independent of Action catalog initialization. */
export const DeploymentArtifactContentReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  contentArtifactId: DeploymentIdentifierV1Schema,
  contentHeaderVersion: DeploymentRevisionV1Schema,
  contentBodyVersion: DeploymentRevisionV1Schema,
}));
export type DeploymentArtifactContentReferenceV1 = z.infer<typeof DeploymentArtifactContentReferenceV1Schema>;

/** Already opened by the incumbent Artifact owner; no credentials or decryption here. */
export type OpenedDeploymentArtifactV1 = Readonly<{
  artifactId: string;
  revision: Readonly<{ headerVersion: number; bodyVersion: number }>;
  header: unknown;
  body?: unknown;
}>;
export type DeploymentArtifactReadFailureV1 = Readonly<{
  ok: false; error: 'deployment_content_unavailable' | 'deployment_conflict';
}>;

/** Exact identity/revisions and private kind are shared by header and full-content readers. */
export function readDeploymentArtifactHeaderV1(
  reference: DeploymentArtifactContentReferenceV1,
  artifact: OpenedDeploymentArtifactV1 | null,
  expectedKind: string,
): Readonly<{ ok: true; title: string }> | DeploymentArtifactReadFailureV1 {
  if (!artifact) return { ok: false, error: 'deployment_content_unavailable' };
  if (artifact.artifactId !== reference.contentArtifactId
    || artifact.revision.headerVersion !== reference.contentHeaderVersion
    || artifact.revision.bodyVersion !== reference.contentBodyVersion)
    return { ok: false, error: 'deployment_conflict' };
  const header = readRecord(artifact.header);
  return header.kind === expectedKind && typeof header.title === 'string'
    ? { ok: true, title: header.title } : { ok: false, error: 'deployment_content_unavailable' };
}

/** Domain callers must still parse the full body or the exact leaf they consume. */
export function readDeploymentArtifactJsonBodyV1(
  reference: DeploymentArtifactContentReferenceV1,
  artifact: OpenedDeploymentArtifactV1 | null,
  expectedKind: string,
): Readonly<{ ok: true; title: string; body: unknown }> | DeploymentArtifactReadFailureV1 {
  const header = readDeploymentArtifactHeaderV1(reference, artifact, expectedKind);
  if (!header.ok) return header;
  if (typeof artifact?.body !== 'string') return { ok: false, error: 'deployment_content_unavailable' };
  try { return { ...header, body: JSON.parse(artifact.body) as unknown }; }
  catch { return { ok: false, error: 'deployment_content_unavailable' }; }
}
