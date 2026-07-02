import type { ExternalSessionsSource, SessionHandoffResumePlan } from '@happier-dev/protocol';

export type ClaudeSessionBundle = Readonly<{
    providerId: 'claude';
    remoteSessionId: string;
    transcriptBase64: string;
}>;

export type ImportedClaudeSessionHandoffBundle = Readonly<{
    remoteSessionId: string;
    directSource: ExternalSessionsSource;
    resume: SessionHandoffResumePlan;
}>;
