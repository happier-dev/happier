import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { SessionStorageKind } from '@/sync/domains/session/sessionStorageKind';

export function useSessionListStorageKind(): Readonly<{
    directSessionsEnabled: boolean;
    storageKind: SessionStorageKind;
    setStorageKind: (storageKind: SessionStorageKind) => void;
}> {
    const directSessionsDecision = useFeatureDecision('sessions.direct');
    const directSessionsEnabled = directSessionsDecision?.state === 'enabled';
    const [sessionsListStorageTab, setSessionsListStorageTab] = useLocalSettingMutable('sessionsListStorageTab');

    return {
        directSessionsEnabled,
        storageKind: directSessionsEnabled && sessionsListStorageTab === 'direct' ? 'direct' : 'persisted',
        setStorageKind: setSessionsListStorageTab,
    };
}
