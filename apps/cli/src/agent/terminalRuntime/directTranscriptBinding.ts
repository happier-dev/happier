import type { DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';

export type LocalHostedDirectTranscriptBinding = Readonly<{
    providerId: DirectSessionsProviderId;
    source: DirectSessionsSource;
    remoteSessionId: string;
    env?: NodeJS.ProcessEnv;
}>;
