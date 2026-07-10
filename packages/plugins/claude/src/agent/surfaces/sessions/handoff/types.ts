import type { ExternalSessionsSource, SessionHandoffResumePlan } from '@happier-dev/plugin-sdk/sessions';
import { z } from 'zod';

export const ClaudeSessionBundleSchema = z.object({
    agentId: z.literal('claude'),
    remoteSessionId: z.string().min(1),
    transcriptBase64: z.string(),
}).strict();

export type ClaudeSessionBundle = Readonly<z.infer<typeof ClaudeSessionBundleSchema>>;

export type ImportedClaudeSessionHandoffBundle = Readonly<{
    remoteSessionId: string;
    directSource: ExternalSessionsSource;
    resume: SessionHandoffResumePlan;
}>;
