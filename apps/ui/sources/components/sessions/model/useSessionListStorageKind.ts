import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import type { SessionStorageKind } from '@/sync/domains/session/sessionStorageKind';

export function useSessionListStorageKind(): Readonly<{
    externalSessionsEnabled: boolean;
    storageKind: SessionStorageKind;
    setStorageKind: (storageKind: SessionStorageKind) => void;
}> {
    const externalSessionsDecision = useFeatureDecision('sessions.direct');
    const externalSessionsEnabled = externalSessionsDecision?.state === 'enabled';
    const [sessionsListStorageTab, setSessionsListStorageTab] = useLocalSettingMutable('sessionsListStorageTab');

    return {
        externalSessionsEnabled,
        storageKind: externalSessionsEnabled && sessionsListStorageTab === 'direct' ? 'direct' : 'persisted',
        setStorageKind: setSessionsListStorageTab,
    };
}
