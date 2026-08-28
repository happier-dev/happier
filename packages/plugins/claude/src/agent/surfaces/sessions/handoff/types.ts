import type { HandoffImportResultV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { z } from 'zod';

import type { ClaudeExternalSessionSource } from '../external/source.js';

export const ClaudeSessionBundleSchema = z.object({
    agentId: z.literal('claude'),
    remoteSessionId: z.string().min(1),
    transcriptBase64: z.string().optional(),
    transcriptFile: z.object({
        t: z.literal('happier.handoff.file.v1'),
        filePath: z.string().min(1),
        offsetBytes: z.number().int().nonnegative(),
        sizeBytes: z.number().int().nonnegative(),
    }).strict().optional(),
}).strict().refine(
    (bundle) => Boolean(bundle.transcriptBase64) !== Boolean(bundle.transcriptFile),
    { message: 'Claude handoff bundle requires exactly one transcript source' },
);

export type ClaudeHandoffBundleFile = Readonly<{
    t: 'happier.handoff.file.v1';
    filePath: string;
    offsetBytes: number;
    sizeBytes: number;
}>;

export type ClaudeSessionBundle = Readonly<{
    agentId: 'claude';
    remoteSessionId: string;
}> & (
    | Readonly<{ transcriptBase64: string; transcriptFile?: never }>
    | Readonly<{ transcriptFile: ClaudeHandoffBundleFile; transcriptBase64?: never }>
);

export type ImportedClaudeSessionHandoffBundle = HandoffImportResultV1 & Readonly<{
    directSource: ClaudeExternalSessionSource;
}>;
