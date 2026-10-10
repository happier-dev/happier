import * as React from 'react';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { MemoryCreationReceipt } from '@/sync/ops/promptLibrary/memoryDocuments';

/** A saved document stays reachable until its qualified attachment publishes, within its Account lifetime. */
export function useMemoryCreationReceipt(params: Readonly<{
    serverId: string;
    scopeKey: string;
    attachedRef: PromptDocArtifactRefV1 | null;
}>): Readonly<{
    receipt: MemoryCreationReceipt | null;
    ref: PromptDocArtifactRefV1 | null;
    onCreatedMemory: (receipt: MemoryCreationReceipt) => void;
}> {
    const accountScope = useActiveServerAccountScope(params.serverId);
    const lifetime = captureActiveServerAccountScopeCurrentness();
    const key = JSON.stringify([params.serverId, accountScope?.accountId, params.scopeKey]);
    const [created, setCreated] = React.useState<Readonly<{
        key: string;
        isCurrent: () => boolean;
        receipt: MemoryCreationReceipt;
    }> | null>(null);
    const receipt = created?.key === key && created.isCurrent() ? created.receipt : null;
    const onCreatedMemory = React.useCallback((next: MemoryCreationReceipt) => {
        if (lifetime.isCurrent()) setCreated({ key, isCurrent: lifetime.isCurrent, receipt: next });
    }, [key, lifetime]);
    React.useEffect(() => {
        const retirement = lifetime.onRetire(() => setCreated(null));
        return () => retirement.dispose();
    }, [lifetime]);
    const attached = params.attachedRef;
    React.useEffect(() => {
        if (receipt && attached?.artifactId === receipt.ref.artifactId
            && areServerProfileIdentifiersEquivalent(attached.serverId ?? params.serverId, receipt.ref.serverId ?? params.serverId)) {
            setCreated(null);
        }
    }, [attached, params.serverId, receipt]);
    return { receipt, ref: receipt?.attachment === 'conflict' ? receipt.ref : attached ?? receipt?.ref ?? null, onCreatedMemory };
}
