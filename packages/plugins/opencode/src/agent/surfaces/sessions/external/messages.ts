import type { AgentExternalSessionTranscriptItem } from '@happier-dev/plugin-sdk/sessions/external';

import {
  mapOpenCodeMessageToTranscriptItem,
  measureOpenCodeTranscriptItemBytes,
} from '../../../runtime/server/transcript/indexedTranscript.js';

export function mapOpenCodeMessageToExternalSessionItem(
  message: unknown,
  providerSessionId: string,
): AgentExternalSessionTranscriptItem | null {
  return mapOpenCodeMessageToTranscriptItem(message, providerSessionId);
}

export const measureOpenCodeExternalTranscriptItemBytes = measureOpenCodeTranscriptItemBytes;
