import type {
    AgentState,
    Metadata,
} from '@/api/types';

import type { SessionUsageObservationPublisher } from '../usagePublishing';

export type PostSendReactionPort = Readonly<{
    sessionId: string;
    updateAgentState: (updater: (state: AgentState) => AgentState) => Promise<void> | void;
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
    getMetadataSnapshot: () => Metadata | null;
    usageObservationPublisher: SessionUsageObservationPublisher;
}>;
