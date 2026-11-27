import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { SessionListStorageFilter, SessionStorageKind } from '@/sync/domains/session/sessionStorageKind';

export function useSessionListStorageKind(): Readonly<{
    directSessionsEnabled: boolean;
    storageKind: SessionStorageKind;
    storageFilter: SessionListStorageFilter;
    setStorageKind: (storageKind: SessionStorageKind) => void;
}> {
    const directSessionsDecision = useFeatureDecision('sessions.direct');
    const directSessionsEnabled = directSessionsDecision?.state === 'enabled';
    const [sessionsListStorageTab, setSessionsListStorageTab] = useLocalSettingMutable('sessionsListStorageTab');
    const storageKind = directSessionsEnabled && sessionsListStorageTab === 'direct' ? 'direct' : 'persisted';

    return {
        directSessionsEnabled,
        storageKind,
        storageFilter: directSessionsEnabled ? storageKind : 'persistedWithRetained',
        setStorageKind: setSessionsListStorageTab,
    };
}
