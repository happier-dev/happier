import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { resolveServerIdForSessionIdFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';

export {
    resolveServerIdForSessionIdFromLocalState,
} from '@/sync/domains/session/resolveSessionAddressFromLocalState';

export function resolveServerIdForSessionIdFromLocalCache(sessionId: string): string | null {
    return resolveServerIdForSessionIdFromLocalState(readRegisteredStorageState(), sessionId);
}
