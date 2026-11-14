import { isAccountCurrentnessEntityIdV1 } from '@happier-dev/protocol/changes';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { InvalidateSync } from '@/utils/sessions/sync';
import type { createActionApprovalContinuationObserver } from './actionApprovalContinuation';

/** Headless adapter for the same exact-Home Artifact observation used by mounted approvals. */
export function observeActionApprovalContinuation(input: Readonly<{
    observer: ReturnType<typeof createActionApprovalContinuationObserver>;
    scope: ServerAccountScope;
    isCurrent(): boolean;
    fetchArtifact(artifactId: string): Promise<DecryptedArtifact | null>;
}>): () => void {
    const read = new InvalidateSync(async () => {
        const registration = input.observer.getSnapshot().approval;
        if (!registration || !input.isCurrent()) return;
        try {
            const artifact = await input.fetchArtifact(registration.artifactId);
            if (!input.isCurrent() || input.observer.getSnapshot().approval !== registration) return;
            const invalid = Boolean(artifact?.isDecrypted !== false && artifact && typeof artifact.body === 'string'
                && !approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body));
            input.observer.observeArtifact(artifact, invalid);
        } catch {
            // Missing transport evidence is not a terminal approval disposition; the next push/reconnect re-reads.
        }
    });
    const onChange = (event: HomeAccountChangeEvent) => {
        const artifactId = input.observer.getSnapshot().approval?.artifactId;
        if (artifactId && areServerProfileIdentifiersEquivalent(event.serverId, input.scope.serverId)
            && (event.entityIds === undefined || event.entityIds.includes(artifactId)
                || event.entityIds.some(isAccountCurrentnessEntityIdV1))) read.invalidate();
    };
    const wake = subscribeHomeAccountChange(onChange, {
        reconnect: { readNotCurrent: () => Boolean(input.observer.getSnapshot().approval) } });
    const observePending = () => {
        if (input.observer.getSnapshot().approval) read.invalidate();
    };
    const observe = input.observer.subscribe(observePending);
    observePending();
    return () => { read.stop(); observe(); wake(); };
}
