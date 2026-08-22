import type { HandoffImportResultV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { z } from 'zod';

import type { ClaudeExternalSessionSource } from '../external/source.js';

export const ClaudeSessionBundleSchema = z.object({
    agentId: z.literal('claude'),
    remoteSessionId: z.string().min(1),
    transcriptBase64: z.string(),
}).strict();

export type ClaudeSessionBundle = Readonly<z.infer<typeof ClaudeSessionBundleSchema>>;

export type ImportedClaudeSessionHandoffBundle = HandoffImportResultV1 & Readonly<{
    directSource: ClaudeExternalSessionSource;
}>;
