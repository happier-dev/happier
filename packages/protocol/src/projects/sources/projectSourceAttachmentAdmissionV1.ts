import type { z } from 'zod';
import type { PromptArtifactRefV1 } from '../../prompts/library/promptArtifactRefsV1.js';
import { WIDGET_SURFACE_ARTIFACT_KIND_V1 } from '../../widgets/widgetSurfaceArtifactV1.js';
import { SourceAttachmentV1Schema } from './projectSourceV1.js';

/** Content kind is read from the current Artifact, never from an attachment or Source grant. */
export function isProjectSourceAttachmentKindV1(
  purpose: 'context' | 'dashboard', refKind: 'doc' | 'bundle', header: unknown,
): boolean {
  if (!header || typeof header !== 'object') return false;
  const kind: unknown = Reflect.get(header, 'kind');
  if (purpose === 'dashboard') return refKind === 'doc' && kind === WIDGET_SURFACE_ARTIFACT_KIND_V1;
  return refKind === 'bundle' ? kind === 'prompt_bundle.v2' : kind === 'prompt_doc.v2' || kind === 'memory_doc.v1';
}

/** The client’s existing Artifact reader owns authentication, current access, mode and decryption. */
export async function admitProjectSourceAttachmentV1(input: Readonly<{
  attachment: z.input<typeof SourceAttachmentV1Schema>;
  sourceServerId: string;
  signal?: AbortSignal;
  readArtifact(ref: PromptArtifactRefV1 & Readonly<{ serverId: string }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{
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
