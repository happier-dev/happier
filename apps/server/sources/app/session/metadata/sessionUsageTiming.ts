import { UsageSessionTimingV1Schema, type UsageSessionTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';

/** A document's timing is changed in its existing content CAS, never independently. */
export function nextSessionUsageTiming(input: Readonly<{
    current: unknown;
    supplied?: UsageSessionTimingV1;
    metadataWritten: boolean;
    metadataChanged: boolean;
    agentStateWritten: boolean;
    agentStateChanged: boolean;
    sharedEditor?: boolean;
}>): UsageSessionTimingV1 {
    const stored = UsageSessionTimingV1Schema.safeParse(input.current);
    const current = stored.success ? stored.data : { v: 1 as const, metadata: null, agentState: null };
    return {
        v: 1,
        metadata: input.metadataWritten && input.supplied && !input.sharedEditor
            ? input.supplied.metadata : input.metadataChanged ? null : current.metadata,
        agentState: input.agentStateWritten && input.supplied && !input.sharedEditor
            ? input.supplied.agentState : input.agentStateChanged ? null : current.agentState,
    };
}
