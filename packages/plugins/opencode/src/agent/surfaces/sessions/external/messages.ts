import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/plugin-sdk/sessions';

import {
  mapOpenCodeMessageToTranscriptItem,
  measureOpenCodeTranscriptItemBytes,
} from '../../../runtime/server/transcript/indexedTranscript.js';

export function mapOpenCodeMessageToExternalSessionItem(
  message: unknown,
  providerSessionId: string,
): ExternalSessionTranscriptRawMessageV1 | null {
  return mapOpenCodeMessageToTranscriptItem(message, providerSessionId);
}

export const measureOpenCodeExternalTranscriptItemBytes = measureOpenCodeTranscriptItemBytes;
