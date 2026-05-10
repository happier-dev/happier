import type { ExternalSessionsProviderId, ExternalSessionsSource } from '@happier-dev/protocol';

export type LocalHostedDirectTranscriptBinding = Readonly<{
    providerId: ExternalSessionsProviderId;
    source: ExternalSessionsSource;
    remoteSessionId: string;
    env?: NodeJS.ProcessEnv;
}>;
