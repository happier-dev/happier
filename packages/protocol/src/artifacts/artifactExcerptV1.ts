import type { ArtifactBodyV1 } from './artifactBinaryV1.js';
import { getArtifactContentDeliveryPolicyV1 } from './artifactKindV1.js';

/** ART-A2's card preview contract; the encrypted header carries this projection, not a search index. */
export const ARTIFACT_EXCERPT_MAX_CHARS_V1 = 600;

export function deriveArtifactExcerptV1(body: ArtifactBodyV1 | null): string | undefined {
  if (typeof body !== 'string' || !body) return undefined;
  let end = Math.min(body.length, ARTIFACT_EXCERPT_MAX_CHARS_V1);
  // Do not publish half of a Unicode surrogate pair at the preview boundary.
  const last = body.charCodeAt(end - 1);
  const next = body.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return body.slice(0, end) || undefined;
}

/** Every ordinary client write refreshes (or removes) the body-derived header projection. */
export function withArtifactExcerptV1(
  header: Readonly<Record<string, unknown>>, body: ArtifactBodyV1 | null,
): Readonly<Record<string, unknown>> {
  const { excerpt: _previous, ...metadata } = header;
  if (!getArtifactContentDeliveryPolicyV1(header.kind).bodyPreviewAllowed) return metadata;
  const excerpt = deriveArtifactExcerptV1(body);
  return excerpt === undefined ? metadata : { ...metadata, excerpt };
}
