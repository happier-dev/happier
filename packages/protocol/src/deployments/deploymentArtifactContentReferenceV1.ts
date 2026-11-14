import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import type { ActionFailureCauseV1 } from '../actions/actionExecutionResult.js';

/** Shared storage address, independent of Action catalog initialization. */
export const DeploymentArtifactContentReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  contentArtifactId: DeploymentIdentifierV1Schema,
  contentHeaderVersion: DeploymentRevisionV1Schema,
  contentBodyVersion: DeploymentRevisionV1Schema,
}));
export type DeploymentArtifactContentReferenceV1 = z.infer<typeof DeploymentArtifactContentReferenceV1Schema>;

/** Exact Environment content CAS, shared without initializing the Action catalog. */
export const DeploymentEnvironmentContentCasV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: DeploymentIdentifierV1Schema,
  environmentId: DeploymentIdentifierV1Schema,
  expectedRevision: DeploymentRevisionV1Schema,
  ...DeploymentArtifactContentReferenceV1Schema.shape,
}));

/** Already opened by the incumbent Artifact owner; no credentials or decryption here. */
export type OpenedDeploymentArtifactV1 = Readonly<{
  artifactId: string;
  revision: Readonly<{ headerVersion: number; bodyVersion: number }>;
  header: unknown;
  body?: unknown;
}>;
export type DeploymentArtifactReadFailureV1 = Readonly<{
  ok: false; error: 'deployment_content_unavailable' | 'deployment_conflict';
  failureCause: ActionFailureCauseV1;
}>;

/** Only fixed validation steps leave this boundary, never Artifact content or parser prose. */
export function deploymentArtifactReadFailureV1(
  step: 'missing' | 'revision' | 'kind' | 'header' | 'body' | 'json' | 'content' | 'steps',
): DeploymentArtifactReadFailureV1 {
  const error = step === 'revision' ? 'deployment_conflict' : 'deployment_content_unavailable';
  return { ok: false, error, failureCause: { phase: `deployment.artifact.${step}`,
    errorClass: 'TypeError', errorCode: error, httpStatus: null } };
}

/** Exact identity/revisions and private kind are shared by header and full-content readers. */
export function readDeploymentArtifactHeaderV1(
  reference: DeploymentArtifactContentReferenceV1,
  artifact: OpenedDeploymentArtifactV1 | null,
  expectedKind: string,
): Readonly<{ ok: true; title: string }> | DeploymentArtifactReadFailureV1 {
  if (!artifact) return deploymentArtifactReadFailureV1('missing');
  if (artifact.artifactId !== reference.contentArtifactId
    || artifact.revision.headerVersion !== reference.contentHeaderVersion
    || artifact.revision.bodyVersion !== reference.contentBodyVersion)
    return deploymentArtifactReadFailureV1('revision');
  const header = readRecord(artifact.header);
  if (header.kind !== expectedKind) return deploymentArtifactReadFailureV1('kind');
  return typeof header.title === 'string'
    ? { ok: true, title: header.title } : deploymentArtifactReadFailureV1('header');
}

/** Domain callers must still parse the full body or the exact leaf they consume. */
export function readDeploymentArtifactJsonBodyV1(
  reference: DeploymentArtifactContentReferenceV1,
  artifact: OpenedDeploymentArtifactV1 | null,
  expectedKind: string,
): Readonly<{ ok: true; title: string; body: unknown }> | DeploymentArtifactReadFailureV1 {
  const header = readDeploymentArtifactHeaderV1(reference, artifact, expectedKind);
  if (!header.ok) return header;
  if (typeof artifact?.body !== 'string') return deploymentArtifactReadFailureV1('body');
  try { return { ...header, body: JSON.parse(artifact.body) as unknown }; }
  catch { return deploymentArtifactReadFailureV1('json'); }
}

/** Exact runtime content CAS shared by prepared deployment operation inputs. */
export const DeploymentRuntimeContentCasV1Schema = lazyZodSchema(() => z.extend(DeploymentEnvironmentContentCasV1Schema, {
  requestKey: DeploymentIdentifierV1Schema,
  targetLinkId: DeploymentIdentifierV1Schema,
  expectedTargetLinkRevision: DeploymentRevisionV1Schema,
}));
