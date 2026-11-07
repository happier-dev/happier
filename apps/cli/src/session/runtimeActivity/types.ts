import type { SessionRuntimeActivitySnapshot } from '@happier-dev/protocol';

export type RuntimeActivityApplicability = 'supported' | 'unavailable' | 'not_applicable';
export type RuntimeActivitySlot = 'agentRuntime' | 'executionRuns' | 'turnActivity';

export { SessionRuntimeActivitySnapshotSchema as SessionRuntimeActivityContributionSchema } from '@happier-dev/protocol';

export type SessionRuntimeActivityContribution = SessionRuntimeActivitySnapshot;

export type SessionRuntimeActivityContributionHandle = Readonly<{
    report(snapshot: SessionRuntimeActivityContribution, reason: string): Promise<void>;
    markUnknown(reason: string): Promise<void>;
    dispose(): Promise<void>;
}>;

export type SessionRuntimeActivitySnapshotPublisher = Readonly<{
    publish(snapshot: SessionRuntimeActivitySnapshot): Promise<void>;
    subscribeDesiredReoffer?(listener: () => Promise<void>): () => void;
    close(): Promise<void>;
}>;

export type SessionRuntimeActivity = Readonly<{
    applicability: RuntimeActivityApplicability;
    agentRuntimeContributionHandle: SessionRuntimeActivityContributionHandle | null;
    executionRunsContributionHandle: SessionRuntimeActivityContributionHandle;
    turnActivityContributionHandle: SessionRuntimeActivityContributionHandle;
    bindPublisher(publisher: SessionRuntimeActivitySnapshotPublisher): Promise<void>;
    dispose(): Promise<void>;
}>;
