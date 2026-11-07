import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';

export function useSessionListStorageKind(): Readonly<{
    directSessionsEnabled: boolean;
    storageKind: SessionListStorageFilter;
}> {
    const directSessionsDecision = useFeatureDecision('sessions.direct');
    const directSessionsEnabled = directSessionsDecision?.state === 'enabled';

    return {
        directSessionsEnabled,
        storageKind: directSessionsEnabled ? 'all' : 'persisted',
    };
}
