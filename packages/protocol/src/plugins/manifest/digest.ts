import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { computePluginUiArtifactSha256DigestV1, isPluginUiArtifactDigestV1, type PluginUiArtifactDigestV1 } from '../ui/artifactIntegrity.js';
import type { ParsedPluginManifestV2 } from './v2.js';
import { readPrecomputedDeclarationField } from '../contributions/deferredDeclarationFields.js';

/** Identity of the admitted declaration, shared by publication and stored claims. */
export function computePluginManifestDigestV2(manifest: ParsedPluginManifestV2): PluginUiArtifactDigestV1 {
  // This host-only sidecar is bound to exact publisher bytes. JSON ingress and
  // declaration projections cannot carry it; they compute their own identity.
  const precomputed = readPrecomputedDeclarationField(manifest, 'canonicalDeclarationDigest');
  if (precomputed && typeof precomputed.value === 'string' && isPluginUiArtifactDigestV1(precomputed.value)) return precomputed.value;
  return computePluginUiArtifactSha256DigestV1(new TextEncoder().encode(createCanonicalJsonSigningInput(manifest)));
}
