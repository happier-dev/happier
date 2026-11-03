import type { ArtifactSharingKindAdapterV1 } from '../../artifacts/artifactSharingV1.js';
import { BOT_TEMPLATE_ARTIFACT_KIND_V1, readBotTemplateArtifactV1 } from './botTemplateV1.js';

/** Drafts and their revision history are always owner-private. Only the separate release can be granted. */
export const botTemplateArtifactSharingAdapterV1 = {
  kind: BOT_TEMPLATE_ARTIFACT_KIND_V1,
  canShare(resource) {
    try { return readBotTemplateArtifactV1(resource)?.state === 'released'; }
    catch { return false; }
  },
} satisfies ArtifactSharingKindAdapterV1;
