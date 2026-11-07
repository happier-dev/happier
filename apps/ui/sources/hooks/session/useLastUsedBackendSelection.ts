import { getStorage } from '@/sync/domains/state/storageStore';
import { useLastUsedBackendSelectionForScope } from '@/sync/domains/state/newSessionTargetUiState';

/** Only this Account/Home's device memory can invalidate a remembered selection consumer. */
export function useLastUsedBackendSelection(enabled = true) {
    const scope = getStorage()(state => state.settingsScope);
    return useLastUsedBackendSelectionForScope(scope, enabled);
}
