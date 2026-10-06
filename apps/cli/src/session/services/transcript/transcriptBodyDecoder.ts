import { projectTranscriptBodySemanticContent } from '@happier-dev/protocol/sessions/messages/transcriptBodySemanticProjection';
import type { TranscriptBodySemanticProjection } from '@happier-dev/protocol';

export type DecodedTranscriptBody = TranscriptBodySemanticProjection;

/** CLI compatibility name for the protocol-owned semantic transcript projection. */
export const decodeTranscriptBody = projectTranscriptBodySemanticContent;
