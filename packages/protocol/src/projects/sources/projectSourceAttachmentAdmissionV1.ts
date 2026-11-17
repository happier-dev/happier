import type { z } from '../../zodRuntimePolicy.js';
import type { PromptArtifactRefV1 } from '../../prompts/library/promptArtifactRefsV1.js';
import { WIDGET_SURFACE_ARTIFACT_KIND_V1 } from '../../widgets/widgetSurfaceArtifactV1.js';
import { SourceAttachmentV1Schema, type SourceAttachmentV1, type ProjectSourcePublicationPatchV1,
  type ProjectSourcesUpdateInputV1, type ProjectSourcesReadOutputV1, type ProjectSourcesFailureV1 } from './projectSourceV1.js';
import type { ActionExecuteFailure } from '../../actions/actionExecutionResult.js';
import { PROJECT_SETUP_ARTIFACT_KIND_V1 } from '../projectSetupV1.js';

export type ProjectSourceArtifactReadOptionsV1 = Readonly<{
  signal?: AbortSignal;
  projectSourceId?: string;
  projectSourcePatch?: ProjectSourcePublicationPatchV1;
}>;

/** Content kind is read from the current Artifact, never from an attachment or Source grant. */
export function isProjectSourceAttachmentKindV1(
  purpose: SourceAttachmentV1['purpose'], refKind: 'doc' | 'bundle', header: unknown,
): boolean {
  if (!header || typeof header !== 'object') return false;
  const kind: unknown = Reflect.get(header, 'kind');
  if (purpose === 'onboarding_task') return refKind === 'doc' && kind === 'prompt_doc.v2';
  if (purpose === 'setup') return refKind === 'doc' && kind === PROJECT_SETUP_ARTIFACT_KIND_V1;
  if (purpose === 'dashboard') return refKind === 'doc' && kind === WIDGET_SURFACE_ARTIFACT_KIND_V1;
  return refKind === 'bundle' ? kind === 'prompt_bundle.v2' : kind === 'prompt_doc.v2' || kind === 'memory_doc.v1';
}

/** The client’s existing Artifact reader owns authentication, current access, mode and decryption. */
export async function admitProjectSourceAttachmentV1(input: Readonly<{
  attachment: z.input<typeof SourceAttachmentV1Schema>;
  sourceServerId: string;
  signal?: AbortSignal;
  readArtifact(ref: PromptArtifactRefV1 & Readonly<{ serverId: string }>, options?: ProjectSourceArtifactReadOptionsV1): Promise<Readonly<{
    artifactId: string; header: unknown;
  }> | null>;
}>): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: 'artifact_unavailable' | 'artifact_wrong_kind' }>> {
  input.signal?.throwIfAborted();
  const parsed = SourceAttachmentV1Schema.safeParse(input.attachment);
  if (!parsed.success) return { ok: false, error: 'artifact_wrong_kind' };
  const attachment = parsed.data;
  const ref = attachment.purpose === 'context' ? attachment.entry.ref : attachment.ref;
  const qualified = { ...ref, serverId: ref.serverId ?? input.sourceServerId };
  try {
    const artifact = await input.readArtifact(qualified, input.signal ? { signal: input.signal } : undefined);
    input.signal?.throwIfAborted();
    if (!artifact || artifact.artifactId !== ref.artifactId) return { ok: false, error: 'artifact_unavailable' };
    return isProjectSourceAttachmentKindV1(attachment.purpose, ref.kind, artifact.header)
      ? { ok: true } : { ok: false, error: 'artifact_wrong_kind' };
  } catch {
    input.signal?.throwIfAborted();
    return { ok: false, error: 'artifact_unavailable' };
  }
}

/** Select publication inputs once; the existing Artifact reader owns recipient-key preparation. */
export async function prepareProjectSourceUpdateV1(input: Readonly<{
  input: ProjectSourcesUpdateInputV1;
  signal?: AbortSignal;
  readSource(): Promise<ProjectSourcesReadOutputV1 | ActionExecuteFailure>;
  readArtifact: Parameters<typeof admitProjectSourceAttachmentV1>[0]['readArtifact'];
}>): Promise<Readonly<{ ok: true }> | ProjectSourcesFailureV1 | ActionExecuteFailure> {
  const { patch, serverId, sourceId } = input.input;
  const intent = patch.attachment;
  const publicationPatch: ProjectSourcePublicationPatchV1 = {
    ...(patch.owner === undefined ? {} : { owner: patch.owner }),
    ...(patch.audience === undefined ? {} : { audience: patch.audience }),
  };
  const publicationRead: typeof input.readArtifact = (ref, options) => input.readArtifact(ref, { ...options,
    projectSourceId: sourceId, ...(patch.owner === undefined && patch.audience === undefined ? {} : { projectSourcePatch: publicationPatch }) });
  let setup: Extract<SourceAttachmentV1, { purpose: 'setup' }> | undefined;
  if (intent?.kind === 'attach' && intent.attachment.purpose === 'setup') setup = intent.attachment;
  else if (patch.owner !== undefined || patch.audience !== undefined) {
    input.signal?.throwIfAborted();
    const current = await input.readSource();
    input.signal?.throwIfAborted();
    if (!current.ok) return current;
    setup = current.source.attachments?.find(attachment => attachment.purpose === 'setup');
    if (setup && intent?.kind === 'detach' && intent.purpose === 'setup'
      && setup.ref.artifactId === intent.ref.artifactId && setup.ref.kind === intent.ref.kind
      && (setup.ref.serverId ?? serverId) === (intent.ref.serverId ?? serverId)) setup = undefined;
  }
  if (setup) {
    const admission = await admitProjectSourceAttachmentV1({ attachment: setup, sourceServerId: serverId,
      signal: input.signal, readArtifact: publicationRead });
    if (!admission.ok) return admission;
  }
  if (intent?.kind === 'attach' && intent.attachment.purpose !== 'setup') {
    return admitProjectSourceAttachmentV1({ attachment: intent.attachment, sourceServerId: serverId,
      signal: input.signal, readArtifact: input.readArtifact });
  }
  return { ok: true };
}
