import { storage } from '../state/storageStore';

export function readSessionHandoffSessionActivity(sessionId: string): Readonly<{ active?: boolean }> | null {
    return storage.getState().sessions?.[sessionId] ?? null;
}
