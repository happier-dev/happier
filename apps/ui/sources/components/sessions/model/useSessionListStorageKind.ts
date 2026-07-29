import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';

export function useSessionListStorageKind(): Readonly<{
    externalSessionsEnabled: boolean;
    storageKind: SessionListStorageFilter;
    setStorageKind: (storageKind: SessionListStorageFilter) => void;
}> {
    const externalSessionsDecision = useFeatureDecision('sessions.direct');
    const externalSessionsEnabled = externalSessionsDecision?.state === 'enabled';
    const [sessionsListStorageFilter, setSessionsListStorageFilter] = useLocalSettingMutable('sessionsListStorageFilter');

    return {
        externalSessionsEnabled,
        storageKind: externalSessionsEnabled ? sessionsListStorageFilter : 'persisted',
        setStorageKind: setSessionsListStorageFilter,
    };
}
